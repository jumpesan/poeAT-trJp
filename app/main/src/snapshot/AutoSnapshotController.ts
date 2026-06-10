'use strict'

import type { Logger } from '../RemoteLogger'
import { PoeSnapshot, type OwnedItemsRequest, type SnapshotResult } from '../host-files/PoeSnapshot'

const AUTO_SNAPSHOT_DEBUG = false
const AUTO_SNAPSHOT_ALLOWED_INTERVALS = new Set([15, 30, 60])

type AutoSnapshotHostConfig = {
  stashCheck?: {
    autoSnapshotIntervalMinutes?: number
    selectedCharacter?: {
      name: string
      league: string
    }
    characters?: Array<{
      name: string
      league: string
    }>
    selectedStashTabIds?: string[]
    inventoryMode?: 'single' | 'all' | 'none'
    itemDataRecords?: Array<{
      name: string
      refName: string
      namespace?: string
      tradeTag?: string
      exchangeable?: boolean
    }>
  }
}

export class AutoSnapshotController {
  private hostConfig: AutoSnapshotHostConfig | null = null
  private running = false

  constructor(
    private readonly poeSnapshot: PoeSnapshot,
    private readonly logger: Logger,
  ) {}

  updateHostConfig(config: AutoSnapshotHostConfig): void {
    this.hostConfig = config
    this.log(`host config updated interval=${this.getIntervalMinutes()}`)
  }

  async onAreaChanged(reason = 'area changed'): Promise<void> {
    const intervalMinutes = this.getIntervalMinutes()
    if (!intervalMinutes) {
      this.log(`skip ${reason}: disabled`)
      return
    }

    if (this.running) {
      this.log(`skip ${reason}: already running`)
      return
    }

    const request = this.createSnapshotRequest()
    if (!request) {
      this.log(`skip ${reason}: snapshot request unavailable`)
      return
    }

    const latestSnapshotAt = this.poeSnapshot.getLatestSnapshotAt()
    if (latestSnapshotAt && !this.isIntervalElapsed(latestSnapshotAt, intervalMinutes)) {
      this.log(`skip ${reason}: interval not elapsed latest=${latestSnapshotAt} interval=${intervalMinutes}`)
      return
    }

    this.running = true
    try {
      this.log(`start auto snapshot reason=${reason} interval=${intervalMinutes}`)
      const result = await this.poeSnapshot.snapshotOwnedItems(request)
      this.poeSnapshot.broadcastOwnedItemsSnapshotResult(result)
      this.log(`auto snapshot completed ok=${result.ok}`)
    } catch (error) {
      const result: SnapshotResult = {
        ok: false,
        type: 'owned-items',
        error: error instanceof Error ? error.message : String(error)
      }
      this.poeSnapshot.broadcastOwnedItemsSnapshotResult(result)
      this.log(`auto snapshot failed error=${result.error}`)
    } finally {
      this.running = false
    }
  }

  private getIntervalMinutes(): number {
    const value = Number(this.hostConfig?.stashCheck?.autoSnapshotIntervalMinutes ?? 0)
    if (!Number.isFinite(value)) return 0
    const minutes = Math.trunc(value)
    return AUTO_SNAPSHOT_ALLOWED_INTERVALS.has(minutes) ? minutes : 0
  }

  private createSnapshotRequest(): OwnedItemsRequest | null {
    const stashCheck = this.hostConfig?.stashCheck
    if (!stashCheck) return null

    const inventoryMode = stashCheck.inventoryMode ?? 'single'
    const selectedCharacter = this.normalizeCharacter(stashCheck.selectedCharacter)
    const characters = Array.isArray(stashCheck.characters)
      ? stashCheck.characters.map(character => this.normalizeCharacter(character)).filter((character): character is { name: string, league: string } => character != null)
      : []
    const anchorCharacter = selectedCharacter ?? characters[0]

    if (!anchorCharacter?.league) return null
    if (inventoryMode !== 'none' && !anchorCharacter.name) return null

    return {
      character: anchorCharacter,
      characters,
      selectedStashTabIds: Array.isArray(stashCheck.selectedStashTabIds)
        ? stashCheck.selectedStashTabIds.filter(id => typeof id === 'string')
        : [],
      allCharactersInventory: inventoryMode === 'all',
      skipCharacterInventory: inventoryMode === 'none',
      itemDataRecords: Array.isArray(stashCheck.itemDataRecords) ? stashCheck.itemDataRecords : []
    }
  }

  private normalizeCharacter(character: unknown): { name: string, league: string } | null {
    if (!character || typeof character !== 'object') return null
    const source = character as { name?: unknown, league?: unknown }
    const name = typeof source.name === 'string' ? source.name : ''
    const league = typeof source.league === 'string' ? source.league : ''
    if (!name && !league) return null
    return { name, league }
  }

  private isIntervalElapsed(snapshotAt: string, intervalMinutes: number): boolean {
    const latestTime = this.parseLocalDateTimeMs(snapshotAt)
    if (!latestTime) return true
    return Date.now() - latestTime.getTime() >= intervalMinutes * 60 * 1000
  }

  private parseLocalDateTimeMs(value: string): Date | null {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/)
    if (!match) {
      const fallback = new Date(value)
      return Number.isNaN(fallback.getTime()) ? null : fallback
    }

    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
      Number((match[7] ?? '0').padEnd(3, '0'))
    )
  }

  private log(message: string): void {
    if (!AUTO_SNAPSHOT_DEBUG) return
    const line = `[AutoSnapshot] ${message}`
    console.log(line)
    this.logger.write(`info ${line}`)
  }
}
