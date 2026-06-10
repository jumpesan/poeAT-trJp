<template>
  <widget
    :config="config"
    :move-handles="['tc']"
    v-slot="{ isMoving }"
    :readonly="true"
    :removable="false"
    :hideable="true">
    <div :class="[$style.wrapper, 'font-poe']" :style="wrapperStyle">
      <div :class="$style.title">
        <span>{{ stats?.mapDisplayName || t('map_timer.stats_title') }}</span>
        <span v-if="stats" :class="$style.area">Lv{{ stats.areaLevel }}</span>
      </div>

      <div v-if="stats" :class="$style.body">
        <div v-if="showAverage && stats.averageTimeMs != null" :class="$style.row">
          <span>{{ t('map_timer.average_time') }}</span>
          <span>{{ formatTime(stats.averageTimeMs) }}</span>
        </div>
        <div v-if="showBest && stats.bestTimeMs != null" :class="$style.row">
          <span>{{ t('map_timer.best_time') }}</span>
          <span>{{ formatTime(stats.bestTimeMs) }}</span>
        </div>
        <div v-if="showRecent" :class="$style.recent">
          <div :class="$style.recentTitle">{{ t('map_timer.recent_times') }}</div>
          <div
            v-for="(run, index) in visibleRecentRuns"
            :key="run.id"
            :class="$style.row"
            @contextmenu.prevent="showRunDelete(run.id)">
            <span>#{{ index + 1 }}</span>
            <span :class="$style.recentTime">{{ formatTime(run.mapTimeMs) }}</span>
            <button
              v-if="showWidgetControls && deleteRunId === run.id"
              :class="$style.deleteButton"
              :style="deleteButtonStyle(deleteHoldProgress)"
              @click.stop.prevent
              @pointerdown.stop.prevent="beginRunDelete(run)"
              @pointerup.stop.prevent="cancelRunDeleteHold"
              @pointerleave.stop.prevent="cancelRunDeleteHold"
              @pointercancel.stop.prevent="cancelRunDeleteHold">
              {{ t('widget.delete') }}
            </button>
          </div>
        </div>
        <div v-if="!hasVisibleStats" :class="$style.empty">
          {{ t('map_timer.no_stats') }}
        </div>
      </div>
    </div>
  </widget>
</template>

<script lang="ts">
import { defineComponent, PropType, inject, computed, ref, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import Widget from '../overlay/Widget.vue'
import { MainProcess } from '@/web/background/IPC'
import { AppConfig } from '@/web/Config'
import { WidgetManager, MapRunStatsWidget, WidgetSpec } from '../overlay/interfaces'

type MapRunStatsRecentRun = {
  id: number
  seed: number
  areaId: string
  areaLevel: number
  mapDisplayName: string | null
  enteredAt: string
  exitedAt: string | null
  mapTimeMs: number
}

type MapRunStatsPayload = {
  areaId: string
  areaLevel: number
  mapDisplayName: string | null
  averageTimeMs: number | null
  bestTimeMs: number | null
  recentRuns: MapRunStatsRecentRun[]
}

const MAP_RUN_STATS_SHOW_TARGET = 'map-run-stats-show'

export default defineComponent({
  widget: {
    type: 'map-run-stats',
    instances: 'single',
    trNameKey: 'map_timer.stats_title',
    initInstance: (): MapRunStatsWidget => {
      return {
        wmId: 0,
        wmType: 'map-run-stats',
        wmTitle: '{icon=fa-chart-line}',
        wmWants: 'hide',
        wmZorder: null,
        wmFlags: [],
        anchor: {
          pos: 'tc',
          x: 50,
          y: 30
        }
      }
    }
  } satisfies WidgetSpec,
  components: { Widget },
  props: {
    config: {
      type: Object as PropType<MapRunStatsWidget>,
      required: true
    }
  },
  setup (props) {
    const wm = inject<WidgetManager>('wm')!
    const stats = ref<MapRunStatsPayload | null>(null)
    const deleteRunId = ref<number | null>(null)
    const deleteHoldProgress = ref(0)
    let deleteHideTimer: ReturnType<typeof window.setTimeout> | null = null
    let deleteHoldTimer: ReturnType<typeof window.setInterval> | null = null

    if (props.config.wmFlags[0] === 'uninitialized') {
      props.config.anchor = {
        pos: 'tc',
        x: 50,
        y: 30
      }
    }

    if (props.config.anchor.pos === 'cc') {
      props.config.anchor = {
        pos: 'tc',
        x: props.config.anchor.x,
        y: props.config.anchor.y
      }
    }

    const actionController = MainProcess.onEvent('MAIN->CLIENT::widget-action', (event) => {
      const e = event as any
      if (e.target !== MAP_RUN_STATS_SHOW_TARGET) return

      stats.value = e.stats as MapRunStatsPayload
      if (hasConfiguredStats.value) {
        wm.show(props.config.wmId)
      } else {
        wm.hide(props.config.wmId)
      }
    })
    onUnmounted(() => {
      actionController.abort()
      clearRunDeleteTimers()
    })

    const mapRunTimerConfig = computed(() => AppConfig().mapRunTimer)
    const showAverage = computed(() => mapRunTimerConfig.value?.showAverageTimeOnEnter ?? false)
    const showBest = computed(() => mapRunTimerConfig.value?.showBestTimeOnEnter ?? false)
    const recentRunsCount = computed(() => Math.max(0, Math.floor(mapRunTimerConfig.value?.recentRunsCount ?? 0)))
    const showRecent = computed(() => recentRunsCount.value > 0 && visibleRecentRuns.value.length > 0)
    const hasConfiguredStats = computed(() => showAverage.value || showBest.value || recentRunsCount.value > 0)
    const visibleRecentRuns = computed(() => (stats.value?.recentRuns ?? []).slice(0, recentRunsCount.value))
    const hasVisibleStats = computed(() => {
      return (showAverage.value && stats.value?.averageTimeMs != null) ||
        (showBest.value && stats.value?.bestTimeMs != null) ||
        showRecent.value
    })
    const showWidgetControls = computed(() => wm.active.value)

    const wrapperStyle = computed(() => {
      const backgroundOpacity = clampOpacity(mapRunTimerConfig.value?.statsBackgroundOpacity ?? 75) / 100
      const textOpacity = clampOpacity(mapRunTimerConfig.value?.statsTextOpacity ?? 100) / 100
      return {
        backgroundColor: `rgba(0, 0, 0, ${backgroundOpacity})`,
        color: `rgba(255, 255, 255, ${textOpacity})`,
        '--map-run-stats-text-opacity': String(textOpacity)
      }
    })

    const buttonStyle = computed(() => {
      const backgroundOpacity = clampOpacity(mapRunTimerConfig.value?.statsBackgroundOpacity ?? 75) / 100
      const textOpacity = clampOpacity(mapRunTimerConfig.value?.statsTextOpacity ?? 100) / 100
      const buttonOpacity = Math.min(1, backgroundOpacity + ((1 - backgroundOpacity) * 0.35))
      return {
        backgroundColor: `rgba(31, 41, 55, ${buttonOpacity})`,
        color: `rgba(254, 202, 202, ${textOpacity})`,
        borderColor: `rgba(248, 113, 113, ${Math.min(1, buttonOpacity + 0.18)})`
      }
    })

    const { t } = useI18n()

    function deleteButtonStyle (progress: number) {
      return {
        ...buttonStyle.value,
        '--delete-hold-progress': `${Math.max(0, Math.min(100, progress))}%`
      }
    }

    function showRunDelete (runId: number) {
      if (!showWidgetControls.value) return
      clearRunDeleteTimers()
      deleteRunId.value = runId
      deleteHoldProgress.value = 0
      deleteHideTimer = window.setTimeout(() => {
        deleteRunId.value = null
        deleteHoldProgress.value = 0
        deleteHideTimer = null
      }, 3000)
    }

    function beginRunDelete (run: MapRunStatsRecentRun) {
      showRunDelete(run.id)
      if (deleteHideTimer != null) {
        window.clearTimeout(deleteHideTimer)
        deleteHideTimer = null
      }

      const startedAt = window.performance.now()
      const durationMs = 1000
      deleteHoldTimer = window.setInterval(() => {
        const progress = Math.min(100, ((window.performance.now() - startedAt) / durationMs) * 100)
        deleteHoldProgress.value = progress
        if (progress < 100) return

        cancelRunDeleteHold()
        deleteRunId.value = null
        MainProcess.sendEvent({
          name: 'CLIENT->MAIN::map-run-delete' as any,
          payload: {
            runId: run.id,
            areaId: run.areaId,
            areaLevel: run.areaLevel
          }
        } as any)
      }, 30)
    }

    function cancelRunDeleteHold () {
      if (deleteHoldTimer != null) {
        window.clearInterval(deleteHoldTimer)
        deleteHoldTimer = null
      }
      deleteHoldProgress.value = 0
    }

    function clearRunDeleteTimers () {
      if (deleteHideTimer != null) {
        window.clearTimeout(deleteHideTimer)
        deleteHideTimer = null
      }
      if (deleteHoldTimer != null) {
        window.clearInterval(deleteHoldTimer)
        deleteHoldTimer = null
      }
    }

    return {
      t,
      stats,
      showAverage,
      showBest,
      showRecent,
      visibleRecentRuns,
      hasVisibleStats,
      wrapperStyle,
      showWidgetControls,
      deleteRunId,
      deleteHoldProgress,
      deleteButtonStyle,
      showRunDelete,
      beginRunDelete,
      cancelRunDeleteHold,
      formatTime,
    }
  }
})

function clampOpacity (value: number): number {
  const next = Math.floor(Number.isFinite(value) ? value : 100)
  return Math.max(0, Math.min(100, next))
}

function formatTime (millis: number): string {
  const totalMillis = Math.max(0, Math.floor(millis))
  const minutes = Math.floor(totalMillis / 60000)
  const seconds = Math.floor((totalMillis % 60000) / 1000)
  const milliseconds = totalMillis % 1000
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`
}
</script>

<style lang="postcss" module>
.wrapper {
  min-width: 12rem;
  @apply rounded px-3 py-2 text-sm shadow;
  text-shadow: 0 1px 3px rgb(0, 0, 0);
}

.title {
  color: rgba(229, 231, 235, var(--map-run-stats-text-opacity, 1));
  @apply flex items-center justify-between gap-3 text-xs mb-1;
}

.area {
  color: rgba(156, 163, 175, var(--map-run-stats-text-opacity, 1));
}

.body {
  @apply flex flex-col gap-1;
}

.row {
  @apply flex items-center justify-between gap-4;
}

.recentTime {
  @apply ml-auto;
}

.recent {
  @apply mt-1 pt-1 border-t border-gray-500/40;
}

.recentTitle {
  color: rgba(156, 163, 175, var(--map-run-stats-text-opacity, 1));
  @apply text-xs mb-1;
}

.empty {
  color: rgba(156, 163, 175, var(--map-run-stats-text-opacity, 1));
  @apply text-xs;
}

.deleteButton {
  position: relative;
  overflow: hidden;
  @apply rounded px-2 py-1 text-xs border select-none;
}

.deleteButton::before {
  content: '';
  position: absolute;
  inset: 0;
  width: var(--delete-hold-progress, 0%);
  background: rgba(248, 113, 113, 0.34);
  pointer-events: none;
}
</style>
