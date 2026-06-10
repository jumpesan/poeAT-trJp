'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { Logger } from '../RemoteLogger'

const MAP_RUN_DATABASE_DEBUG = false

function formatLocalDateTimeMs(date: Date): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

type BetterSqliteDatabase = any

export type MapRunEnterInput = {
  seed: number
  areaId: string
  areaLevel: number
}

export type MapRunDisplayNameInput = {
  seed: number
  mapDisplayName: string
}


export type MapRunRecentRun = {
  id: number
  seed: number
  areaId: string
  areaLevel: number
  mapDisplayName: string | null
  enteredAt: string
  exitedAt: string | null
  mapTimeMs: number
}

export type MapRunStats = {
  areaId: string
  areaLevel: number
  mapDisplayName: string | null
  averageTimeMs: number | null
  bestTimeMs: number | null
  recentRuns: MapRunRecentRun[]
}

export type MapRunStatsInput = {
  areaId: string
  areaLevel: number
  recentRunsLimit: number
}

export class MapRunDatabase {
  private db: BetterSqliteDatabase | null = null
  private readonly logger?: Logger

  constructor(logger?: Logger) {
    this.logger = logger
  }

  get databasePath(): string {
    return path.join(app.getPath('userData'), 'map-run', 'map_runs.sqlite')
  }

  open(): BetterSqliteDatabase {
    if (this.db) return this.db

    const dbPath = this.databasePath
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })

    // Keep this lazy require. better-sqlite3 is a native module and must stay
    // external in build/script.mjs so Electron can load the rebuilt .node file.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3')
    const db = new Database(dbPath)

    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    this.migrate(db)

    this.db = db
    this.log(`opened ${dbPath}`)
    return db
  }

  close(): void {
    if (!this.db) return
    this.db.close()
    this.db = null
  }

  recordMapEnter(input: MapRunEnterInput): void {
    this.log(`record map enter seed=${input.seed} area=${input.areaId} level=${input.areaLevel}`)
    const db = this.open()
    const now = formatLocalDateTimeMs(new Date())
    db.prepare(`
      INSERT INTO map_runs (
        seed,
        area_id,
        area_level,
        entered_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(seed) DO UPDATE SET
        area_id = excluded.area_id,
        area_level = excluded.area_level,
        updated_at = excluded.updated_at
    `).run(input.seed, input.areaId, input.areaLevel, now, now)
  }


  updateMapDisplayName(input: MapRunDisplayNameInput): void {
    const mapDisplayName = input.mapDisplayName.trim()
    if (!mapDisplayName || mapDisplayName === '(null)') return

    this.log(`update map display name seed=${input.seed} name=${mapDisplayName}`)
    const db = this.open()
    const now = formatLocalDateTimeMs(new Date())
    db.prepare(`
      UPDATE map_runs
      SET
        map_display_name = ?,
        updated_at = ?
      WHERE seed = ?
    `).run(mapDisplayName, now, input.seed)
  }


  getStats(input: MapRunStatsInput): MapRunStats {
    const db = this.open()
    const limit = Math.max(0, Math.min(100, Math.floor(input.recentRunsLimit)))
    const aggregate = db.prepare(`
      SELECT
        AVG(map_time_ms) AS average_time_ms,
        MIN(map_time_ms) AS best_time_ms
      FROM map_runs
      WHERE area_id = ?
        AND area_level = ?
        AND map_time_ms IS NOT NULL
    `).get(input.areaId, input.areaLevel) as { average_time_ms: number | null, best_time_ms: number | null }

    const displayNameRow = db.prepare(`
      SELECT map_display_name
      FROM map_runs
      WHERE area_id = ?
        AND area_level = ?
        AND map_display_name IS NOT NULL
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(input.areaId, input.areaLevel) as { map_display_name: string | null } | undefined

    const recentRows = limit > 0
      ? db.prepare(`
        SELECT
          id,
          seed,
          area_id,
          area_level,
          map_display_name,
          entered_at,
          exited_at,
          map_time_ms
        FROM map_runs
        WHERE area_id = ?
          AND area_level = ?
          AND map_time_ms IS NOT NULL
        ORDER BY COALESCE(exited_at, updated_at) DESC, id DESC
        LIMIT ?
      `).all(input.areaId, input.areaLevel, limit) as Array<{
        id: number
        seed: number
        area_id: string
        area_level: number
        map_display_name: string | null
        entered_at: string
        exited_at: string | null
        map_time_ms: number
      }>
      : []

    return {
      areaId: input.areaId,
      areaLevel: input.areaLevel,
      mapDisplayName: displayNameRow?.map_display_name ?? null,
      averageTimeMs: aggregate.average_time_ms == null ? null : Math.round(aggregate.average_time_ms),
      bestTimeMs: aggregate.best_time_ms == null ? null : Math.round(aggregate.best_time_ms),
      recentRuns: recentRows.map(row => ({
        id: row.id,
        seed: row.seed,
        areaId: row.area_id,
        areaLevel: row.area_level,
        mapDisplayName: row.map_display_name,
        enteredAt: row.entered_at,
        exitedAt: row.exited_at,
        mapTimeMs: row.map_time_ms,
      }))
    }
  }

  touchLatestMapRun(): void {
    this.log('touch latest map run')
    this.finalizeLatestMapRun({ endWithCurrentTime: true })
  }

  finalizeLatestMapRun(options: { endWithCurrentTime: boolean }): void {
    this.log(`finalize latest map run endWithCurrentTime=${options.endWithCurrentTime}`)
    const db = this.open()

    if (options.endWithCurrentTime) {
      const now = formatLocalDateTimeMs(new Date())
      db.prepare(`
        UPDATE map_runs
        SET
          exited_at = ?,
          map_time_ms = CAST((julianday(?) - julianday(entered_at)) * 86400000 AS INTEGER),
          updated_at = ?
        WHERE id = (
          SELECT id
          FROM map_runs
          ORDER BY updated_at DESC
          LIMIT 1
        )
      `).run(now, now, now)
      return
    }

    db.prepare(`
      UPDATE map_runs
      SET
        exited_at = COALESCE(exited_at, updated_at),
        map_time_ms = CAST((julianday(updated_at) - julianday(entered_at)) * 86400000 AS INTEGER)
      WHERE id = (
        SELECT id
        FROM map_runs
        WHERE exited_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1
      )
    `).run()
  }

  deleteRun(runId: number): boolean {
    if (!Number.isFinite(runId)) return false

    const result = this.open().prepare(`
      DELETE FROM map_runs
      WHERE id = ?
    `).run(Math.trunc(runId))

    return result.changes > 0
  }

  resetActiveState(): void {
    // DB state is intentionally left as-is. Runtime active seed is managed by
    // MapRunService and is cleared when Client.txt is lost or watcher restarts.
  }

  private migrate(db: BetterSqliteDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `)

    const migration = db.transaction(() => {
      this.applyMigration1(db)
      this.applyMigration2(db)
      this.applyMigration3(db)
    })
    migration()
  }

  private applyMigration1(db: BetterSqliteDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS map_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seed INTEGER NOT NULL UNIQUE,
        area_id TEXT NOT NULL,
        area_level INTEGER,
        map_display_name TEXT,
        entered_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        exited_at TEXT,
        map_time_ms INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_map_runs_updated_at
        ON map_runs(updated_at);

      CREATE INDEX IF NOT EXISTS idx_map_runs_entered_at_seed
        ON map_runs(entered_at, seed);
    `)

    db.prepare(`
      INSERT OR REPLACE INTO schema_migrations (version, applied_at)
      VALUES (?, ?)
    `).run(1, new Date().toISOString())

    this.log('migration 1 ensured map_runs')
  }

  private applyMigration2(db: BetterSqliteDatabase): void {
    db.prepare(`
      INSERT OR REPLACE INTO schema_migrations (version, applied_at)
      VALUES (?, ?)
    `).run(2, new Date().toISOString())
  }

  private applyMigration3(db: BetterSqliteDatabase): void {
    const columns = db.prepare(`PRAGMA table_info(map_runs)`).all() as Array<{ name: string }>
    const hasMapDisplayName = columns.some(column => column.name === 'map_display_name')
    if (!hasMapDisplayName) {
      db.exec(`ALTER TABLE map_runs ADD COLUMN map_display_name TEXT`)
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_map_runs_display_name
        ON map_runs(map_display_name);
    `)

    db.prepare(`
      INSERT OR REPLACE INTO schema_migrations (version, applied_at)
      VALUES (?, ?)
    `).run(3, new Date().toISOString())

    this.log('migration 3 ensured map_display_name')
  }

  private log(message: string): void {
    if (!MAP_RUN_DATABASE_DEBUG) return
    const line = `[MapRunDatabase] ${message}`
    console.log(line)
    this.logger?.write(`info ${line}`)
  }
}
