<template>
  <div class="flex flex-col gap-4 p-2 max-w-md">
    <label class="flex items-center gap-2">
      <input v-model="showBestTimeOnEnter" type="checkbox">
      <span>{{ t(':show_best_time_on_enter') }}</span>
    </label>

    <label class="flex items-center gap-2">
      <input v-model="showAverageTimeOnEnter" type="checkbox">
      <span>{{ t(':show_average_time_on_enter') }}</span>
    </label>

    <label class="flex items-center gap-2">
      <span>{{ t(':recent_runs_count') }}</span>
      <input
        v-model.number="recentRunsCount"
        type="number"
        min="0"
        step="1"
        class="rounded bg-gray-900 px-1 block w-16 font-poe text-center"
      >
    </label>

    <p class="text-gray-500 text-sm leading-snug">
      {{ t(':recent_runs_count_help') }}
    </p>

    <div class="flex flex-col gap-2">
      <label class="flex items-center justify-between gap-3">
        <span>{{ t(':stats_background_opacity') }}</span>
        <span class="text-gray-500 w-10 text-right">{{ statsBackgroundOpacity }}%</span>
      </label>
      <input
        v-model.number="statsBackgroundOpacity"
        type="range"
        min="0"
        max="100"
        step="1"
        class="w-full"
      >
    </div>

    <div class="flex flex-col gap-2">
      <label class="flex items-center justify-between gap-3">
        <span>{{ t(':stats_text_opacity') }}</span>
        <span class="text-gray-500 w-10 text-right">{{ statsTextOpacity }}%</span>
      </label>
      <input
        v-model.number="statsTextOpacity"
        type="range"
        min="0"
        max="100"
        step="1"
        class="w-full"
      >
    </div>

    <div class="flex flex-col gap-2">
      <span class="text-gray-500 text-sm">{{ t(':opacity_preview') }}</span>
      <div
        class="rounded px-3 py-2 font-poe text-sm"
        :style="previewStyle"
      >
        <div>{{ t(':name') }}</div>
        <div>Avg 02:41.320 / Best 01:58.042</div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
export default {
  name: 'map_timer.name'
}
</script>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18nNs } from '@/web/i18n'
import { configProp } from '../settings/utils.js'

const props = defineProps(configProp())
const { t } = useI18nNs('map_timer')

props.config.mapRunTimer ??= {
  showBestTimeOnEnter: false,
  showAverageTimeOnEnter: false,
  recentRunsCount: 0,
  statsBackgroundOpacity: 75,
  statsTextOpacity: 100
}

const showBestTimeOnEnter = computed({
  get: () => props.config.mapRunTimer?.showBestTimeOnEnter ?? false,
  set: (value: boolean) => {
    props.config.mapRunTimer ??= {
      showBestTimeOnEnter: false,
      showAverageTimeOnEnter: false,
      recentRunsCount: 0,
      statsBackgroundOpacity: 75,
      statsTextOpacity: 100
    }
    props.config.mapRunTimer.showBestTimeOnEnter = value
  }
})

const showAverageTimeOnEnter = computed({
  get: () => props.config.mapRunTimer?.showAverageTimeOnEnter ?? false,
  set: (value: boolean) => {
    props.config.mapRunTimer ??= {
      showBestTimeOnEnter: false,
      showAverageTimeOnEnter: false,
      recentRunsCount: 0,
      statsBackgroundOpacity: 75,
      statsTextOpacity: 100
    }
    props.config.mapRunTimer.showAverageTimeOnEnter = value
  }
})

const recentRunsCount = computed({
  get: () => props.config.mapRunTimer?.recentRunsCount ?? 0,
  set: (value: number) => {
    props.config.mapRunTimer ??= {
      showBestTimeOnEnter: false,
      showAverageTimeOnEnter: false,
      recentRunsCount: 0,
      statsBackgroundOpacity: 75,
      statsTextOpacity: 100
    }
    props.config.mapRunTimer.recentRunsCount = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0))
  }
})

const statsBackgroundOpacity = computed({
  get: () => props.config.mapRunTimer?.statsBackgroundOpacity ?? 75,
  set: (value: number) => {
    props.config.mapRunTimer ??= {
      showBestTimeOnEnter: false,
      showAverageTimeOnEnter: false,
      recentRunsCount: 0,
      statsBackgroundOpacity: 75,
      statsTextOpacity: 100
    }
    props.config.mapRunTimer.statsBackgroundOpacity = clampOpacity(value, 75)
  }
})

const statsTextOpacity = computed({
  get: () => props.config.mapRunTimer?.statsTextOpacity ?? 100,
  set: (value: number) => {
    props.config.mapRunTimer ??= {
      showBestTimeOnEnter: false,
      showAverageTimeOnEnter: false,
      recentRunsCount: 0,
      statsBackgroundOpacity: 75,
      statsTextOpacity: 100
    }
    props.config.mapRunTimer.statsTextOpacity = clampOpacity(value, 100)
  }
})

const previewStyle = computed(() => ({
  backgroundColor: `rgba(0, 0, 0, ${statsBackgroundOpacity.value / 100})`,
  color: `rgba(255, 255, 255, ${statsTextOpacity.value / 100})`
}))

function clampOpacity (value: number, fallback: number): number {
  const next = Math.floor(Number.isFinite(value) ? value : fallback)
  return Math.max(0, Math.min(100, next))
}
</script>
