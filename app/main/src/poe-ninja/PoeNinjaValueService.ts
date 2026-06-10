import * as https from 'node:https'
import type { Logger } from '../RemoteLogger'
import type { ServerEvents } from '../server'
import { PoeNinjaDatabase, type PoeNinjaPriceCacheRow, type PoeNinjaTypeForValueRefresh } from './PoeNinjaDatabase'

const POE_NINJA_BASE_URL = 'https://poe.ninja'
const REQUEST_TIMEOUT_MS = 20_000
const MANUAL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000
const AUTO_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000

type PoeNinjaFamily = 'exchange' | 'item'
type ItemTypeFamily = 'exchange' | 'stash' | 'empty' | 'error' | null

export type RefreshValuesResult = {
  ok: boolean
  status: 'success' | 'running' | 'cooldown' | 'skipped' | 'failed'
  league: string
  fetchedAt?: string
  cooldownUntil?: string | null
  typeCount?: number
  refreshedTypeCount?: number
  cachedRowCount?: number
  error?: string
}

type RefreshStatusResult = {
  ok: boolean
  running: boolean
  cooldownUntil: string | null
  lastSuccessfulFetchAt: string | null
}

type ApiResponse = {
  family: PoeNinjaFamily
  apiType: string
  body: any
  lines: any[]
}

type FetchTypeResult = {
  response: ApiResponse | null
  family: Exclude<ItemTypeFamily, null>
}

export type ItemDataRecord = {
  name: string
  refName: string
  namespace?: string
  tradeTag?: string
  exchangeable?: boolean
}

type ItemDataIndex = {
  records: ItemDataRecord[]
  byRefName: Map<string, ItemDataRecord[]>
  byTradeTag: Map<string, ItemDataRecord[]>
}

type ItemReference = {
  refName: string | null
  displayName: string | null
  matchMethod: string | null
  exchangeable: boolean
}

const SLUG_TO_API_TYPE: Record<string, string> = {
  'allflame-embers': 'AllflameEmber',
  artifacts: 'Artifact',
  astrolabes: 'Astrolabe',
  'base-types': 'BaseType',
  beasts: 'Beast',
  'blight-ravaged-maps': 'BlightRavagedMap',
  'blighted-maps': 'BlightedMap',
  'cluster-jewels': 'ClusterJewel',
  coffins: 'Coffin',
  currency: 'Currency',
  'delirium-orbs': 'DeliriumOrb',
  'divination-cards': 'DivinationCard',
  'djinn-coins': 'DjinnCoin',
  essences: 'Essence',
  'forbidden-jewels': 'ForbiddenJewel',
  fossils: 'Fossil',
  fragments: 'Fragment',
  'imbued-gems': 'ImbuedGem',
  incubators: 'Incubator',
  invitations: 'Invitation',
  'kalguuran-runes': 'KalguuranRune',
  maps: 'Map',
  memories: 'Memory',
  oils: 'Oil',
  omens: 'Omen',
  resonators: 'Resonator',
  runegrafts: 'Runegraft',
  scarabs: 'Scarab',
  'scourged-maps': 'ScourgedMap',
  'shrine-belts': 'ShrineBelt',
  'skill-gems': 'SkillGem',
  tattoos: 'Tattoo',
  temples: 'IncursionTemple',
  'unique-accessories': 'UniqueAccessory',
  'unique-armours': 'UniqueArmour',
  'unique-flasks': 'UniqueFlask',
  'unique-idols': 'UniqueIdol',
  'unique-jewels': 'UniqueJewel',
  'unique-maps': 'UniqueMap',
  'unique-relics': 'UniqueRelic',
  'unique-tinctures': 'UniqueTincture',
  'unique-weapons': 'UniqueWeapon',
  'valdo-maps': 'ValdoMap',
  vials: 'Vial',
  wombgifts: 'Wombgift'
}

export class PoeNinjaValueService {
  private isRefreshing = false
  private manualCooldownUntil = 0

  constructor (
    private readonly database: PoeNinjaDatabase,
    private readonly logger: Logger,
    private readonly server: ServerEvents
  ) {}

  registerEvents (): void {
    this.server.onEventAnyClient('CLIENT->MAIN::poe-ninja-refresh-values' as any, async (payload: any) => {
      const league = typeof payload?.league === 'string' ? payload.league : ''
      const itemDataRecords = Array.isArray(payload?.itemDataRecords) ? payload.itemDataRecords : []
      const result = await this.refreshValues(league, { manual: true, itemDataRecords })
      this.server.sendEventTo('last-active', {
        name: 'MAIN->CLIENT::poe-ninja-refresh-values-result' as any,
        payload: result
      } as any)
    })

    this.server.onEventAnyClient('CLIENT->MAIN::poe-ninja-price-status' as any, () => {
      this.server.sendEventTo('last-active', {
        name: 'MAIN->CLIENT::poe-ninja-price-status' as any,
        payload: this.getStatus()
      } as any)
    })
  }

  getStatus (): RefreshStatusResult {
    return {
      ok: true,
      running: this.isRefreshing,
      cooldownUntil: this.getCooldownUntilIso(),
      lastSuccessfulFetchAt: this.database.getLastSuccessfulPoeNinjaFetchAt()
    }
  }

  async maybeRefreshValues (league: string, opts: { itemDataRecords?: ItemDataRecord[] } = {}): Promise<RefreshValuesResult> {
    const trimmedLeague = league.trim()
    if (!trimmedLeague) {
      return {
        ok: false,
        status: 'failed',
        league: trimmedLeague,
        error: 'league is empty'
      }
    }

    const lastSuccessfulFetchAt = this.database.getLastSuccessfulPoeNinjaFetchAt()
    const lastSuccessfulFetchTime = parseLocalDateTimeMs(lastSuccessfulFetchAt)
    if (lastSuccessfulFetchTime !== null && Date.now() - lastSuccessfulFetchTime < AUTO_REFRESH_INTERVAL_MS) {
      return {
        ok: true,
        status: 'skipped',
        league: trimmedLeague,
        fetchedAt: lastSuccessfulFetchAt ?? undefined,
        cooldownUntil: this.getCooldownUntilIso()
      }
    }

    return this.refreshValues(trimmedLeague, {
      manual: false,
      itemDataRecords: opts.itemDataRecords
    })
  }

  async refreshValues (league: string, opts: { manual?: boolean, itemDataRecords?: ItemDataRecord[] } = {}): Promise<RefreshValuesResult> {
    const trimmedLeague = league.trim()
    if (!trimmedLeague) {
      return {
        ok: false,
        status: 'failed',
        league: trimmedLeague,
        error: 'league is empty'
      }
    }

    if (this.isRefreshing) {
      return {
        ok: false,
        status: 'running',
        league: trimmedLeague,
        cooldownUntil: this.getCooldownUntilIso()
      }
    }

    if (opts.manual && Date.now() < this.manualCooldownUntil) {
      return {
        ok: false,
        status: 'cooldown',
        league: trimmedLeague,
        cooldownUntil: this.getCooldownUntilIso()
      }
    }

    this.isRefreshing = true
    const fetchedAt = formatLocalDateTimeMs(new Date())
    let refreshedTypeCount = 0
    let cachedRowCount = 0
    let typeCount = 0

    try {
      const types = this.database.getTypesForValueRefresh()
      typeCount = types.length

      if (types.length === 0) {
        return {
          ok: true,
          status: 'skipped',
          league: trimmedLeague,
          fetchedAt,
          typeCount: 0,
          refreshedTypeCount: 0,
          cachedRowCount: 0
        }
      }

      const cacheRows: PoeNinjaPriceCacheRow[] = []
      const itemDataIndex = createItemDataIndex(opts.itemDataRecords ?? [])

      for (const type of types) {
        const fetchResult = await this.fetchType(trimmedLeague, type)
        const response = fetchResult.response
        if (!response) {
          this.database.updateItemTypeFamily(type.type, fetchResult.family, false, fetchedAt)
          continue
        }

        this.database.updateItemTypeFamily(type.type, response.family === 'exchange' ? 'exchange' : 'stash', true, fetchedAt)
        refreshedTypeCount += 1

        const rows = response.family === 'exchange'
          ? normalizeExchangeRows(trimmedLeague, type.type, response, fetchedAt, itemDataIndex)
          : normalizeItemRows(trimmedLeague, type.type, response, fetchedAt, itemDataIndex)

        cacheRows.push(...rows)
        cachedRowCount += rows.length
      }

      this.database.replacePoeNinjaPriceCache(trimmedLeague, cacheRows)
      this.database.insertPoeNinjaFetchHistory({
        league: trimmedLeague,
        status: 'success',
        fetchedAt,
        typeCount,
        refreshedTypeCount,
        cachedRowCount,
        error: null
      })

      if (opts.manual) this.manualCooldownUntil = Date.now() + MANUAL_REFRESH_COOLDOWN_MS

      return {
        ok: true,
        status: 'success',
        league: trimmedLeague,
        fetchedAt,
        cooldownUntil: this.getCooldownUntilIso(),
        typeCount,
        refreshedTypeCount,
        cachedRowCount
      }
    } catch (err) {
      const error = formatError(err)
      this.database.insertPoeNinjaFetchHistory({
        league: trimmedLeague,
        status: 'failed',
        fetchedAt,
        typeCount,
        refreshedTypeCount,
        cachedRowCount,
        error
      })
      if (opts.manual) this.manualCooldownUntil = Date.now() + MANUAL_REFRESH_COOLDOWN_MS
      this.logger.write(`warn [PoeNinjaValueService] price refresh failed: ${error}`)
      return {
        ok: false,
        status: 'failed',
        league: trimmedLeague,
        fetchedAt,
        cooldownUntil: this.getCooldownUntilIso(),
        typeCount,
        refreshedTypeCount,
        cachedRowCount,
        error
      }
    } finally {
      this.isRefreshing = false
    }
  }

  private async fetchType (league: string, type: PoeNinjaTypeForValueRefresh): Promise<FetchTypeResult> {
    const apiType = toPoeNinjaApiType(type.type)
    const preferredFamilies: PoeNinjaFamily[] = type.family === 'exchange'
      ? ['exchange']
      : type.family === 'stash'
        ? ['item']
        : ['exchange', 'item']

    const fallbackFamilies: PoeNinjaFamily[] = preferredFamilies.length === 1
      ? preferredFamilies[0] === 'exchange' ? ['item'] : ['exchange']
      : []

    let hadError = false
    let hadEmpty = false

    for (const family of [...preferredFamilies, ...fallbackFamilies]) {
      try {
        const body = await requestJson(buildApiUrl(family, league, apiType))
        const lines = Array.isArray(body?.lines) ? body.lines : []
        if (lines.length > 0) {
          return { response: { family, apiType, body, lines }, family: family === 'exchange' ? 'exchange' : 'stash' }
        }
        hadEmpty = true
      } catch (err) {
        hadError = true
        this.logger.write(`warn [PoeNinjaValueService] ${family} ${type.type} failed: ${formatError(err)}`)
      }
    }

    return { response: null, family: hadError ? 'error' : hadEmpty ? 'empty' : 'empty' }
  }

  private getCooldownUntilIso (): string | null {
    if (Date.now() >= this.manualCooldownUntil) return null
    return new Date(this.manualCooldownUntil).toISOString()
  }
}

function buildApiUrl (family: PoeNinjaFamily, league: string, apiType: string): string {
  const leagueParam = encodeURIComponent(league)
  const typeParam = encodeURIComponent(apiType)

  if (family === 'exchange') {
    return `${POE_NINJA_BASE_URL}/poe1/api/economy/exchange/current/overview?league=${leagueParam}&type=${typeParam}`
  }

  return `${POE_NINJA_BASE_URL}/poe1/api/economy/stash/current/item/overview?league=${leagueParam}&type=${typeParam}`
}

function toPoeNinjaApiType (slug: string): string {
  return SLUG_TO_API_TYPE[slug] ?? slug
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

function normalizeExchangeRows (
  league: string,
  type: string,
  response: ApiResponse,
  fetchedAt: string,
  itemDataIndex: ItemDataIndex
): PoeNinjaPriceCacheRow[] {
  const itemById = new Map<string, any>()
  const collectItems = (items: unknown): void => {
    if (Array.isArray(items)) {
      for (const value of items) {
        const id = toNullableString((value as any)?.id)
        if (id) itemById.set(id, value)
      }
      return
    }

    if (items && typeof items === 'object') {
      for (const [key, value] of Object.entries(items)) {
        const id = toNullableString((value as any)?.id ?? key)
        if (id) itemById.set(id, value)
      }
    }
  }

  collectItems(response.body?.core?.items)
  collectItems(response.body?.items)

  const divineRate = toNullableNumber(response.body?.core?.rates?.divine)

  return response.lines.map((line) => {
    const id = toNullableString(line?.id)
    const master = id ? itemById.get(id) : undefined
    const name = toNullableString(master?.name ?? line?.currencyTypeName ?? line?.id)
    const detailsId = toNullableString(master?.detailsId ?? line?.detailsId)
    const itemRef = resolveItemReference(type, name, null, detailsId, itemDataIndex)
    const chaosValue = toNullableNumber(line?.chaosEquivalent ?? line?.primaryValue)
    const image = toNullableString(master?.image)

    return {
      league,
      type,
      family: 'exchange' as const,
      poeNinjaId: id,
      name,
      baseType: null,
      category: toNullableString(master?.category),
      detailsId,
      icon: image ? normalizePoeNinjaImageUrl(image) : null,
      chaosValue,
      divineValue: chaosValue !== null && divineRate !== null ? chaosValue * divineRate : null,
      refName: itemRef.refName,
      displayName: itemRef.displayName,
      matchMethod: itemRef.matchMethod,
      exchangeable: itemRef.exchangeable ? 1 : 0,
      count: null,
      listingCount: null,
      rawJson: JSON.stringify(line),
      fetchedAt
    }
  })
}

function normalizeItemRows (
  league: string,
  type: string,
  response: ApiResponse,
  fetchedAt: string,
  itemDataIndex: ItemDataIndex
): PoeNinjaPriceCacheRow[] {
  return response.lines.map((line) => {
    const id = toNullableString(line?.id)
    const name = toNullableString(line?.name)
    const baseType = toNullableString(line?.baseType)
    const detailsId = toNullableString(line?.detailsId)
    const itemRef = resolveItemReference(type, name, baseType, detailsId, itemDataIndex)
    return {
      league,
      type,
      family: 'item' as const,
      poeNinjaId: id,
      name,
      baseType,
      category: toNullableString(line?.itemClass),
      detailsId,
      icon: toNullableString(line?.icon),
      chaosValue: toNullableNumber(line?.chaosValue),
      divineValue: toNullableNumber(line?.divineValue),
      count: toNullableNumber(line?.count),
      listingCount: toNullableNumber(line?.listingCount),
      refName: itemRef.refName,
      displayName: itemRef.displayName,
      matchMethod: itemRef.matchMethod,
      exchangeable: itemRef.exchangeable ? 1 : 0,
      rawJson: JSON.stringify(line),
      fetchedAt
    }
  })
}


function createItemDataIndex (sourceRecords: ItemDataRecord[]): ItemDataIndex {
  const records: ItemDataRecord[] = []
  const byRefName = new Map<string, ItemDataRecord[]>()
  const byTradeTag = new Map<string, ItemDataRecord[]>()

  for (const sourceRecord of sourceRecords) {
    const refName = toNullableString(sourceRecord?.refName)
    if (!refName) continue

    const record: ItemDataRecord = {
      name: toNullableString(sourceRecord?.name) ?? refName,
      refName,
      namespace: toNullableString(sourceRecord?.namespace) ?? undefined,
      tradeTag: toNullableString(sourceRecord?.tradeTag) ?? undefined,
      exchangeable: sourceRecord?.exchangeable === true
    }

    records.push(record)
    pushMapArray(byRefName, record.refName, record)
    if (record.tradeTag) pushMapArray(byTradeTag, record.tradeTag, record)
  }

  return { records, byRefName, byTradeTag }
}

function pushMapArray<K, V> (map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key)
  if (values) {
    values.push(value)
  } else {
    map.set(key, [value])
  }
}

function resolveItemReference (
  type: string,
  name: string | null,
  baseType: string | null,
  detailsId: string | null,
  index: ItemDataIndex
): ItemReference {
  if (!name) return { refName: null, displayName: null, matchMethod: null, exchangeable: false }

  const exact = first(index.byRefName.get(name))
  if (exact) return toItemReference(exact, 'exact_name')

  if (detailsId) {
    const byTradeTag = first(index.byTradeTag.get(detailsId))
    if (byTradeTag) return toItemReference(byTradeTag, 'details_id')
  }

  if (isMapType(type)) {
    const best = findLongestSuffixItem(normalizeMapLookupName(name), index.records, isMapCandidateRecord)
    if (best) return toItemReference(best, 'map_suffix_longest')
  }

  if (type === 'cluster-jewels' && baseType) {
    const clusterBase = first(index.byRefName.get(baseType))
    if (clusterBase) return toItemReference(clusterBase, 'normalized_special')
  }

  if (name.startsWith('Foulborn ')) {
    const normalizedName = name.slice('Foulborn '.length).trim()
    const normalized = first(index.byRefName.get(normalizedName))
    if (normalized) return toItemReference(normalized, 'normalized_special')
  }

  return { refName: null, displayName: null, matchMethod: 'unmatched', exchangeable: false }
}

function first<T> (values: T[] | undefined): T | null {
  return values && values.length > 0 ? values[0] : null
}

function toItemReference (record: ItemDataRecord, matchMethod: string): ItemReference {
  return {
    refName: record.refName,
    displayName: record.name ?? record.refName,
    matchMethod,
    exchangeable: record.exchangeable === true
  }
}

function isMapType (type: string): boolean {
  return ['maps', 'blighted-maps', 'blight-ravaged-maps', 'unique-maps'].includes(type)
}

function isMapCandidateRecord (record: ItemDataRecord): boolean {
  const refName = record.refName
  return refName === 'Map' || refName.endsWith(' Map')
}

function normalizeMapLookupName (name: string): string {
  return name.replace(/\s*\(Tier\s+\d+\)\s*$/u, '').trim()
}

function findLongestSuffixItem (
  name: string,
  records: ItemDataRecord[],
  predicate: (record: ItemDataRecord) => boolean
): ItemDataRecord | null {
  let best: ItemDataRecord | null = null
  for (const record of records) {
    if (!predicate(record)) continue
    if (!record.refName || !name.endsWith(record.refName)) continue
    if (!best || record.refName.length > best.refName.length) {
      best = record
    }
  }
  return best
}

function requestJson (url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'user-agent': 'poe-at-tr-jp/poe-ninja-value-refresh'
      }
    }, (res) => {
      const statusCode = res.statusCode ?? 0
      if (statusCode < 200 || statusCode >= 300) {
        res.resume()
        reject(new Error(`HTTP ${statusCode} ${url}`))
        return
      }

      res.setEncoding('utf8')
      let body = ''
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (err) {
          reject(err)
        }
      })
    })

    req.on('timeout', () => {
      req.destroy(new Error(`timeout ${url}`))
    })
    req.on('error', reject)
  })
}


function normalizePoeNinjaImageUrl (value: string): string {
  if (value.startsWith('http://') || value.startsWith('https://')) return value
  if (value.startsWith('/')) return `${POE_NINJA_BASE_URL}${value}`
  return value
}

function toNullableString (value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function toNullableNumber (value: unknown): number | null {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function parseLocalDateTimeMs(value: string | null | undefined): number | null {
  if (!value) return null

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/)
  if (!match) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }

  const [, year, month, day, hour, minute, second, ms = '0'] = match
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(ms.padEnd(3, '0'))
  ).getTime()
}

function formatLocalDateTimeMs(date: Date): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function formatError (err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
