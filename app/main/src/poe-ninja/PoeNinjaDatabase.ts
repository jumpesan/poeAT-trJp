'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { Logger } from '../RemoteLogger'

const POE_NINJA_DATABASE_DEBUG = false

type BetterSqliteDatabase = any

export type PoeNinjaTypeCandidate = {
  type: string
}

export type PoeNinjaTypeDiscoveryState = {
  typeCount: number
  latestDiscoveredAt: string | null
}

export type PoeNinjaTypeForValueRefresh = {
  type: string
  family: 'exchange' | 'stash' | 'empty' | 'error' | null
  enabled: number
}

export type PoeNinjaPriceCacheRow = {
  league: string
  type: string
  family: 'exchange' | 'item'
  poeNinjaId: string | null
  name: string | null
  baseType: string | null
  category: string | null
  detailsId: string | null
  icon: string | null
  chaosValue: number | null
  divineValue: number | null
  count: number | null
  listingCount: number | null
  refName: string | null
  displayName: string | null
  matchMethod: string | null
  exchangeable: number
  rawJson: string
  fetchedAt: string
}

export type PoeNinjaFetchHistoryRow = {
  league: string
  status: 'success' | 'failed'
  fetchedAt: string
  typeCount: number
  refreshedTypeCount: number
  cachedRowCount: number
  error: string | null
}

function formatLocalDateTimeMs(date: Date): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

export class PoeNinjaDatabase {
  private db: BetterSqliteDatabase | null = null
  private readonly logger?: Logger

  constructor(logger?: Logger) {
    this.logger = logger
  }

  get databasePath(): string {
    return path.join(app.getPath('userData'), 'itemValues', 'item_values.sqlite')
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

  getTypeDiscoveryState(): PoeNinjaTypeDiscoveryState {
    const db = this.open()
    const row = db.prepare(`
      SELECT
        COUNT(*) AS type_count,
        MAX(discovered_at) AS latest_discovered_at
      FROM item_type_master
    `).get() as { type_count: number, latest_discovered_at: string | null }

    return {
      typeCount: row.type_count,
      latestDiscoveredAt: row.latest_discovered_at,
    }
  }

  upsertItemTypes(types: PoeNinjaTypeCandidate[]): void {
    if (types.length === 0) return

    const db = this.open()
    const now = formatLocalDateTimeMs(new Date())
    const insert = db.prepare(`
      INSERT INTO item_type_master (
        type,
        discovered_at,
        updated_at
      )
      VALUES (?, ?, ?)
      ON CONFLICT(type) DO UPDATE SET
        discovered_at = excluded.discovered_at,
        updated_at = excluded.updated_at
    `)

    const transaction = db.transaction((rows: PoeNinjaTypeCandidate[]) => {
      for (const row of rows) {
        insert.run(row.type, now, now)
      }
    })
    transaction(types)

    this.log(`upserted ${types.length} item types`)
  }

  getTypesForValueRefresh(): PoeNinjaTypeForValueRefresh[] {
    const db = this.open()
    return db.prepare(`
      SELECT type, family, enabled
      FROM item_type_master
      ORDER BY type
    `).all() as PoeNinjaTypeForValueRefresh[]
  }

  updateItemTypeFamily(type: string, family: 'exchange' | 'stash' | 'empty' | 'error' | null, enabled: boolean, verifiedAt: string): void {
    const db = this.open()
    db.prepare(`
      UPDATE item_type_master
      SET family = ?,
          family_verified_at = ?,
          enabled = ?,
          updated_at = ?
      WHERE type = ?
    `).run(family, verifiedAt, enabled ? 1 : 0, verifiedAt, type)
  }

  replacePoeNinjaPriceCache(league: string, rows: PoeNinjaPriceCacheRow[]): void {
    const db = this.open()
    const deleteRows = db.prepare(`
      DELETE FROM poe_ninja_price_cache
      WHERE league = ?
    `)
    const insert = db.prepare(`
      INSERT INTO poe_ninja_price_cache (
        league,
        type,
        family,
        poe_ninja_id,
        name,
        base_type,
        category,
        details_id,
        icon,
        chaos_value,
        divine_value,
        count,
        listing_count,
        ref_name,
        display_name,
        match_method,
        exchangeable,
        raw_json,
        fetched_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const transaction = db.transaction((cacheRows: PoeNinjaPriceCacheRow[]) => {
      deleteRows.run(league)
      for (const row of cacheRows) {
        insert.run(
          row.league,
          row.type,
          row.family,
          row.poeNinjaId,
          row.name,
          row.baseType,
          row.category,
          row.detailsId,
          row.icon,
          row.chaosValue,
          row.divineValue,
          row.count,
          row.listingCount,
          row.refName,
          row.displayName,
          row.matchMethod,
          row.exchangeable,
          row.rawJson,
          row.fetchedAt
        )
      }
    })

    transaction(rows)
    this.log(`replaced ${rows.length} poe.ninja price cache rows for ${league}`)
  }

  insertPoeNinjaFetchHistory(row: PoeNinjaFetchHistoryRow): void {
    const db = this.open()
    db.prepare(`
      INSERT INTO poe_ninja_fetch_history (
        league,
        status,
        fetched_at,
        type_count,
        refreshed_type_count,
        cached_row_count,
        error
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.league,
      row.status,
      row.fetchedAt,
      row.typeCount,
      row.refreshedTypeCount,
      row.cachedRowCount,
      row.error
    )
  }

  getLastSuccessfulPoeNinjaFetchAt(): string | null {
    const db = this.open()
    const row = db.prepare(`
      SELECT MAX(fetched_at) AS fetched_at
      FROM poe_ninja_fetch_history
      WHERE status = 'success'
    `).get() as { fetched_at: string | null }

    return row.fetched_at
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
      this.applyMigration4(db)
      this.applyMigration5(db)
      this.applyMigration6(db)
    })
    migration()
  }

  private applyMigration1(db: BetterSqliteDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS item_type_master (
        type TEXT PRIMARY KEY,
        family TEXT,
        family_verified_at TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_item_type_master_enabled
        ON item_type_master(enabled);

      CREATE INDEX IF NOT EXISTS idx_item_type_master_family
        ON item_type_master(family);

      CREATE INDEX IF NOT EXISTS idx_item_type_master_discovered_at
        ON item_type_master(discovered_at);

      UPDATE item_type_master
      SET family = 'stash'
      WHERE family = 'item';
    `)

    db.prepare(`
      INSERT OR REPLACE INTO schema_migrations (version, applied_at)
      VALUES (?, ?)
    `).run(1, new Date().toISOString())

    this.log('migration 1 ensured item_type_master')
  }

  private applyMigration2(db: BetterSqliteDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS poe_ninja_price_cache (
        cache_id INTEGER PRIMARY KEY AUTOINCREMENT,
        league TEXT NOT NULL,
        type TEXT NOT NULL,
        family TEXT NOT NULL,
        poe_ninja_id TEXT,
        name TEXT,
        base_type TEXT,
        category TEXT,
        details_id TEXT,
        icon TEXT,
        chaos_value REAL,
        divine_value REAL,
        count INTEGER,
        listing_count INTEGER,
        ref_name TEXT,
        display_name TEXT,
        match_method TEXT,
        exchangeable INTEGER NOT NULL DEFAULT 0,
        graph1 REAL,
        graph2 REAL,
        graph3 REAL,
        graph4 REAL,
        graph5 REAL,
        graph6 REAL,
        graph7 REAL,
        raw_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_poe_ninja_price_cache_league_type
        ON poe_ninja_price_cache(league, type);

      CREATE INDEX IF NOT EXISTS idx_poe_ninja_price_cache_name
        ON poe_ninja_price_cache(name);

      CREATE INDEX IF NOT EXISTS idx_poe_ninja_price_cache_details_id
        ON poe_ninja_price_cache(details_id);

      CREATE INDEX IF NOT EXISTS idx_poe_ninja_price_cache_ref_name
        ON poe_ninja_price_cache(ref_name);

      CREATE INDEX IF NOT EXISTS idx_poe_ninja_price_cache_exchangeable
        ON poe_ninja_price_cache(exchangeable);

      CREATE TABLE IF NOT EXISTS poe_ninja_fetch_history (
        fetch_id INTEGER PRIMARY KEY AUTOINCREMENT,
        league TEXT NOT NULL,
        status TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        type_count INTEGER NOT NULL DEFAULT 0,
        refreshed_type_count INTEGER NOT NULL DEFAULT 0,
        cached_row_count INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_poe_ninja_fetch_history_status_time
        ON poe_ninja_fetch_history(status, fetched_at);
    `)

    db.prepare(`
      INSERT OR REPLACE INTO schema_migrations (version, applied_at)
      VALUES (?, ?)
    `).run(2, new Date().toISOString())

    this.log('migration 2 ensured poe_ninja_price_cache and fetch_history')
  }


  private applyMigration3(db: BetterSqliteDatabase): void {
    const columns = new Set(
      db.prepare(`PRAGMA table_info(poe_ninja_price_cache)`).all()
        .map((row: { name: string }) => row.name)
    )

    if (!columns.has('ref_name')) {
      db.exec(`ALTER TABLE poe_ninja_price_cache ADD COLUMN ref_name TEXT;`)
    }
    if (!columns.has('display_name')) {
      db.exec(`ALTER TABLE poe_ninja_price_cache ADD COLUMN display_name TEXT;`)
    }
    if (!columns.has('match_method')) {
      db.exec(`ALTER TABLE poe_ninja_price_cache ADD COLUMN match_method TEXT;`)
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_poe_ninja_price_cache_ref_name
        ON poe_ninja_price_cache(ref_name);
    `)

    db.prepare(`
      INSERT OR REPLACE INTO schema_migrations (version, applied_at)
      VALUES (?, ?)
    `).run(3, new Date().toISOString())

    this.log('migration 3 ensured poe_ninja_price_cache item references')
  }


  private applyMigration4(db: BetterSqliteDatabase): void {
    const columns = new Set(
      db.prepare(`PRAGMA table_info(poe_ninja_price_cache)`).all()
        .map((row: { name: string }) => row.name)
    )

    if (!columns.has('exchangeable')) {
      db.exec(`ALTER TABLE poe_ninja_price_cache ADD COLUMN exchangeable INTEGER NOT NULL DEFAULT 0;`)
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_poe_ninja_price_cache_exchangeable
        ON poe_ninja_price_cache(exchangeable);
    `)

    db.prepare(`
      INSERT OR REPLACE INTO schema_migrations (version, applied_at)
      VALUES (?, ?)
    `).run(4, new Date().toISOString())

    this.log('migration 4 ensured poe_ninja_price_cache exchangeable flag')
  }


  private applyMigration5(db: BetterSqliteDatabase): void {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_poe_ninja_price_cache_league_ref_exchangeable
        ON poe_ninja_price_cache(league, ref_name, exchangeable);

      CREATE INDEX IF NOT EXISTS idx_poe_ninja_price_cache_ref_exchangeable
        ON poe_ninja_price_cache(ref_name, exchangeable);
    `)

    db.prepare(`
      INSERT OR REPLACE INTO schema_migrations (version, applied_at)
      VALUES (?, ?)
    `).run(5, new Date().toISOString())

    this.log('migration 5 ensured price cache join indexes')
  }


  private applyMigration6(db: BetterSqliteDatabase): void {
    const columns = new Set(
      db.prepare(`PRAGMA table_info(poe_ninja_price_cache)`).all()
        .map((row: { name: string }) => row.name)
    )

    for (const columnName of ['graph1', 'graph2', 'graph3', 'graph4', 'graph5', 'graph6', 'graph7']) {
      if (!columns.has(columnName)) {
        db.exec(`ALTER TABLE poe_ninja_price_cache ADD COLUMN ${columnName} REAL;`)
      }
    }

    db.prepare(`
      INSERT OR REPLACE INTO schema_migrations (version, applied_at)
      VALUES (?, ?)
    `).run(6, new Date().toISOString())

    this.log('migration 6 ensured poe_ninja_price_cache graph columns')
  }

  private log(message: string): void {
    if (!POE_NINJA_DATABASE_DEBUG) return
    const line = `[PoeNinjaDatabase] ${message}`
    console.log(line)
    this.logger?.write(`info ${line}`)
  }
}
