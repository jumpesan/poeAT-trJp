import { session } from 'electron'
import type { Cookie, Session } from 'electron'
import type { WebSocket } from 'ws'
import type { ServerEvents } from '../server'
import { SnapshotDatabase } from '../snapshot/SnapshotDatabase'
import { PoeNinjaValueService, type ItemDataRecord } from '../poe-ninja/PoeNinjaValueService'

/**
 * PoE snapshot access.
 *
 * This module uses Path of Exile website session endpoints after explicit user login.
 * It is not the official OAuth Developer API.
 *
 * The official Developer API requires OAuth authorization for private account data,
 * but new OAuth application processing is currently unavailable for community tools.
 * Keep snapshot requests user-triggered, low-frequency, local-only, and never send
 * cookies or retrieved account data to external services.
 */

const POE_SESSION = 'persist:poe-login'
const BASE_URL = 'https://www.pathofexile.com'
const REALM = 'pc'
const POE_SNAPSHOT_DEBUG = false

function poeSnapshotDebugLog (...args: unknown[]) {
  if (POE_SNAPSHOT_DEBUG) console.log(...args)
}

type SelectedCharacter = {
  name: string
  league: string
}

export type OwnedItemsRequest = {
  character?: SelectedCharacter
  characters?: SelectedCharacter[]
  selectedStashTabIds?: string[]
  allCharactersInventory?: boolean
  skipCharacterInventory?: boolean
  itemDataRecords?: ItemDataRecord[]
}

type StashTabsRequest = {
  league?: string
}

type StashTabSummary = {
  id: string
  name: string
  type: string
  index: number
}

type SnapshotItemSource = 'character' | 'stash'

type RateLimitRule = {
  limit: number
  windowSeconds: number
  penaltySeconds: number
}

type RateLimitState = {
  used: number
  windowSeconds: number
  penaltySeconds: number
}

type RateLimitInfo = {
  accountRules: RateLimitRule[]
  ipRules: RateLimitRule[]
  accountStates: RateLimitState[]
  ipStates: RateLimitState[]
  nextDelayMs: number
  source: 'header' | 'fallback'
}

type PoeJsonResult = {
  data: any
  rateLimit?: RateLimitInfo
}

export type SnapshotResult = {
  ok: boolean
  type: 'owned-items'
  savedPath?: string
  itemCount?: number
  inventoryItemCount?: number
  characterInventoryCount?: number
  failedCharacterInventoryCount?: number
  stashItemCount?: number
  fetchedStashTabCount?: number
  stashTabCount?: number
  summaryGroupCount?: number
  character?: SelectedCharacter
  error?: string
  errorKind?: 'temporarily-unavailable' | 'request-failed'
  responseStatus?: number
  poeErrorCode?: number
  poeErrorMessage?: string
}

class PoeSnapshotRequestError extends Error {
  constructor (
    message: string,
    readonly endpoint: string,
    readonly responseStatus: number,
    readonly responseBody: string,
    readonly poeErrorCode?: number,
    readonly poeErrorMessage?: string
  ) {
    super(message)
    this.name = 'PoeSnapshotRequestError'
  }

  get isTemporarilyUnavailable (): boolean {
    return this.responseStatus === 503 || this.poeErrorCode === 7
  }
}

export class PoeSnapshot {
  private readonly snapshotDatabase = new SnapshotDatabase()
  private snapshotValuesClient?: WebSocket

  constructor (private server: ServerEvents, private readonly poeNinjaValueService?: PoeNinjaValueService) {
    poeSnapshotDebugLog('[PoeSnapshotTrace] constructor start')
    poeSnapshotDebugLog('[PoeSnapshotTrace] registering CLIENT->MAIN::poe-snapshot-owned-items')
    this.server.onEventAnyClient('CLIENT->MAIN::poe-snapshot-owned-items' as any, async (payloadAny: any) => {
      const requestId = this.getDebugRequestId(payloadAny)
      poeSnapshotDebugLog('[PoeSnapshotTrace] received CLIENT->MAIN::poe-snapshot-owned-items:', this.describeOwnedItemsPayload(payloadAny))

      const result = await this.snapshotOwnedItems(payloadAny as OwnedItemsRequest)

      poeSnapshotDebugLog('[PoeSnapshotTrace] sending MAIN->CLIENT::poe-snapshot-owned-items-result:', this.describeSnapshotResult(result, requestId))
      this.broadcastOwnedItemsSnapshotResult(result)
    })

    // Keep the previous event name as a compatibility alias while the UI is being migrated.
    poeSnapshotDebugLog('[PoeSnapshotTrace] registering CLIENT->MAIN::poe-snapshot-character-items')
    this.server.onEventAnyClient('CLIENT->MAIN::poe-snapshot-character-items' as any, async (payloadAny: any) => {
      const requestId = this.getDebugRequestId(payloadAny)
      poeSnapshotDebugLog('[PoeSnapshotTrace] received CLIENT->MAIN::poe-snapshot-character-items:', this.describeOwnedItemsPayload(payloadAny))

      const result = await this.snapshotOwnedItems(payloadAny as OwnedItemsRequest)

      poeSnapshotDebugLog('[PoeSnapshotTrace] sending MAIN->CLIENT::poe-snapshot-character-items-result:', this.describeSnapshotResult(result, requestId))
      this.server.sendEventTo('broadcast', {
        name: 'MAIN->CLIENT::poe-snapshot-character-items-result',
        payload: result
      } as any)
    })

    this.server.onEventAnyClient('CLIENT->MAIN::snapshot-value-overview' as any, (payloadAny: any) => {
      const limit = typeof payloadAny?.limit === 'number' ? payloadAny.limit : 20

      try {
        const result = this.snapshotDatabase.getSnapshotValueOverview(limit)
        this.server.sendEventTo('broadcast', {
          name: 'MAIN->CLIENT::snapshot-value-overview' as any,
          payload: { ok: true, ...result }
        } as any)
      } catch (error) {
        this.server.sendEventTo('broadcast', {
          name: 'MAIN->CLIENT::snapshot-value-overview' as any,
          payload: { ok: false, error: String(error) }
        } as any)
      }
    })

    this.server.onEventAnyClient('CLIENT->MAIN::snapshot-value-compare' as any, (payloadAny: any) => {
      try {
        const result = this.snapshotDatabase.getSnapshotValueComparison(
          Number(payloadAny?.firstSnapshotId),
          Number(payloadAny?.secondSnapshotId)
        )
        this.server.sendEventTo('broadcast', {
          name: 'MAIN->CLIENT::snapshot-value-compare' as any,
          payload: { ok: true, ...result }
        } as any)
      } catch (error) {
        this.server.sendEventTo('broadcast', {
          name: 'MAIN->CLIENT::snapshot-value-compare' as any,
          payload: { ok: false, error: String(error) }
        } as any)
      }
    })

    this.server.onEventAnyClient('CLIENT->MAIN::snapshot-value-delete' as any, (payloadAny: any) => {
      try {
        const snapshotId = Number(payloadAny?.snapshotId)
        const deleted = this.snapshotDatabase.deleteSnapshot(snapshotId)
        this.server.sendEventToClient(this.snapshotValuesClient, {
          name: 'MAIN->CLIENT::snapshot-value-delete-result' as any,
          payload: { ok: true, deleted, snapshotId }
        } as any)
      } catch (error) {
        this.server.sendEventToClient(this.snapshotValuesClient, {
          name: 'MAIN->CLIENT::snapshot-value-delete-result' as any,
          payload: { ok: false, error: String(error) }
        } as any)
      }
    })

    this.server.onEventAnyClientWithSocket('CLIENT->MAIN::snapshot-values-widget-ready' as any, (payloadAny: any, client: WebSocket) => {
      if (payloadAny?.mounted === false) {
        if (this.snapshotValuesClient === client) {
          this.snapshotValuesClient = undefined
        }
        return
      }

      this.snapshotValuesClient = client
    })

    poeSnapshotDebugLog('[PoeSnapshotTrace] registering CLIENT->MAIN::poe-get-stash-tabs')
    this.server.onEventAnyClient('CLIENT->MAIN::poe-get-stash-tabs' as any, async (payloadAny: any) => {
      const requestId = this.getDebugRequestId(payloadAny)
      poeSnapshotDebugLog('[PoeSnapshotTrace] received CLIENT->MAIN::poe-get-stash-tabs:', this.describeStashTabsPayload(payloadAny))

      const result = await this.getStashTabs(payloadAny as StashTabsRequest)

      poeSnapshotDebugLog('[PoeSnapshotTrace] sending MAIN->CLIENT::poe-stash-tabs:', this.describeStashTabsResult(result, requestId))
      this.server.sendEventTo('broadcast', {
        name: 'MAIN->CLIENT::poe-stash-tabs',
        payload: result
      } as any)
    })
    poeSnapshotDebugLog('[PoeSnapshotTrace] constructor completed')
  }

  broadcastOwnedItemsSnapshotResult(result: SnapshotResult): void {
    this.server.sendEventTo('broadcast', {
      name: 'MAIN->CLIENT::poe-snapshot-owned-items-result',
      payload: result
    } as any)
  }

  private sendOwnedItemsSnapshotStateToWidget(running: boolean): void {
    this.server.sendEventToClient(this.snapshotValuesClient, {
      name: 'MAIN->CLIENT::poe-snapshot-owned-items-state' as any,
      payload: {
        running,
        changedAt: new Date().toISOString()
      }
    } as any)
  }

  getLatestSnapshotAt(): string | null {
    return this.snapshotDatabase.getLatestSnapshotAt()
  }

  private getDebugRequestId (payload: any): string | undefined {
    return typeof payload?.debugRequestId === 'string' ? payload.debugRequestId : undefined
  }

  private describeOwnedItemsPayload (payload: any) {
    return {
      debugRequestId: this.getDebugRequestId(payload),
      hasPayload: payload != null,
      character: payload?.character,
      allCharactersInventory: payload?.allCharactersInventory === true,
      characterCount: Array.isArray(payload?.characters) ? payload.characters.length : undefined,
      selectedStashTabIds: Array.isArray(payload?.selectedStashTabIds)
        ? {
            count: payload.selectedStashTabIds.length,
            preview: payload.selectedStashTabIds.slice(0, 10)
          }
        : payload?.selectedStashTabIds
    }
  }

  private describeStashTabsPayload (payload: any) {
    return {
      debugRequestId: this.getDebugRequestId(payload),
      hasPayload: payload != null,
      league: payload?.league
    }
  }

  private describeSnapshotResult (result: SnapshotResult, requestId?: string) {
    return {
      debugRequestId: requestId,
      ok: result.ok,
      type: result.type,
      savedPath: result.savedPath,
      itemCount: result.itemCount,
      inventoryItemCount: result.inventoryItemCount,
      characterInventoryCount: result.characterInventoryCount,
      failedCharacterInventoryCount: result.failedCharacterInventoryCount,
      stashItemCount: result.stashItemCount,
      fetchedStashTabCount: result.fetchedStashTabCount,
      stashTabCount: result.stashTabCount,
      summaryGroupCount: result.summaryGroupCount,
      error: result.error,
      errorKind: result.errorKind,
      responseStatus: result.responseStatus,
      poeErrorCode: result.poeErrorCode,
      poeErrorMessage: result.poeErrorMessage
    }
  }

  private describeStashTabsResult (result: { ok: boolean, tabs?: StashTabSummary[], error?: string, errorKind?: 'temporarily-unavailable' | 'request-failed' }, requestId?: string) {
    return {
      debugRequestId: requestId,
      ok: result.ok,
      tabCount: result.tabs?.length,
      firstTabs: result.tabs?.slice(0, 5),
      error: result.error,
      errorKind: result.errorKind
    }
  }

  private async getStashTabs (payload: StashTabsRequest): Promise<{ ok: boolean, tabs?: StashTabSummary[], error?: string, errorKind?: 'temporarily-unavailable' | 'request-failed' }> {
    poeSnapshotDebugLog('[PoeSnapshotTrace] getStashTabs start:', this.describeStashTabsPayload(payload))
    try {
      const league = payload.league

      if (!league) {
        throw new Error('リーグが選択されていません')
      }

      const accountName = await this.tryGetAccountName()
      poeSnapshotDebugLog('[PoeSnapshotTrace] getStashTabs account detected:', { accountName, league })
      const stashTab0Result = await this.fetchStashTab(league, 0, true, accountName)
      const tabs = this.extractStashTabSummaries(stashTab0Result.data)
      poeSnapshotDebugLog('[PoeSnapshotTrace] getStashTabs completed:', { tabCount: tabs.length })

      return {
        ok: true,
        tabs
      }
    } catch (error) {
      poeSnapshotDebugLog('[PoeSnapshotTrace] getStashTabs failed:', error)
      if (error instanceof PoeSnapshotRequestError) {
        return {
          ok: false,
          error: error.message,
          errorKind: error.isTemporarilyUnavailable ? 'temporarily-unavailable' : 'request-failed'
        }
      }

      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async snapshotOwnedItems (payload: OwnedItemsRequest): Promise<SnapshotResult> {
    poeSnapshotDebugLog('[PoeSnapshotTrace] snapshotOwnedItems start:', this.describeOwnedItemsPayload(payload))
    this.sendOwnedItemsSnapshotStateToWidget(true)

    try {
      const character = payload.character

      if (!character?.league) {
        throw new Error('対象リーグが選択されていません')
      }
      if (!payload.skipCharacterInventory && !character?.name) {
        throw new Error('対象キャラクターが選択されていません')
      }

      const startedAt = new Date()
      const accountName = await this.tryGetAccountName()
      poeSnapshotDebugLog('[PoeSnapshotTrace] snapshotOwnedItems account detected:', { accountName, character })

      const priceRefreshPromise = this.poeNinjaValueService
        ? this.poeNinjaValueService.maybeRefreshValues(character.league, {
            itemDataRecords: Array.isArray(payload.itemDataRecords) ? payload.itemDataRecords : []
          })
        : Promise.resolve(undefined)

      // Inventory must be fetched first. Later automatic map/stash snapshot flows may run
      // while the character inventory changes inside a map, so this is the snapshot anchor.
      const inventoryTargets = payload.skipCharacterInventory ? [] : this.resolveInventoryCharactersForSnapshot(payload, character)
      const characterInventories: Array<{ character: SelectedCharacter, data: any }> = []
      const failedCharacterInventories: Array<{ character: SelectedCharacter, error: string }> = []
      let lastRateLimit: RateLimitInfo | undefined

      for (const inventoryCharacter of inventoryTargets) {
        if (lastRateLimit) {
          await this.waitBeforeNextSnapshotRequest(lastRateLimit, `before character inventory ${inventoryCharacter.name}`)
        }

        try {
          const characterItemsResult = await this.fetchCharacterItems(inventoryCharacter, accountName)
          const characterItems = characterItemsResult.data
          characterInventories.push({ character: inventoryCharacter, data: characterItems })
          lastRateLimit = characterItemsResult.rateLimit

          poeSnapshotDebugLog('[PoeSnapshotTrace] snapshotOwnedItems inventory fetched:', {
            character: inventoryCharacter,
            itemCount: Array.isArray(characterItems?.items) ? characterItems.items.length : 0,
            nextDelayMs: characterItemsResult.rateLimit?.nextDelayMs
          })
        } catch (error) {
          if (payload.allCharactersInventory === true) {
            failedCharacterInventories.push({
              character: inventoryCharacter,
              error: error instanceof Error ? error.message : String(error)
            })
            poeSnapshotDebugLog('[PoeSnapshotTrace] snapshotOwnedItems inventory fetch failed and skipped:', {
              character: inventoryCharacter,
              error
            })
            continue
          }

          throw error
        }
      }

      if (!payload.skipCharacterInventory && characterInventories.length === 0) {
        throw new Error('キャラクターのインベントリを取得できませんでした')
      }

      const inventorySnapshotAt = new Date()

      const explicitlySelectedNoStashTabs = Array.isArray(payload.selectedStashTabIds) && payload.selectedStashTabIds.length === 0
      let stashTabListData: any | undefined
      let stashTabCount = 0
      let stashTabs: Array<{ tabIndex: number, data: any }> = []

      if (explicitlySelectedNoStashTabs) {
        poeSnapshotDebugLog('[PoeSnapshot] stash tab fetch skipped because no stash tabs are selected')
      } else {
        await this.waitBeforeNextSnapshotRequest(lastRateLimit, 'before stash tab 0')

        const stashTab0Result = await this.fetchStashTab(character.league, 0, true, accountName)
        const stashTab0 = stashTab0Result.data
        stashTabListData = stashTab0
        lastRateLimit = stashTab0Result.rateLimit

        stashTabCount = typeof stashTab0?.numTabs === 'number' ? stashTab0.numTabs : 1
        const availableStashTabs = this.extractStashTabSummaries(stashTab0)
        const selectedStashTabIndexes = this.resolveSelectedStashTabIndexes(availableStashTabs, payload.selectedStashTabIds, stashTabCount)
        const selectedStashTabIndexSet = new Set(selectedStashTabIndexes)
        stashTabs = selectedStashTabIndexSet.has(0) ? [{ tabIndex: 0, data: stashTab0 }] : []
        const remainingTabIndexes = selectedStashTabIndexes.filter((tabIndex) => tabIndex !== 0)

        poeSnapshotDebugLog('[PoeSnapshot] stash tabs detected:', {
          stashTabCount,
          selectedStashTabCount: selectedStashTabIndexes.length,
          remainingTabCount: remainingTabIndexes.length
        })

        for (const tabIndex of remainingTabIndexes) {
          await this.waitBeforeNextSnapshotRequest(lastRateLimit, `before stash tab ${tabIndex}`)

          const stashTabResult = await this.fetchStashTab(character.league, tabIndex, false, accountName)
          stashTabs.push({ tabIndex, data: stashTabResult.data })
          lastRateLimit = stashTabResult.rateLimit

          poeSnapshotDebugLog('[PoeSnapshot] stash tab fetched:', {
            fetchedStashTabCount: stashTabs.length,
            stashTabCount,
            tabIndex,
            itemCount: Array.isArray(stashTabResult.data?.items) ? stashTabResult.data.items.length : 0,
            nextDelayMs: lastRateLimit?.nextDelayMs
          })
        }
      }

      const completedAt = new Date()
      const snapshot = this.createOwnedItemsSnapshot({
        accountName,
        character,
        characterInventories,
        failedCharacterInventories,
        stashTabs,
        stashTabListData,
        stashTabCount,
        startedAt,
        inventorySnapshotAt,
        completedAt,
        rateLimit: lastRateLimit
      })
      const savedPath = ''
      const snapshotId = this.snapshotDatabase.saveOwnedItemsSnapshot({
        snapshotAt: snapshot.snapshotAt,
        accountName: snapshot.accountName,
        league: snapshot.league,
        rawJsonPath: savedPath,
        normalizedItems: snapshot.normalizedItems,
        goldAmount: snapshot.metadata.goldAmount
      })
      await priceRefreshPromise
      this.snapshotDatabase.saveSnapshotValues(snapshotId)
      poeSnapshotDebugLog('[PoeSnapshotTrace] snapshotOwnedItems completed:', {
        savedPath,
        normalizedItemCount: snapshot.normalizedItems.length,
        inventoryItemCount: snapshot.metadata.inventoryItemCount,
        characterInventoryCount: snapshot.metadata.characterInventoryCount,
        failedCharacterInventoryCount: snapshot.metadata.failedCharacterInventoryCount,
        stashItemCount: snapshot.metadata.stashItemCount,
        fetchedStashTabCount: snapshot.metadata.fetchedStashTabCount,
        stashTabCount: snapshot.metadata.stashTabCount,
        summaryGroupCount: snapshot.summary.byItemKey.length
      })

      return {
        ok: true,
        type: 'owned-items',
        savedPath,
        itemCount: snapshot.normalizedItems.length,
        inventoryItemCount: snapshot.metadata.inventoryItemCount,
        characterInventoryCount: snapshot.metadata.characterInventoryCount,
        failedCharacterInventoryCount: snapshot.metadata.failedCharacterInventoryCount,
        stashItemCount: snapshot.metadata.stashItemCount,
        fetchedStashTabCount: snapshot.metadata.fetchedStashTabCount,
        stashTabCount: snapshot.metadata.stashTabCount,
        summaryGroupCount: snapshot.summary.byItemKey.length,
        character
      }
    } catch (error) {
      poeSnapshotDebugLog('[PoeSnapshotTrace] snapshotOwnedItems failed:', error)
      if (error instanceof PoeSnapshotRequestError) {
        return {
          ok: false,
          type: 'owned-items',
          error: error.message,
          errorKind: error.isTemporarilyUnavailable ? 'temporarily-unavailable' : 'request-failed',
          responseStatus: error.responseStatus,
          poeErrorCode: error.poeErrorCode,
          poeErrorMessage: error.poeErrorMessage
        }
      }

      return {
        ok: false,
        type: 'owned-items',
        error: error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.sendOwnedItemsSnapshotStateToWidget(false)
    }
  }

  private resolveInventoryCharactersForSnapshot (payload: OwnedItemsRequest, selectedCharacter: SelectedCharacter): SelectedCharacter[] {
    if (payload.allCharactersInventory !== true) {
      return [selectedCharacter]
    }

    const candidates = Array.isArray(payload.characters) ? payload.characters : []
    const map = new Map<string, SelectedCharacter>()

    const addCharacter = (character: SelectedCharacter | undefined) => {
      if (!character?.name) return

      const league = character.league || selectedCharacter.league
      map.set(`${character.name}:${league}`, {
        name: character.name,
        league
      })
    }

    addCharacter(selectedCharacter)
    candidates.forEach(addCharacter)

    return [...map.values()]
  }

  private async fetchCharacterItems (character: SelectedCharacter, accountName: string | undefined): Promise<PoeJsonResult> {
    const poeSession = session.fromPartition(POE_SESSION)

    const body = new URLSearchParams()

    if (accountName) {
      body.set('accountName', accountName)
    }

    body.set('character', character.name)
    body.set('realm', REALM)

    const referer = accountName
      ? `${BASE_URL}/account/view-profile/${encodeURIComponent(this.toProfileSlug(accountName))}`
      : `${BASE_URL}/my-account`
    const requestUrl = `${BASE_URL}/character-window/get-items`
    const requestHeaders = {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: BASE_URL,
      Referer: referer
    }
    const requestBody = body.toString()
    const cookies = await this.getDebugCookies(poeSession)

    poeSnapshotDebugLog('[PoeSnapshot] get character items request:', {
      url: requestUrl,
      method: 'POST',
      character: character.name,
      league: character.league,
      accountName: accountName ?? '(not detected)',
      body: requestBody,
      headers: requestHeaders,
      cookies: cookies.map((cookie) => this.toCookieDebug(cookie))
    })

    const res = await poeSession.fetch(requestUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: requestBody
    })

    const text = await res.text()

    poeSnapshotDebugLog('[PoeSnapshot] get character items response:', {
      status: res.status,
      statusText: res.statusText,
      ok: res.ok,
      headers: this.toHeadersDebug(res.headers),
      bodyLength: text.length,
      bodyPreview: text.slice(0, 1000)
    })

    if (!res.ok) {
      throw this.createRequestError('get-items', res.status, text)
    }

    try {
      return {
        data: JSON.parse(text),
        rateLimit: this.extractRateLimitInfo(res.headers)
      }
    } catch {
      throw new Error(`get-items returned non-json response: ${text.slice(0, 300)}`)
    }
  }

  private async fetchStashTab (
    league: string,
    tabIndex: number,
    includeTabs: boolean,
    accountName: string | undefined
  ): Promise<PoeJsonResult> {
    const poeSession = session.fromPartition(POE_SESSION)
    const body = new URLSearchParams()

    if (accountName) {
      body.set('accountName', accountName)
    }

    body.set('realm', REALM)
    body.set('league', league)
    body.set('tabs', includeTabs ? '1' : '0')
    body.set('tabIndex', String(tabIndex))

    const referer = accountName
      ? `${BASE_URL}/account/view-profile/${encodeURIComponent(this.toProfileSlug(accountName))}`
      : `${BASE_URL}/my-account`
    const requestUrl = `${BASE_URL}/character-window/get-stash-items`
    const requestHeaders = {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: BASE_URL,
      Referer: referer
    }
    const requestBody = body.toString()
    const cookies = await this.getDebugCookies(poeSession)

    poeSnapshotDebugLog('[PoeSnapshot] get stash tab request:', {
      url: requestUrl,
      method: 'POST',
      league,
      tabIndex,
      includeTabs,
      accountName: accountName ?? '(not detected)',
      body: requestBody,
      headers: requestHeaders,
      cookies: cookies.map((cookie) => this.toCookieDebug(cookie))
    })

    const res = await poeSession.fetch(requestUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: requestBody
    })

    const text = await res.text()

    poeSnapshotDebugLog('[PoeSnapshot] get stash tab response:', {
      status: res.status,
      statusText: res.statusText,
      ok: res.ok,
      headers: this.toHeadersDebug(res.headers),
      bodyLength: text.length,
      bodyPreview: text.slice(0, 1000)
    })

    if (!res.ok) {
      throw this.createRequestError('get-stash-items', res.status, text)
    }

    try {
      return {
        data: JSON.parse(text),
        rateLimit: this.extractRateLimitInfo(res.headers)
      }
    } catch {
      throw new Error(`get-stash-items returned non-json response: ${text.slice(0, 300)}`)
    }
  }

  private createOwnedItemsSnapshot (input: {
    accountName?: string
    character: SelectedCharacter
    characterInventories: Array<{ character: SelectedCharacter, data: any }>
    failedCharacterInventories: Array<{ character: SelectedCharacter, error: string }>
    stashTabs: Array<{ tabIndex: number, data: any }>
    stashTabListData?: any
    stashTabCount: number
    startedAt: Date
    inventorySnapshotAt: Date
    completedAt: Date
    rateLimit?: RateLimitInfo
  }): any {
    const firstStashTab = input.stashTabListData
    const primaryCharacterInventory = input.characterInventories.find(({ character }) => {
      return character.name === input.character.name && character.league === input.character.league
    }) ?? input.characterInventories[0]
    const normalizedCharacterItems = input.characterInventories.flatMap(({ character, data }) => {
      const characterRawItems = Array.isArray(data?.items) ? data.items : []

      return this.normalizeItems(characterRawItems, 'character', {
        characterName: character.name,
        league: character.league
      })
    })
    const characterRawItemCount = input.characterInventories.reduce((total, { data }) => {
      return total + (Array.isArray(data?.items) ? data.items.length : 0)
    }, 0)
    const normalizedStashItems = input.stashTabs.flatMap(({ tabIndex, data }) => {
      const stashRawItems = Array.isArray(data?.items) ? data.items : []

      return this.normalizeItems(stashRawItems, 'stash', {
        tabIndex,
        tabName: this.findStashTabName(firstStashTab, tabIndex),
        league: input.character.league
      })
    })
    const normalizedItems = [
      ...normalizedCharacterItems,
      ...normalizedStashItems
    ]
    const summary = this.createItemSummary(normalizedItems)
    const stashItemCount = input.stashTabs.reduce((total, { data }) => {
      return total + (Array.isArray(data?.items) ? data.items.length : 0)
    }, 0)
    const socketedItemCount = normalizedItems.filter((item) => item.locationKind === 'socketed').length
    const includedStashTabs = input.stashTabs.map(({ tabIndex }) => tabIndex)
    const unsupportedStashTabs = input.stashTabs
      .map(({ tabIndex, data }) => {
        const tabInfo = this.findStashTabInfo(firstStashTab, tabIndex)
        const itemCount = Array.isArray(data?.items) ? data.items.length : 0

        if (tabInfo?.type === 'MapStash' && itemCount === 0) {
          return {
            tabIndex,
            tabName: tabInfo.n ?? '',
            tabType: tabInfo.type,
            reason: 'MapStash returned no items from get-stash-items endpoint.'
          }
        }

        return undefined
      })
      .filter(Boolean)

    return {
      schemaVersion: 1,
      snapshotAt: input.completedAt.toISOString(),
      source: 'pathofexile-web-session',
      accountName: input.accountName,
      league: input.character.league,
      character: input.character,
      metadata: {
        inventoryItemCount: characterRawItemCount,
        characterInventoryCount: input.characterInventories.length,
        failedCharacterInventoryCount: input.failedCharacterInventories.length,
        stashItemCount,
        socketedItemCount,
        normalizedItemCount: normalizedItems.length,
        summaryItemCount: summary.byItemKey.length,
        fetchedStashTabCount: input.stashTabs.length,
        stashTabCount: input.stashTabCount,
        includedCharacters: input.characterInventories.map(({ character, data }) => ({
          name: character.name,
          league: character.league,
          itemCount: Array.isArray(data?.items) ? data.items.length : 0
        })),
        failedCharacterInventories: input.failedCharacterInventories,
        includedStashTabs,
        unsupportedStashTabs,
        startedAt: input.startedAt.toISOString(),
        inventorySnapshotAt: input.inventorySnapshotAt.toISOString(),
        completedAt: input.completedAt.toISOString(),
        rateLimitStrategy: 'dynamic-safe-half-short-window',
        lastRateLimit: input.rateLimit,
        goldAmount: this.extractSnapshotGoldAmount(input.characterInventories),
        note: 'Selected stash tabs are included. Character inventories are always fetched first, then stash tabs are fetched sequentially with dynamic rate-limit delay.'
      },
      raw: {
        characterItems: primaryCharacterInventory?.data,
        characterInventories: input.characterInventories.map(({ character, data }) => ({ character, data })),
        stashTabs: input.stashTabs.map(({ data }) => data)
      },
      normalizedItems,
      summary
    }
  }

  private extractSnapshotGoldAmount (characterInventories: Array<{ character: SelectedCharacter, data: any }>): number | null {
    for (const { data } of characterInventories) {
      const gold = data?.inventory?.gold
      if (typeof gold === 'number' && Number.isFinite(gold)) return Math.trunc(gold)
    }

    return null
  }

  private normalizeItems (items: any[], source: SnapshotItemSource, location: Record<string, unknown>): any[] {
    return items.flatMap((item) => {
      const locationKind = this.getTopLevelLocationKind(source, item)
      const normalizedItem = this.normalizeItem(item, source, locationKind, {
        ...location,
        inventoryId: item.inventoryId,
        x: item.x,
        y: item.y
      })
      const socketedItems = Array.isArray(item.socketedItems) ? item.socketedItems : []
      const normalizedSocketedItems = socketedItems.map((socketedItem: any) => {
        return this.normalizeItem(socketedItem, source, 'socketed', {
          ...location,
          socket: socketedItem.socket,
          socketColour: socketedItem.colour,
          parentLocationKind: locationKind,
          parentInventoryId: item.inventoryId,
          parentItemId: item.id,
          parentItemName: this.getDisplayName(item),
          parentItemTypeLine: item.typeLine ?? '',
          parentItemBaseType: item.baseType ?? item.typeLine ?? '',
          parentX: item.x,
          parentY: item.y
        })
      })

      return [normalizedItem, ...normalizedSocketedItems]
    })
  }

  private normalizeItem (
    item: any,
    source: SnapshotItemSource,
    locationKind: 'equipment' | 'inventory' | 'stash' | 'socketed',
    location: Record<string, unknown>
  ): any {
    return {
      source,
      locationKind,
      location,
      id: item.id,
      name: item.name ?? '',
      typeLine: item.typeLine ?? '',
      baseType: item.baseType ?? item.typeLine ?? '',
      displayName: this.getDisplayName(item),
      frameType: item.frameType,
      frameTypeId: item.frameTypeId,
      identified: item.identified !== false,
      ilvl: item.ilvl,
      stackSize: typeof item.stackSize === 'number' ? item.stackSize : undefined,
      maxStackSize: typeof item.maxStackSize === 'number' ? item.maxStackSize : undefined,
      amount: typeof item.stackSize === 'number' ? item.stackSize : 1,
      itemKey: this.makeItemKey(item),
      raw: item
    }
  }

  private getTopLevelLocationKind (source: SnapshotItemSource, item: any): 'equipment' | 'inventory' | 'stash' {
    if (source === 'stash') {
      return 'stash'
    }

    return item?.inventoryId === 'MainInventory' ? 'inventory' : 'equipment'
  }

  private createItemSummary (items: any[]): any {
    const groups = new Map<string, any>()

    for (const item of items) {
      const key = item.itemKey
      const existing = groups.get(key)
      const amount = typeof item.amount === 'number' ? item.amount : 1

      if (!existing) {
        groups.set(key, {
          itemKey: key,
          name: item.name,
          typeLine: item.typeLine,
          baseType: item.baseType,
          displayName: item.displayName,
          frameTypeId: item.frameTypeId,
          identified: item.identified,
          count: 1,
          amount,
          locations: [item.location],
          locationKinds: [item.locationKind]
        })
        continue
      }

      existing.count += 1
      existing.amount += amount
      existing.locations.push(item.location)

      if (!existing.locationKinds.includes(item.locationKind)) {
        existing.locationKinds.push(item.locationKind)
      }
    }

    return {
      byItemKey: [...groups.values()].sort((a, b) => {
        const aName = a.baseType || a.typeLine || a.name || ''
        const bName = b.baseType || b.typeLine || b.name || ''
        return aName.localeCompare(bName)
      })
    }
  }

  private makeItemKey (item: any): string {
    const base = item.baseType || item.typeLine || ''
    const name = item.name || ''
    const frame = item.frameTypeId || String(item.frameType ?? '')
    const identified = item.identified === false ? 'unidentified' : 'identified'

    // Stack-like items are suitable for amount aggregation by stackSize.
    if (typeof item.stackSize === 'number' || typeof item.maxStackSize === 'number' || item.frameTypeId === 'Currency') {
      return ['stack', base, frame, identified].join('|')
    }

    // For the initial simple profit/asset view, non-stackable items are also grouped
    // by their visible identity. Raw items remain available for exact per-item handling later.
    return ['item', base, name, frame, identified].join('|')
  }

  private getDisplayName (item: any): string {
    const name = item.name || ''
    const typeLine = item.typeLine || ''

    return name ? `${name} ${typeLine}`.trim() : typeLine
  }

  private findStashTabInfo (stashData: any, tabIndex: number): any | undefined {
    const tabs = Array.isArray(stashData?.tabs) ? stashData.tabs : []
    return tabs.find((entry: any) => entry?.i === tabIndex)
  }

  private findStashTabName (stashData: any, tabIndex: number): string | undefined {
    const tab = this.findStashTabInfo(stashData, tabIndex)
    return typeof tab?.n === 'string' ? tab.n : undefined
  }

  private extractStashTabSummaries (stashData: any): StashTabSummary[] {
    const tabs = Array.isArray(stashData?.tabs) ? stashData.tabs : []

    return tabs
      .map((entry: any) => ({
        id: String(entry?.id ?? ''),
        name: typeof entry?.n === 'string' ? entry.n : '',
        type: typeof entry?.type === 'string' ? entry.type : '',
        index: typeof entry?.i === 'number' ? entry.i : Number(entry?.i)
      }))
      .filter((entry: StashTabSummary) => entry.id && Number.isFinite(entry.index))
  }

  private resolveSelectedStashTabIndexes (
    availableTabs: StashTabSummary[],
    selectedStashTabIds: string[] | undefined,
    stashTabCount: number
  ): number[] {
    if (!Array.isArray(selectedStashTabIds)) {
      return Array.from({ length: Math.max(0, stashTabCount) }, (_, index) => index)
    }

    if (selectedStashTabIds.length === 0) {
      return []
    }

    const selectedIds = new Set(selectedStashTabIds)
    const selectedIndexes = availableTabs
      .filter((tab) => selectedIds.has(tab.id))
      .map((tab) => tab.index)
      .sort((a, b) => a - b)

    if (selectedIndexes.length === 0) {
      throw new Error('選択されたスタッシュタブが見つかりません。スタッシュタブ一覧を更新してください。')
    }

    return selectedIndexes
  }

  private async waitBeforeNextSnapshotRequest (rateLimit: RateLimitInfo | undefined, reason: string): Promise<void> {
    const delayMs = rateLimit?.nextDelayMs ?? this.getFallbackSnapshotDelayMs()

    poeSnapshotDebugLog('[PoeSnapshot] wait before next snapshot request:', {
      reason,
      delayMs,
      rateLimitSource: rateLimit?.source ?? 'fallback',
      accountRules: rateLimit?.accountRules,
      accountStates: rateLimit?.accountStates,
      ipRules: rateLimit?.ipRules,
      ipStates: rateLimit?.ipStates
    })

    await this.sleep(delayMs)
  }

  private extractRateLimitInfo (headers: Headers): RateLimitInfo {
    const accountRules = this.parseRateLimitRules(headers.get('x-rate-limit-account'))
    const ipRules = this.parseRateLimitRules(headers.get('x-rate-limit-ip'))
    const accountStates = this.parseRateLimitStates(headers.get('x-rate-limit-account-state'))
    const ipStates = this.parseRateLimitStates(headers.get('x-rate-limit-ip-state'))
    const source = accountRules.length > 0 || ipRules.length > 0 ? 'header' : 'fallback'
    const nextDelayMs = source === 'header'
      ? this.calculateNextDelayMs(accountRules, ipRules, accountStates, ipStates)
      : this.getFallbackSnapshotDelayMs()

    return {
      accountRules,
      ipRules,
      accountStates,
      ipStates,
      nextDelayMs,
      source
    }
  }

  private parseRateLimitRules (value: string | null): RateLimitRule[] {
    if (!value) {
      return []
    }

    return value.split(',')
      .map((part) => part.trim())
      .map((part) => {
        const [limit, windowSeconds, penaltySeconds] = part.split(':').map((entry) => Number(entry))

        if (!Number.isFinite(limit) || !Number.isFinite(windowSeconds) || limit <= 0 || windowSeconds <= 0) {
          return undefined
        }

        return {
          limit,
          windowSeconds,
          penaltySeconds: Number.isFinite(penaltySeconds) ? penaltySeconds : 0
        }
      })
      .filter((rule): rule is RateLimitRule => Boolean(rule))
  }

  private parseRateLimitStates (value: string | null): RateLimitState[] {
    if (!value) {
      return []
    }

    return value.split(',')
      .map((part) => part.trim())
      .map((part) => {
        const [used, windowSeconds, penaltySeconds] = part.split(':').map((entry) => Number(entry))

        if (!Number.isFinite(used) || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
          return undefined
        }

        return {
          used,
          windowSeconds,
          penaltySeconds: Number.isFinite(penaltySeconds) ? penaltySeconds : 0
        }
      })
      .filter((state): state is RateLimitState => Boolean(state))
  }

  private calculateNextDelayMs (
    accountRules: RateLimitRule[],
    ipRules: RateLimitRule[],
    accountStates: RateLimitState[],
    ipStates: RateLimitState[]
  ): number {
    const allRules = [...accountRules, ...ipRules]
    const shortestWindowSeconds = Math.min(...allRules.map((rule) => rule.windowSeconds))
    const shortWindowRules = allRules.filter((rule) => rule.windowSeconds === shortestWindowSeconds)

    // Run at roughly half of the short-window limit so manual searches and other players
    // on the same IP still have headroom. With 30:60 this becomes about 4s/request.
    const halfSpeedDelayMs = shortWindowRules.length > 0
      ? Math.max(...shortWindowRules.map((rule) => (rule.windowSeconds / (rule.limit * 0.5)) * 1000))
      : this.getFallbackSnapshotDelayMs()
    const activePenaltyMs = Math.max(
      0,
      ...accountStates.map((state) => state.penaltySeconds * 1000),
      ...ipStates.map((state) => state.penaltySeconds * 1000)
    )
    const pressureMultiplier = Math.max(
      this.getRateLimitPressureMultiplier(accountRules, accountStates),
      this.getRateLimitPressureMultiplier(ipRules, ipStates)
    )
    const bufferedDelayMs = Math.ceil((halfSpeedDelayMs * pressureMultiplier) + 500)

    return Math.min(
      60000,
      Math.max(1000, bufferedDelayMs, activePenaltyMs > 0 ? activePenaltyMs + 1000 : 0)
    )
  }

  private getRateLimitPressureMultiplier (rules: RateLimitRule[], states: RateLimitState[]): number {
    let multiplier = 1

    for (const state of states) {
      const rule = rules.find((candidate) => candidate.windowSeconds === state.windowSeconds)

      if (!rule) {
        continue
      }

      const ratio = state.used / rule.limit

      if (ratio >= 0.8) {
        multiplier = Math.max(multiplier, 4)
      } else if (ratio >= 0.65) {
        multiplier = Math.max(multiplier, 2)
      } else if (ratio >= 0.5) {
        multiplier = Math.max(multiplier, 1.5)
      }
    }

    return multiplier
  }

  private getFallbackSnapshotDelayMs (): number {
    return 4500
  }

  private async sleep (delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  private createRequestError (endpoint: string, responseStatus: number, responseBody: string): PoeSnapshotRequestError {
    const poeError = this.tryParsePoeError(responseBody)
    const poeErrorPart = poeError
      ? ` code=${poeError.code} message=${poeError.message}`
      : ''

    return new PoeSnapshotRequestError(
      `${endpoint} failed: ${responseStatus}${poeErrorPart}`,
      endpoint,
      responseStatus,
      responseBody,
      poeError?.code,
      poeError?.message
    )
  }

  private tryParsePoeError (responseBody: string): { code?: number, message?: string } | undefined {
    try {
      const parsed = JSON.parse(responseBody)
      const error = parsed?.error

      if (!error || (typeof error.code !== 'number' && typeof error.message !== 'string')) {
        return undefined
      }

      return {
        code: typeof error.code === 'number' ? error.code : undefined,
        message: typeof error.message === 'string' ? error.message : undefined
      }
    } catch {
      return undefined
    }
  }

  private async tryGetAccountName (): Promise<string | undefined> {
    try {
      const poeSession = session.fromPartition(POE_SESSION)
      const res = await poeSession.fetch(`${BASE_URL}/my-account`, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      })

      poeSnapshotDebugLog('[PoeSnapshot] account name page response:', {
        status: res.status,
        statusText: res.statusText,
        ok: res.ok,
        headers: this.toHeadersDebug(res.headers)
      })

      if (!res.ok) {
        poeSnapshotDebugLog('[PoeSnapshot] account name page failed:', res.status)
        return undefined
      }

      const html = await res.text()
      poeSnapshotDebugLog('[PoeSnapshot] account name page html:', {
        length: html.length,
        preview: html.slice(0, 500)
      })
      const patterns = [
        // API payload expects the display account name, e.g. jumpesan#4994.
        // The profile URL slug uses jumpesan-4994, which causes get-items 403.
        /<title>\s*View Profile - Path of Exile - ([^<]+?)\s*<\/title>/i,
        /accountName["']?\s*[:=]\s*["']([^"']+)["']/i,
        /data-account-name=["']([^"']+)["']/i,
        /\/account\/view-profile\/([^"'?#<\s/]+)/i
      ]

      for (const pattern of patterns) {
        const match = html.match(pattern)
        if (match?.[1]) {
          const accountName = this.normalizeAccountNameForApi(
            decodeURIComponent(match[1].replace(/&amp;/g, '&')).trim()
          )
          poeSnapshotDebugLog('[PoeSnapshot] account name detected:', {
            accountName,
            profileSlug: this.toProfileSlug(accountName),
            pattern: pattern.toString()
          })
          return accountName
        }
      }

      poeSnapshotDebugLog('[PoeSnapshot] account name was not detected from /my-account')
      return undefined
    } catch (error) {
      poeSnapshotDebugLog('[PoeSnapshot] account name detection failed:', error)
      return undefined
    }
  }

  private normalizeAccountNameForApi (value: string): string {
    // /account/view-profile/jumpesan-4994 is a profile slug.
    // character-window/get-items expects jumpesan#4994 in accountName.
    return value.replace(/-(\d{4})$/, '#$1')
  }

  private toProfileSlug (accountName: string): string {
    return accountName.replace(/#(\d{4})$/, '-$1')
  }

  private async getDebugCookies (poeSession: Session): Promise<Cookie[]> {
    const results = await Promise.allSettled([
      poeSession.cookies.get({ url: BASE_URL }),
      poeSession.cookies.get({ domain: 'pathofexile.com' })
    ])
    const cookies = results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    const map = new Map<string, Cookie>()

    for (const cookie of cookies) {
      map.set(`${cookie.name}:${cookie.domain}:${cookie.path}`, cookie)
    }

    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  private toCookieDebug (cookie: Cookie): Record<string, unknown> {
    return {
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      session: cookie.session,
      expirationDate: cookie.expirationDate,
      sameSite: cookie.sameSite
    }
  }

  private toHeadersDebug (headers: Headers): Record<string, string> {
    const result: Record<string, string> = {}

    headers.forEach((value, key) => {
      result[key] = key.toLowerCase() === 'set-cookie' ? '<redacted>' : value
    })

    return result
  }

}
