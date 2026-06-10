import * as https from 'node:https'
import type { Logger } from '../RemoteLogger'
import { PoeNinjaDatabase, type PoeNinjaTypeCandidate } from './PoeNinjaDatabase'

const POE_NINJA_BASE_URL = 'https://poe.ninja'
const TYPE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15_000

type DenseOverview = {
  type?: unknown
  source?: unknown
  lines?: unknown
}

type DenseOverviewsResponse = {
  currencyOverviews?: DenseOverview[]
  itemOverviews?: DenseOverview[]
}

export class PoeNinjaTypeService {
  private isRefreshing = false

  constructor (
    private readonly database: PoeNinjaDatabase,
    private readonly logger: Logger
  ) {}

  async maybeRefreshTypes (league: string): Promise<void> {
    if (this.isRefreshing) return

    try {
      if (!await this.shouldRefresh()) return
      await this.refreshTypes(league)
    } catch (err) {
      this.logger.write(`warn [PoeNinjaTypeService] type refresh skipped: ${formatError(err)}`)
    }
  }

  async refreshTypes (league: string): Promise<void> {
    if (this.isRefreshing) return
    this.isRefreshing = true

    try {
      const types = await this.discoverEconomyTypes(league)
      this.database.upsertItemTypes(types)
      this.logger.write(`info [PoeNinjaTypeService] upserted ${types.length} poe.ninja item types`)
    } finally {
      this.isRefreshing = false
    }
  }

  private async shouldRefresh (): Promise<boolean> {
    const state = this.database.getTypeDiscoveryState()
    if (state.typeCount <= 1) return true
    if (!state.latestDiscoveredAt) return true

    const discoveredAt = new Date(state.latestDiscoveredAt).getTime()
    if (!Number.isFinite(discoveredAt)) return true

    return Date.now() - discoveredAt >= TYPE_REFRESH_INTERVAL_MS
  }

  private async discoverEconomyTypes (league: string): Promise<PoeNinjaTypeCandidate[]> {
    const trimmedLeague = league.trim()
    if (!trimmedLeague) return []

    const response = await requestJson(buildDenseOverviewsUrl(trimmedLeague)) as DenseOverviewsResponse
    const apiTypes = new Set<string>()

    for (const overview of [
      ...(Array.isArray(response.currencyOverviews) ? response.currencyOverviews : []),
      ...(Array.isArray(response.itemOverviews) ? response.itemOverviews : [])
    ]) {
      const apiType = typeof overview?.type === 'string' ? overview.type.trim() : ''
      if (apiType) apiTypes.add(apiType)
    }

    return Array.from(apiTypes)
      .map((apiType) => ({ type: apiTypeToPageSlug(apiType) }))
      .filter((entry): entry is PoeNinjaTypeCandidate => entry.type.length > 0)
      .sort((a, b) => a.type.localeCompare(b.type))
  }
}

function buildDenseOverviewsUrl (league: string): string {
  const leagueParam = encodeURIComponent(league)
  return `${POE_NINJA_BASE_URL}/poe1/api/economy/current/dense/overviews?league=${leagueParam}&language=en`
}

function apiTypeToPageSlug (apiType: string): string {
  const trimmed = apiType.trim()
  if (!trimmed) return ''

  const special: Record<string, string> = {
    AllflameEmber: 'allflame-embers',
    Artifact: 'artifacts',
    Astrolabe: 'astrolabes',
    BaseType: 'base-types',
    Beast: 'beasts',
    BlightRavagedMap: 'blight-ravaged-maps',
    BlightedMap: 'blighted-maps',
    ClusterJewel: 'cluster-jewels',
    Coffin: 'coffins',
    Currency: 'currency',
    DeliriumOrb: 'delirium-orbs',
    DivinationCard: 'divination-cards',
    DjinnCoin: 'djinn-coins',
    Essence: 'essences',
    ForbiddenJewel: 'forbidden-jewels',
    Fossil: 'fossils',
    Fragment: 'fragments',
    ImbuedGem: 'imbued-gems',
    Incubator: 'incubators',
    IncursionTemple: 'temples',
    Invitation: 'invitations',
    KalguuranRune: 'kalguuran-runes',
    Map: 'maps',
    Memory: 'memories',
    Oil: 'oils',
    Omen: 'omens',
    Resonator: 'resonators',
    Runegraft: 'runegrafts',
    Scarab: 'scarabs',
    ScourgedMap: 'scourged-maps',
    ShrineBelt: 'shrine-belts',
    SkillGem: 'skill-gems',
    Tattoo: 'tattoos',
    UniqueAccessory: 'unique-accessories',
    UniqueArmour: 'unique-armours',
    UniqueFlask: 'unique-flasks',
    UniqueIdol: 'unique-idols',
    UniqueJewel: 'unique-jewels',
    UniqueMap: 'unique-maps',
    UniqueRelic: 'unique-relics',
    UniqueTincture: 'unique-tinctures',
    UniqueWeapon: 'unique-weapons',
    ValdoMap: 'valdo-maps',
    Vial: 'vials',
    Wombgift: 'wombgifts'
  }
  if (special[trimmed]) return special[trimmed]

  const kebab = trimmed
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()

  return pluralizeSlug(kebab)
}

function pluralizeSlug (slug: string): string {
  if (!slug) return ''
  if (slug.endsWith('s')) return slug
  if (slug.endsWith('y')) return `${slug.slice(0, -1)}ies`
  return `${slug}s`
}

function requestJson (url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'user-agent': 'poe-at-tr-jp/poe-ninja-type-discovery'
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

function formatError (err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
