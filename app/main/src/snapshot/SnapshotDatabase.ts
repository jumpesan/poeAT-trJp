'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { Logger } from '../RemoteLogger'

const SNAPSHOT_DATABASE_DEBUG = false

type BetterSqliteDatabase = any

type NormalizedSnapshotItem = {
  source?: string
  locationKind?: string
  location?: {
    characterName?: string
    tabName?: string
    league?: string
    inventoryId?: string
    parentLocationKind?: string
  } | Record<string, unknown>
  id?: string
  itemKey?: string
  name?: string
  displayName?: string
  frameTypeId?: string
  identified?: boolean
  amount?: number
  raw?: {
    icon?: string
  }
}

export type SnapshotSaveInput = {
  snapshotAt?: string
  accountName?: string
  league?: string
  rawJsonPath: string
  normalizedItems?: NormalizedSnapshotItem[]
  goldAmount?: number | null
}

function formatLocalDateTimeMs(date: Date): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function toNullableText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function toNullableInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

export class SnapshotDatabase {
  private db: BetterSqliteDatabase | null = null
  private readonly logger?: Logger

  constructor(logger?: Logger) {
    this.logger = logger
  }

  get databasePath(): string {
    return path.join(app.getPath('userData'), 'snapshot', 'snapshot.sqlite')
  }

  private get itemValuesDatabasePath(): string {
    return path.join(app.getPath('userData'), 'itemValues', 'item_values.sqlite')
  }

  private get mapRunDatabasePath(): string {
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

  saveOwnedItemsSnapshot(input: SnapshotSaveInput): number {
    const db = this.open()
    const now = formatLocalDateTimeMs(new Date())
    const snapshotAt = this.toLocalDateTimeMs(input.snapshotAt) ?? now
    const normalizedItems = Array.isArray(input.normalizedItems) ? input.normalizedItems : []

    const save = db.transaction(() => {
      const headerResult = db.prepare(`
        INSERT INTO snapshot_headers (
          snapshot_at,
          account_name,
          league,
          raw_json_path,
          gold_amount,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        snapshotAt,
        toNullableText(input.accountName),
        input.league ?? '',
        input.rawJsonPath,
        toNullableInteger(input.goldAmount),
        now
      )

      const snapshotId = Number(headerResult.lastInsertRowid)
      const insertItem = db.prepare(`
        INSERT INTO snapshot_items (
          snapshot_id,
          item_id,
          item_key,
          source,
          location_kind,
          location_name,
          type,
          name,
          display_name,
          frame_type_id,
          identified,
          amount,
          icon
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      for (const item of normalizedItems) {
        const itemKey = item.itemKey
        if (!itemKey) continue

        const identity = this.resolveItemIdentity(itemKey)

        insertItem.run(
          snapshotId,
          toNullableText(item.id),
          itemKey,
          toNullableText(item.source),
          this.normalizeLocationKind(item),
          this.resolveLocationName(item),
          identity.type,
          identity.name,
          item.displayName ?? '',
          toNullableText(item.frameTypeId),
          item.identified === false ? 0 : 1,
          toNullableInteger(item.amount) ?? 1,
          toNullableText(item.raw?.icon)
        )
      }

      return snapshotId
    })

    const snapshotId = save()
    this.log(`saved snapshot id=${snapshotId} items=${normalizedItems.length}`)
    return snapshotId
  }


  getLatestSnapshotAt(): string | null {
    const db = this.open()
    const row = db.prepare(`
      SELECT snapshot_at
      FROM snapshot_headers
      ORDER BY snapshot_at DESC, snapshot_id DESC
      LIMIT 1
    `).get() as { snapshot_at?: string } | undefined

    return typeof row?.snapshot_at === 'string' ? row.snapshot_at : null
  }

  saveSnapshotValues(snapshotId: number): void {
    const db = this.open()
    const itemValuesPath = this.itemValuesDatabasePath
    if (!fs.existsSync(itemValuesPath)) {
      this.log(`skip snapshot values snapshot_id=${snapshotId}: item values db not found`)
      return
    }

    const valuedAt = formatLocalDateTimeMs(new Date())

    try {
      this.detachItemValues(db)
      db.prepare('ATTACH DATABASE ? AS item_values').run(itemValuesPath)

      const divineChaosRate = this.getDivineChaosRate(db)
      if (!divineChaosRate || divineChaosRate <= 0) {
        this.log(`skip snapshot values snapshot_id=${snapshotId}: divine chaos rate not found`)
        return
      }

      const priceFetchedAt = this.getLatestPriceFetchedAt(db)
      const saveValues = db.transaction(() => {
        db.prepare('DELETE FROM snapshot_value_items WHERE snapshot_id = ?').run(snapshotId)
        db.prepare('DELETE FROM snapshot_value_summaries WHERE snapshot_id = ?').run(snapshotId)

        db.prepare(`
          INSERT INTO snapshot_value_items (
            snapshot_id,
            location_kind,
            location_name,
            item_name,
            display_name,
            amount,
            unit_chaos_value,
            unit_divine_value,
            effective_divine_value,
            total_chaos_value,
            total_divine_value,
            price_ref_name,
            match_method,
            priced,
            price_fetched_at,
            valued_at
          )
          WITH latest_prices AS (
            SELECT
              ref_name,
              display_name,
              match_method,
              chaos_value,
              divine_value,
              fetched_at,
              ROW_NUMBER() OVER (
                PARTITION BY ref_name
                ORDER BY
                  MAX(
                    COALESCE(divine_value, 0),
                    COALESCE(chaos_value, 0) / ?
                  ) DESC,
                  fetched_at DESC,
                  cache_id DESC
              ) AS rn
            FROM item_values.poe_ninja_price_cache
            WHERE exchangeable = 1
              AND ref_name IS NOT NULL
              AND ref_name <> ''
          )
          SELECT
            s.snapshot_id,
            COALESCE(s.location_kind, '') AS location_kind,
            COALESCE(s.location_name, '') AS location_name,
            s.name AS item_name,
            COALESCE(p.display_name, s.display_name, s.name) AS display_name,
            COALESCE(s.amount, 1) AS amount,
            p.chaos_value AS unit_chaos_value,
            p.divine_value AS unit_divine_value,
            CASE
              WHEN p.ref_name IS NULL THEN NULL
              ELSE MAX(
                COALESCE(p.divine_value, 0),
                COALESCE(p.chaos_value, 0) / ?
              )
            END AS effective_divine_value,
            CASE
              WHEN p.ref_name IS NULL THEN NULL
              WHEN p.chaos_value IS NOT NULL THEN p.chaos_value * COALESCE(s.amount, 1)
              ELSE MAX(
                COALESCE(p.divine_value, 0),
                COALESCE(p.chaos_value, 0) / ?
              ) * ? * COALESCE(s.amount, 1)
            END AS total_chaos_value,
            CASE
              WHEN p.ref_name IS NULL THEN NULL
              ELSE MAX(
                COALESCE(p.divine_value, 0),
                COALESCE(p.chaos_value, 0) / ?
              ) * COALESCE(s.amount, 1)
            END AS total_divine_value,
            p.ref_name AS price_ref_name,
            p.match_method AS match_method,
            CASE WHEN p.ref_name IS NULL THEN 0 ELSE 1 END AS priced,
            COALESCE(p.fetched_at, ?) AS price_fetched_at,
            ? AS valued_at
          FROM snapshot_items s
          LEFT JOIN latest_prices p
            ON p.ref_name = s.name
           AND p.rn = 1
          WHERE s.snapshot_id = ?
        `).run(
          divineChaosRate,
          divineChaosRate,
          divineChaosRate,
          divineChaosRate,
          divineChaosRate,
          priceFetchedAt,
          valuedAt,
          snapshotId
        )

        db.prepare(`
          INSERT INTO snapshot_value_summaries (
            snapshot_id,
            location_kind,
            location_name,
            total_chaos_value,
            total_divine_value,
            priced_item_count,
            unpriced_item_count,
            price_fetched_at,
            created_at
          )
          SELECT
            snapshot_id,
            location_kind,
            location_name,
            COALESCE(SUM(total_chaos_value), 0) AS total_chaos_value,
            COALESCE(SUM(total_divine_value), 0) AS total_divine_value,
            SUM(CASE WHEN priced = 1 THEN 1 ELSE 0 END) AS priced_item_count,
            SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END) AS unpriced_item_count,
            MAX(price_fetched_at) AS price_fetched_at,
            ? AS created_at
          FROM snapshot_value_items
          WHERE snapshot_id = ?
          GROUP BY snapshot_id, location_kind, location_name
        `).run(valuedAt, snapshotId)
      })

      saveValues()
      this.log(`saved snapshot values snapshot_id=${snapshotId}`)
    } finally {
      this.detachItemValues(db)
    }
  }


  getSnapshotValueOverview(limit = 20): {
    snapshots: Array<{
      snapshot_id: number,
      snapshot_at: string,
      previous_snapshot_id: number | null,
      delta_chaos_value: number | null,
      delta_divine_value: number | null,
      gold_amount: number | null,
      delta_gold_amount: number | null,
      map_count: number | null
    }>,
    summaries: Array<{
      snapshot_id: number,
      location_kind: string,
      location_name: string,
      total_chaos_value: number,
      total_divine_value: number,
      delta_chaos_value: number | null,
      delta_divine_value: number | null,
      priced_item_count: number,
      price_fetched_at: string | null
    }>
  } {
    const db = this.open()
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))

    const baseSnapshots = db.prepare(`
      SELECT
        h.snapshot_id,
        h.snapshot_at,
        h.gold_amount
      FROM snapshot_headers h
      WHERE EXISTS (
        SELECT 1
        FROM snapshot_value_summaries s
        WHERE s.snapshot_id = h.snapshot_id
          AND s.priced_item_count > 0
      )
      ORDER BY h.snapshot_at DESC, h.snapshot_id DESC
      LIMIT ?
    `).all(safeLimit) as Array<{ snapshot_id: number, snapshot_at: string, gold_amount: number | null }>

    if (baseSnapshots.length === 0) {
      return { snapshots: [], summaries: [] }
    }

    const previousSnapshotStmt = db.prepare(`
      SELECT h.snapshot_id
      FROM snapshot_headers h
      WHERE EXISTS (
        SELECT 1
        FROM snapshot_value_summaries s
        WHERE s.snapshot_id = h.snapshot_id
          AND s.priced_item_count > 0
      )
        AND (
          h.snapshot_at < ?
          OR (h.snapshot_at = ? AND h.snapshot_id < ?)
        )
      ORDER BY h.snapshot_at DESC, h.snapshot_id DESC
      LIMIT 1
    `)

    const previousSnapshotIds = new Map<number, number | null>()
    for (const snapshot of baseSnapshots) {
      const row = previousSnapshotStmt.get(
        snapshot.snapshot_at,
        snapshot.snapshot_at,
        snapshot.snapshot_id
      ) as { snapshot_id?: number } | undefined
      previousSnapshotIds.set(
        snapshot.snapshot_id,
        typeof row?.snapshot_id === 'number' ? row.snapshot_id : null
      )
    }

    const relevantSnapshotIds = [
      ...new Set([
        ...baseSnapshots.map(snapshot => snapshot.snapshot_id),
        ...[...previousSnapshotIds.values()].filter((snapshotId): snapshotId is number => typeof snapshotId === 'number')
      ])
    ]
    const relevantPlaceholders = relevantSnapshotIds.map(() => '?').join(', ')
    const relevantSnapshotRows = db.prepare(`
      SELECT snapshot_id, snapshot_at, gold_amount
      FROM snapshot_headers
      WHERE snapshot_id IN (${relevantPlaceholders})
    `).all(...relevantSnapshotIds) as Array<{ snapshot_id: number, snapshot_at: string, gold_amount: number | null }>
    const snapshotInfoById = new Map(relevantSnapshotRows.map(snapshot => [snapshot.snapshot_id, snapshot]))

    const allSummaries = db.prepare(`
      SELECT
        snapshot_id,
        location_kind,
        location_name,
        total_chaos_value,
        total_divine_value,
        priced_item_count,
        price_fetched_at
      FROM snapshot_value_summaries
      WHERE priced_item_count > 0
        AND snapshot_id IN (${relevantPlaceholders})
    `).all(...relevantSnapshotIds) as Array<{
      snapshot_id: number,
      location_kind: string,
      location_name: string,
      total_chaos_value: number,
      total_divine_value: number,
      priced_item_count: number,
      price_fetched_at: string | null
    }>

    const summaryKey = (snapshotId: number, locationKind: string, locationName: string) => `${snapshotId} ${locationKind} ${locationName}`
    const summariesByKey = new Map<string, typeof allSummaries[number]>()
    for (const summary of allSummaries) {
      summariesByKey.set(summaryKey(summary.snapshot_id, summary.location_kind, summary.location_name), summary)
    }

    const totalBySnapshotId = new Map<number, { total_chaos_value: number, total_divine_value: number }>()
    for (const summary of allSummaries) {
      const total = totalBySnapshotId.get(summary.snapshot_id) ?? { total_chaos_value: 0, total_divine_value: 0 }
      total.total_chaos_value += summary.total_chaos_value
      total.total_divine_value += summary.total_divine_value
      totalBySnapshotId.set(summary.snapshot_id, total)
    }

    const mapCountsBySnapshotId = this.getMapCountsBetweenSnapshots(db, relevantSnapshotRows, previousSnapshotIds)

    const snapshots = baseSnapshots.map(snapshot => {
      const previousSnapshotId = previousSnapshotIds.get(snapshot.snapshot_id) ?? null
      const previousSnapshot = previousSnapshotId
        ? snapshotInfoById.get(previousSnapshotId)
        : null
      const currentTotal = totalBySnapshotId.get(snapshot.snapshot_id) ?? { total_chaos_value: 0, total_divine_value: 0 }
      const previousTotal = previousSnapshotId ? totalBySnapshotId.get(previousSnapshotId) : null
      return {
        snapshot_id: snapshot.snapshot_id,
        snapshot_at: snapshot.snapshot_at,
        previous_snapshot_id: previousSnapshotId,
        delta_chaos_value: previousTotal ? currentTotal.total_chaos_value - previousTotal.total_chaos_value : null,
        delta_divine_value: previousTotal ? currentTotal.total_divine_value - previousTotal.total_divine_value : null,
        gold_amount: snapshot.gold_amount ?? null,
        delta_gold_amount: previousSnapshot && typeof snapshot.gold_amount === 'number' && typeof previousSnapshot.gold_amount === 'number'
          ? snapshot.gold_amount - previousSnapshot.gold_amount
          : null,
        map_count: previousSnapshotId ? (mapCountsBySnapshotId.get(snapshot.snapshot_id) ?? 0) : null
      }
    })

    const baseSnapshotIdSet = new Set(baseSnapshots.map(snapshot => snapshot.snapshot_id))
    const summaries = allSummaries
      .filter(summary => baseSnapshotIdSet.has(summary.snapshot_id))
      .map(summary => {
        const previousSnapshotId = previousSnapshotIds.get(summary.snapshot_id) ?? null
        const previousSummary = previousSnapshotId
          ? summariesByKey.get(summaryKey(previousSnapshotId, summary.location_kind, summary.location_name))
          : null
        return {
          ...summary,
          delta_chaos_value: previousSummary ? summary.total_chaos_value - previousSummary.total_chaos_value : null,
          delta_divine_value: previousSummary ? summary.total_divine_value - previousSummary.total_divine_value : null
        }
      })
      .sort((a, b) => {
        if (a.snapshot_id !== b.snapshot_id) return b.snapshot_id - a.snapshot_id
        if (b.total_divine_value !== a.total_divine_value) return b.total_divine_value - a.total_divine_value
        return `${a.location_kind}/${a.location_name}`.localeCompare(`${b.location_kind}/${b.location_name}`)
      })

    return { snapshots, summaries }
  }


  getSnapshotValueComparison(firstSnapshotId: number, secondSnapshotId: number): {
    olderSnapshot: { snapshot_id: number, snapshot_at: string } | null,
    newerSnapshot: { snapshot_id: number, snapshot_at: string } | null,
    summaries: Array<{
      location_kind: string,
      location_name: string,
      older_total_divine_value: number,
      newer_total_divine_value: number,
      delta_divine_value: number,
      older_total_chaos_value: number,
      newer_total_chaos_value: number,
      delta_chaos_value: number,
      older_priced_item_count: number,
      newer_priced_item_count: number
    }>
  } {
    const db = this.open()
    const ids = [Math.trunc(firstSnapshotId), Math.trunc(secondSnapshotId)]
      .filter(id => Number.isFinite(id) && id > 0)

    if (ids.length !== 2 || ids[0] === ids[1]) {
      return { olderSnapshot: null, newerSnapshot: null, summaries: [] }
    }

    const snapshots = db.prepare(`
      SELECT snapshot_id, snapshot_at
      FROM snapshot_headers
      WHERE snapshot_id IN (?, ?)
      ORDER BY snapshot_at ASC, snapshot_id ASC
    `).all(ids[0], ids[1]) as Array<{ snapshot_id: number, snapshot_at: string }>

    if (snapshots.length !== 2) {
      return { olderSnapshot: snapshots[0] ?? null, newerSnapshot: snapshots[1] ?? null, summaries: [] }
    }

    const olderSnapshot = snapshots[0]
    const newerSnapshot = snapshots[1]

    const summaries = db.prepare(`
      WITH older AS (
        SELECT *
        FROM snapshot_value_summaries
        WHERE snapshot_id = ?
          AND priced_item_count > 0
      ),
      newer AS (
        SELECT *
        FROM snapshot_value_summaries
        WHERE snapshot_id = ?
          AND priced_item_count > 0
      )
      SELECT
        newer.location_kind,
        newer.location_name,
        older.total_divine_value AS older_total_divine_value,
        newer.total_divine_value AS newer_total_divine_value,
        newer.total_divine_value - older.total_divine_value AS delta_divine_value,
        older.total_chaos_value AS older_total_chaos_value,
        newer.total_chaos_value AS newer_total_chaos_value,
        newer.total_chaos_value - older.total_chaos_value AS delta_chaos_value,
        older.priced_item_count AS older_priced_item_count,
        newer.priced_item_count AS newer_priced_item_count
      FROM newer
      INNER JOIN older
        ON older.location_kind = newer.location_kind
       AND older.location_name = newer.location_name
      WHERE ABS(newer.total_divine_value - older.total_divine_value) >= 0.005
      ORDER BY ABS(newer.total_divine_value - older.total_divine_value) DESC, newer.location_kind, newer.location_name
    `).all(olderSnapshot.snapshot_id, newerSnapshot.snapshot_id) as Array<{
      location_kind: string,
      location_name: string,
      older_total_divine_value: number,
      newer_total_divine_value: number,
      delta_divine_value: number,
      older_total_chaos_value: number,
      newer_total_chaos_value: number,
      delta_chaos_value: number,
      older_priced_item_count: number,
      newer_priced_item_count: number
    }>

    return { olderSnapshot, newerSnapshot, summaries }
  }

  deleteSnapshot(snapshotId: number): boolean {
    if (!Number.isFinite(snapshotId)) return false

    const db = this.open()
    const deleteSnapshot = db.transaction(() => {
      const existing = db.prepare(`
        SELECT snapshot_id
        FROM snapshot_headers
        WHERE snapshot_id = ?
      `).get(snapshotId) as { snapshot_id?: number } | undefined

      if (!existing) return false

      // Delete child rows explicitly to keep the behavior stable even when an
      // existing user database was created before foreign keys were enabled.
      db.prepare('DELETE FROM snapshot_value_summaries WHERE snapshot_id = ?').run(snapshotId)
      db.prepare('DELETE FROM snapshot_value_items WHERE snapshot_id = ?').run(snapshotId)
      db.prepare('DELETE FROM snapshot_items WHERE snapshot_id = ?').run(snapshotId)
      db.prepare('DELETE FROM snapshot_headers WHERE snapshot_id = ?').run(snapshotId)
      return true
    })

    return deleteSnapshot()
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
    })
    migration()
  }

  private applyMigration1(db: BetterSqliteDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS snapshot_headers (
        snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_at TEXT NOT NULL,
        account_name TEXT,
        league TEXT NOT NULL,
        raw_json_path TEXT NOT NULL,
        gold_amount INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshot_items (
        snapshot_id INTEGER NOT NULL,
        item_id TEXT,
        item_key TEXT NOT NULL,
        source TEXT,
        location_kind TEXT,
        location_name TEXT,
        type TEXT,
        name TEXT,
        display_name TEXT,
        frame_type_id TEXT,
        identified INTEGER,
        amount INTEGER,
        icon TEXT,
        FOREIGN KEY(snapshot_id) REFERENCES snapshot_headers(snapshot_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_snapshot_headers_snapshot_at
        ON snapshot_headers(snapshot_at);

      CREATE INDEX IF NOT EXISTS idx_snapshot_items_snapshot_id
        ON snapshot_items(snapshot_id);

      CREATE INDEX IF NOT EXISTS idx_snapshot_items_item_key
        ON snapshot_items(item_key);

      CREATE INDEX IF NOT EXISTS idx_snapshot_items_snapshot_name
        ON snapshot_items(snapshot_id, name);

      CREATE INDEX IF NOT EXISTS idx_snapshot_items_snapshot_location
        ON snapshot_items(snapshot_id, location_kind, location_name);
    `)

    this.ensureColumn(db, 'snapshot_headers', 'gold_amount', 'INTEGER')

    db.prepare(`
      INSERT OR REPLACE INTO schema_migrations (version, applied_at)
      VALUES (?, ?)
    `).run(1, new Date().toISOString())

    this.log('migration 1 ensured snapshot tables')
  }

  private applyMigration2(db: BetterSqliteDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS snapshot_value_items (
        snapshot_id INTEGER NOT NULL,
        location_kind TEXT NOT NULL,
        location_name TEXT NOT NULL,
        item_name TEXT NOT NULL,
        display_name TEXT,
        amount INTEGER NOT NULL,
        unit_chaos_value REAL,
        unit_divine_value REAL,
        effective_divine_value REAL,
        total_chaos_value REAL,
        total_divine_value REAL,
        price_ref_name TEXT,
        match_method TEXT,
        priced INTEGER NOT NULL DEFAULT 0,
        price_fetched_at TEXT,
        valued_at TEXT NOT NULL,
        FOREIGN KEY(snapshot_id) REFERENCES snapshot_headers(snapshot_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS snapshot_value_summaries (
        snapshot_id INTEGER NOT NULL,
        location_kind TEXT NOT NULL,
        location_name TEXT NOT NULL,
        total_chaos_value REAL NOT NULL DEFAULT 0,
        total_divine_value REAL NOT NULL DEFAULT 0,
        priced_item_count INTEGER NOT NULL DEFAULT 0,
        unpriced_item_count INTEGER NOT NULL DEFAULT 0,
        price_fetched_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(snapshot_id, location_kind, location_name),
        FOREIGN KEY(snapshot_id) REFERENCES snapshot_headers(snapshot_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_snapshot_value_items_snapshot_id
        ON snapshot_value_items(snapshot_id);

      CREATE INDEX IF NOT EXISTS idx_snapshot_value_items_snapshot_location
        ON snapshot_value_items(snapshot_id, location_kind, location_name);

      CREATE INDEX IF NOT EXISTS idx_snapshot_value_items_price_ref_name
        ON snapshot_value_items(price_ref_name);

      CREATE INDEX IF NOT EXISTS idx_snapshot_value_items_priced
        ON snapshot_value_items(snapshot_id, priced);

      CREATE INDEX IF NOT EXISTS idx_snapshot_value_summaries_snapshot_id
        ON snapshot_value_summaries(snapshot_id);

      CREATE INDEX IF NOT EXISTS idx_snapshot_value_summaries_location
        ON snapshot_value_summaries(location_kind, location_name);
    `)

    db.prepare(`
      INSERT OR REPLACE INTO schema_migrations (version, applied_at)
      VALUES (?, ?)
    `).run(2, new Date().toISOString())

    this.log('migration 2 ensured snapshot value tables')
  }

  private getMapCountsBetweenSnapshots(
    db: BetterSqliteDatabase,
    snapshots: Array<{ snapshot_id: number, snapshot_at: string }>,
    previousSnapshotIds: Map<number, number | null>
  ): Map<number, number> {
    const result = new Map<number, number>()
    const mapRunPath = this.mapRunDatabasePath
    if (!fs.existsSync(mapRunPath)) return result

    try {
      this.detachMapRun(db)
      db.prepare('ATTACH DATABASE ? AS map_run').run(mapRunPath)

      const countStmt = db.prepare(`
        SELECT COUNT(DISTINCT seed) AS map_count
        FROM map_run.map_runs
        WHERE seed IS NOT NULL
          AND entered_at > ?
          AND entered_at <= ?
      `)

      const snapshotsById = new Map(snapshots.map(snapshot => [snapshot.snapshot_id, snapshot]))
      for (const snapshot of snapshots) {
        const previousSnapshotId = previousSnapshotIds.get(snapshot.snapshot_id) ?? null
        const previousSnapshot = previousSnapshotId ? snapshotsById.get(previousSnapshotId) : null
        if (!previousSnapshot) continue

        const row = countStmt.get(previousSnapshot.snapshot_at, snapshot.snapshot_at) as { map_count?: number } | undefined
        result.set(snapshot.snapshot_id, typeof row?.map_count === 'number' ? row.map_count : 0)
      }
    } catch (error) {
      this.log(`skip map count overview: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.detachMapRun(db)
    }

    return result
  }

  private ensureColumn(db: BetterSqliteDatabase, tableName: string, columnName: string, columnDefinition: string): void {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>
    if (columns.some(column => column.name === columnName)) return
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`)
  }

  private detachMapRun(db: BetterSqliteDatabase): void {
    try {
      db.exec('DETACH DATABASE map_run')
    } catch {
      // Ignore when map_run is not attached.
    }
  }

  private detachItemValues(db: BetterSqliteDatabase): void {
    try {
      db.exec('DETACH DATABASE item_values')
    } catch {
      // Ignore when item_values is not attached.
    }
  }

  private getDivineChaosRate(db: BetterSqliteDatabase): number | null {
    const row = db.prepare(`
      SELECT chaos_value
      FROM item_values.poe_ninja_price_cache
      WHERE ref_name = 'Divine Orb'
        AND chaos_value IS NOT NULL
      ORDER BY fetched_at DESC, cache_id DESC
      LIMIT 1
    `).get() as { chaos_value?: number } | undefined

    return typeof row?.chaos_value === 'number' && Number.isFinite(row.chaos_value)
      ? row.chaos_value
      : null
  }

  private getLatestPriceFetchedAt(db: BetterSqliteDatabase): string | null {
    const row = db.prepare(`
      SELECT MAX(fetched_at) AS fetched_at
      FROM item_values.poe_ninja_fetch_history
      WHERE status = 'success'
    `).get() as { fetched_at?: string | null } | undefined

    if (typeof row?.fetched_at === 'string' && row.fetched_at.length > 0) {
      return row.fetched_at
    }

    const cacheRow = db.prepare(`
      SELECT MAX(fetched_at) AS fetched_at
      FROM item_values.poe_ninja_price_cache
    `).get() as { fetched_at?: string | null } | undefined

    return typeof cacheRow?.fetched_at === 'string' && cacheRow.fetched_at.length > 0
      ? cacheRow.fetched_at
      : null
  }

  private resolveItemIdentity(itemKey: string): { type: string, name: string } {
    const parts = itemKey.split('|')
    const kind = parts[0]

    if (kind === 'stack') {
      return {
        type: parts[2] ?? '',
        name: parts[1] ?? ''
      }
    }

    return {
      type: parts[1] ?? '',
      name: parts[2] ?? ''
    }
  }

  private toLocalDateTimeMs(value: string | undefined): string | undefined {
    if (!value) return undefined

    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return undefined

    return formatLocalDateTimeMs(date)
  }

  private normalizeLocationKind(item: NormalizedSnapshotItem): string | null {
    const source = item.source
    const locationKind = item.locationKind

    if (source === 'stash' || locationKind === 'stash') return 'stash'
    if (locationKind === 'equipment' || locationKind === 'socketed') return 'equip'
    if (locationKind === 'inventory') return 'inventory'

    return toNullableText(locationKind) ?? toNullableText(source)
  }

  private resolveLocationName(item: NormalizedSnapshotItem): string | null {
    const location = item.location
    if (!location || typeof location !== 'object') return null

    if (item.source === 'stash' || item.locationKind === 'stash') {
      return toNullableText((location as { tabName?: unknown }).tabName)
    }

    return toNullableText((location as { characterName?: unknown }).characterName)
  }

  private log(message: string): void {
    if (!SNAPSHOT_DATABASE_DEBUG) return
    const line = `[SnapshotDatabase] ${message}`
    console.log(line)
    this.logger?.write(`info ${line}`)
  }
}
