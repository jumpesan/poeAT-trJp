'use strict'

import type { Logger } from '../RemoteLogger'
import type { ServerEvents } from '../server'
import { MapRunDatabase } from './MapRunDatabase'

type GeneratedAreaLog = {
  level: number
  areaId: string
  seed: number
}

const GENERATED_AREA_RE = /Generating level (\d+) area "([^"]+)" with seed (\d+)/
const SCENE_SET_SOURCE_RE = /\[SCENE\] Set Source \[(.*)\]/
const ACT_AREA_ID_RE = /^\d+(?:_\d+)*$/
const MAP_RUN_DEBUG = false
const MAP_RUN_TIMER_RESET_START_TARGET = 'map-run-timer-reset-start'
const MAP_RUN_TIMER_HIDE_TARGET = 'map-run-timer-hide'
const MAP_RUN_TIMER_FREEZE_TARGET = 'map-run-timer-freeze'
const MAP_RUN_TIMER_SHOW_TARGET = 'map-run-timer-show'
const MAP_RUN_STATS_SHOW_TARGET = 'map-run-stats-show'
const MAP_RUN_STATS_RECENT_RUNS_LIMIT = 50

export class MapRunService {
  private currentSeed: number | null = null
  private currentArea: GeneratedAreaLog | null = null
  private currentMapDisplayName: string | null = null
  private isInMap = false

  constructor(
    private readonly database: MapRunDatabase,
    private readonly logger: Logger,
    private readonly server: ServerEvents,
    private readonly onMapEnterDetected?: () => void | Promise<void>,
  ) {
    this.server.onEventAnyClient('CLIENT->MAIN::map-run-delete' as any, (payloadAny: any) => {
      const runId = Number(payloadAny?.runId)
      const areaId = typeof payloadAny?.areaId === 'string' ? payloadAny.areaId : null
      const areaLevel = Number(payloadAny?.areaLevel)

      const deleted = this.database.deleteRun(runId)
      if (!deleted || !areaId || !Number.isFinite(areaLevel)) return

      const stats = this.database.getStats({
        areaId,
        areaLevel,
        recentRunsLimit: MAP_RUN_STATS_RECENT_RUNS_LIMIT,
      })
      this.server.sendEventTo('broadcast', {
        name: 'MAIN->CLIENT::widget-action',
        payload: {
          target: MAP_RUN_STATS_SHOW_TARGET,
          stats,
        }
      } as any)
    })
  }

  handleLines(lines: string[]): void {
    for (const line of lines) {
      this.handleLine(line)
    }
  }

  resetActiveSeed(reason: string): void {
    if (this.currentSeed != null) {
      this.log(`reset active seed seed=${this.currentSeed} reason=${reason}`)
    } else {
      this.log(`reset active seed reason=${reason}`)
    }
    this.currentSeed = null
    this.currentArea = null
    this.currentMapDisplayName = null
    this.isInMap = false
    this.database.resetActiveState()
  }

  private handleLine(line: string): void {
    const sceneSource = this.parseSceneSetSource(line)
    if (sceneSource != null) {
      this.handleSceneSetSource(sceneSource)
      return
    }

    const generatedArea = this.parseGeneratedArea(line)
    if (!generatedArea) return

    this.log(`generated area level=${generatedArea.level} area=${generatedArea.areaId} seed=${generatedArea.seed}`)

    if (generatedArea.seed === 1) {
      this.handleSeedOne(generatedArea)
      return
    }

    if (ACT_AREA_ID_RE.test(generatedArea.areaId)) {
      this.log(`ignore act generated area area=${generatedArea.areaId} seed=${generatedArea.seed}`)
      return
    }

    this.handleMapEnter(generatedArea)
  }

  private handleSeedOne(generatedArea: GeneratedAreaLog): void {
    if (!this.isInMap) {
      this.log(`seed=1 detected area=${generatedArea.areaId}; already out of map, skip DB/timer update`)
      return
    }

    this.log(`seed=1 detected area=${generatedArea.areaId}; finalizing current map run and marking out of map`)
    this.database.touchLatestMapRun()
    this.isInMap = false
    this.currentArea = null
    this.currentMapDisplayName = null
    this.hideTimer(generatedArea)
  }

  private handleMapEnter(generatedArea: GeneratedAreaLog): void {
    const previousSeed = this.currentSeed
    const isSameMapSeed = previousSeed === generatedArea.seed

    if (this.isInMap) {
      this.log(`ignore generated area while already in map currentSeed=${previousSeed ?? 'none'} nextSeed=${generatedArea.seed} area=${generatedArea.areaId}`)
      return
    }

    const shouldResetStartTimer = previousSeed == null || !isSameMapSeed
    const shouldShowTimerOnly = isSameMapSeed

    if (previousSeed != null && !isSameMapSeed) {
      this.log(`map changed after seed=1 previousSeed=${previousSeed} nextSeed=${generatedArea.seed}; previous map should already be finalized by seed=1`)
    } else if (previousSeed == null) {
      this.log('map enter with no active seed; start tracking without finalizing previous map run')
    } else {
      this.log(`map re-enter after seed=1 seed=${generatedArea.seed}`)
    }

    this.currentMapDisplayName = null

    this.database.recordMapEnter({
      seed: generatedArea.seed,
      areaId: generatedArea.areaId,
      areaLevel: generatedArea.level,
    })
    this.currentSeed = generatedArea.seed
    this.currentArea = generatedArea
    this.isInMap = true
    this.log(`upserted map run seed=${generatedArea.seed} area=${generatedArea.areaId} level=${generatedArea.level}`)

    this.showStats(generatedArea)

    if (shouldResetStartTimer) {
      this.resetStartTimer(generatedArea)
    } else if (shouldShowTimerOnly) {
      this.showTimer(generatedArea)
    }

    void this.onMapEnterDetected?.()
  }

  private hideTimer(generatedArea: GeneratedAreaLog): void {
    this.log(`timer freeze seed=${generatedArea.seed} area=${generatedArea.areaId}`)
    this.server.sendEventTo('broadcast', {
      name: 'MAIN->CLIENT::widget-action',
      payload: { target: MAP_RUN_TIMER_FREEZE_TARGET }
    })
  }


  private showTimer(generatedArea: GeneratedAreaLog): void {
    this.log(`timer show seed=${generatedArea.seed} area=${generatedArea.areaId}`)
    this.server.sendEventTo('broadcast', {
      name: 'MAIN->CLIENT::widget-action',
      payload: { target: MAP_RUN_TIMER_SHOW_TARGET }
    })
  }


  private handleSceneSetSource(source: string): void {
    const mapDisplayName = source.trim()
    if (!this.isInMap || this.currentSeed == null || !mapDisplayName || mapDisplayName === '(null)') return
    if (this.currentMapDisplayName != null) return

    this.currentMapDisplayName = mapDisplayName
    this.database.updateMapDisplayName({
      seed: this.currentSeed,
      mapDisplayName,
    })
    this.log(`map display name updated seed=${this.currentSeed} name=${mapDisplayName}`)

    if (this.currentArea != null) {
      this.showStats(this.currentArea)
    }
  }

  private showStats(generatedArea: GeneratedAreaLog): void {
    const stats = this.database.getStats({
      areaId: generatedArea.areaId,
      areaLevel: generatedArea.level,
      recentRunsLimit: MAP_RUN_STATS_RECENT_RUNS_LIMIT,
    })
    this.log(`stats show area=${generatedArea.areaId} level=${generatedArea.level} avg=${stats.averageTimeMs ?? 'none'} best=${stats.bestTimeMs ?? 'none'} recent=${stats.recentRuns.length}`)
    this.server.sendEventTo('broadcast', {
      name: 'MAIN->CLIENT::widget-action',
      payload: {
        target: MAP_RUN_STATS_SHOW_TARGET,
        stats,
      }
    } as any)
  }

  private parseSceneSetSource(line: string): string | null {
    const match = line.match(SCENE_SET_SOURCE_RE)
    return match ? match[1] : null
  }

  private parseGeneratedArea(line: string): GeneratedAreaLog | null {
    const match = line.match(GENERATED_AREA_RE)
    if (!match) return null

    return {
      level: Number(match[1]),
      areaId: match[2],
      seed: Number(match[3]),
    }
  }

  private resetStartTimer(generatedArea: GeneratedAreaLog): void {
    this.log(`timer reset/start seed=${generatedArea.seed} area=${generatedArea.areaId}`)
    this.server.sendEventTo('broadcast', {
      name: 'MAIN->CLIENT::widget-action',
      payload: { target: MAP_RUN_TIMER_RESET_START_TARGET }
    })
  }

  private log(message: string): void {
    if (!MAP_RUN_DEBUG) return
    const line = `[MapRun] ${message}`
    console.log(line)
    this.logger.write(`info ${line}`)
  }
}
