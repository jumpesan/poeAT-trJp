<template>
  <widget
    :config="config"
    move-handles="center"
    :readonly="true"
    :removable="false"
    :hideable="true">
    <div :class="[$style.wrapper, 'font-poe']" :style="wrapperStyle">
      <div :class="$style.title">
        <span>{{ t('snapshot_values.title') }}</span>
        <div :class="$style.titleActions">
          <span v-if="snapshotRunning" :class="$style.loadingIndicator" :title="t('snapshot_values.taking_snapshot')">
            <span :class="$style.loadingSpinner"></span>
            <span :class="$style.loadingText">{{ t('snapshot_values.taking_snapshot') }}</span>
          </span>
          <button v-if="showWidgetControls" :class="$style.refreshButton" :style="buttonStyle" @click="refresh">{{ t('snapshot_values.refresh') }}</button>
        </div>
      </div>

      <transition name="snapshot-values-toast">
        <div v-if="toastMessage" :class="[$style.toast, toastKind === 'error' ? $style.toastError : $style.toastSuccess]">
          {{ toastMessage }}
        </div>
      </transition>

      <div v-if="message" :class="[$style.message, messageKind === 'error' ? $style.error : '']">
        {{ message }}
      </div>

      <div v-if="compareMode" :class="$style.compareToolbar">
        <span>{{ t('snapshot_values.compare_select') }}</span>
        <button v-if="showWidgetControls" :class="$style.toolbarButton" :style="buttonStyle" @click="cancelCompare">{{ t('snapshot_values.cancel') }}</button>
      </div>

      <div v-if="compareResult" :class="$style.compareResult">
        <button :class="$style.compareSummaryHeader" @click="toggleCompareResult">
          <span :class="$style.compareSummaryLeft">
            <span :class="$style.compareExpandIcon">{{ compareResultExpanded ? '▼' : '▶' }}</span>
            <span :class="$style.compareTitle">
              {{ compareResult.olderSnapshot?.snapshot_at }} → {{ compareResult.newerSnapshot?.snapshot_at }}
            </span>
          </span>
          <span :class="[$style.value, compareTotalDivineValue >= 0 ? $style.gain : $style.loss]">
            {{ formatSignedDivineValue(compareTotalDivineValue) }} div
          </span>
        </button>
        <div v-if="compareResultExpanded" :class="$style.compareSummaryList">
          <div
            v-for="row in compareResult.summaries"
            :key="`${row.location_kind}:${row.location_name}`"
            :class="$style.compareRow">
            <span :class="$style.location">{{ formatCompareLocation(row) }}</span>
            <span :class="[$style.value, row.delta_divine_value >= 0 ? $style.gain : $style.loss]">
              {{ formatSignedDivineValue(row.delta_divine_value) }} div
            </span>
          </div>
        </div>
      </div>

      <div v-if="snapshots.length > 0" :class="$style.list">
        <div
          v-for="snapshot in snapshots"
          :key="snapshot.snapshot_id"
          :class="[
            $style.snapshotBlock,
            selectedSnapshotIds.has(snapshot.snapshot_id) ? $style.selectedSnapshot : ''
          ]"
          @contextmenu.prevent="showSnapshotDelete(snapshot.snapshot_id)">
          <div :class="$style.snapshotHeader">
            <button
              :class="$style.expandButton"
              :disabled="compareMode"
              @click="toggle(snapshot.snapshot_id)">
              {{ expandedSnapshotIds.has(snapshot.snapshot_id) ? '▼' : '▶' }}
            </button>
            <button
              v-if="compareMode && showWidgetControls"
              :class="$style.selectButton"
              @click="selectForCompare(snapshot.snapshot_id)">
              {{ selectedSnapshotIds.has(snapshot.snapshot_id) ? '✓' : '○' }}
            </button>
            <span :class="$style.snapshotTime">{{ snapshot.snapshot_at }}</span>
            <span
              v-if="shouldShowDivineDelta(snapshot.delta_divine_value)"
              :class="[$style.snapshotDelta, isDivineDeltaGain(snapshot.delta_divine_value) ? $style.gain : $style.loss]">
              {{ formatSignedDivineValue(snapshot.delta_divine_value) }} div
            </span>
            <span
              v-if="typeof snapshot.map_count === 'number' && snapshot.map_count > 0"
              :class="$style.mapCount">
              {{ t('snapshot_values.map_count', { count: snapshot.map_count }) }}
            </span>
            <button v-if="showWidgetControls" :class="$style.compareButton" :style="buttonStyle" :title="t('snapshot_values.compare')" @click="startCompare(snapshot.snapshot_id)">
              <i class="fas fa-exchange-alt"></i>
            </button>
            <button
              v-if="showWidgetControls && deleteSnapshotId === snapshot.snapshot_id"
              :class="$style.deleteButton"
              :style="deleteButtonStyle(deleteHoldProgress)"
              @click.stop.prevent
              @pointerdown.stop.prevent="beginSnapshotDelete(snapshot.snapshot_id)"
              @pointerup.stop.prevent="cancelSnapshotDeleteHold"
              @pointerleave.stop.prevent="cancelSnapshotDeleteHold"
              @pointercancel.stop.prevent="cancelSnapshotDeleteHold">
              {{ t('widget.delete') }}
            </button>
          </div>

          <div v-if="expandedSnapshotIds.has(snapshot.snapshot_id) && !compareMode" :class="$style.summaryList">
            <div
              v-if="typeof snapshot.gold_amount === 'number'"
              :class="[$style.summaryRow, $style.goldRow]">
              <span :class="$style.location">{{ t('snapshot_values.gold') }}</span>
              <span :class="$style.value">{{ formatInteger(snapshot.gold_amount) }}</span>
              <span
                v-if="typeof snapshot.delta_gold_amount === 'number' && snapshot.delta_gold_amount !== 0"
                :class="[$style.summaryDelta, snapshot.delta_gold_amount >= 0 ? $style.gain : $style.loss]">
                {{ formatSignedInteger(snapshot.delta_gold_amount) }}
              </span>
              <span :class="$style.count"></span>
            </div>
            <div
              v-for="summary in summariesBySnapshotId.get(snapshot.snapshot_id) ?? []"
              :key="`${summary.snapshot_id}:${summary.location_kind}:${summary.location_name}`"
              :class="$style.summaryRow">
              <span :class="$style.location">{{ formatLocation(summary) }}</span>
              <span :class="$style.value">{{ formatDivineValue(summary.total_divine_value) }} div</span>
              <span
                v-if="shouldShowDivineDelta(summary.delta_divine_value)"
                :class="[$style.summaryDelta, isDivineDeltaGain(summary.delta_divine_value) ? $style.gain : $style.loss]">
                {{ formatSignedDivineValue(summary.delta_divine_value) }}
              </span>
              <span :class="$style.count">{{ summary.priced_item_count }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-else :class="$style.empty">
        {{ t('snapshot_values.empty') }}
      </div>
    </div>
  </widget>
</template>

<script lang="ts">
import { computed, defineComponent, inject, onMounted, onUnmounted, PropType, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Widget from '../overlay/Widget.vue'
import { MainProcess } from '@/web/background/IPC'
import { AppConfig } from '@/web/Config'
import { SnapshotValuesWidget, WidgetManager, WidgetSpec } from '../overlay/interfaces'

type SnapshotValueOverviewSnapshot = {
  snapshot_id: number
  snapshot_at: string
  previous_snapshot_id?: number | null
  delta_chaos_value?: number | null
  delta_divine_value?: number | null
  gold_amount?: number | null
  delta_gold_amount?: number | null
  map_count?: number | null
}

type SnapshotValueOverviewSummary = {
  snapshot_id: number
  location_kind: string
  location_name: string
  total_chaos_value: number
  total_divine_value: number
  delta_chaos_value?: number | null
  delta_divine_value?: number | null
  priced_item_count: number
  price_fetched_at?: string | null
}

type SnapshotValueOverviewResult = {
  ok: boolean
  snapshots?: SnapshotValueOverviewSnapshot[]
  summaries?: SnapshotValueOverviewSummary[]
  error?: string
}

type SnapshotValueComparisonSummary = {
  location_kind: string
  location_name: string
  older_total_divine_value: number
  newer_total_divine_value: number
  delta_divine_value: number
  older_total_chaos_value: number
  newer_total_chaos_value: number
  delta_chaos_value: number
  older_priced_item_count: number
  newer_priced_item_count: number
}

type SnapshotValueComparisonResult = {
  ok: boolean
  olderSnapshot?: SnapshotValueOverviewSnapshot | null
  newerSnapshot?: SnapshotValueOverviewSnapshot | null
  summaries?: SnapshotValueComparisonSummary[]
  error?: string
}

export default defineComponent({
  widget: {
    type: 'snapshot-values',
    instances: 'single',
    trNameKey: 'snapshot_values.title',
    initInstance: (): SnapshotValuesWidget => {
      return {
        wmId: 0,
        wmType: 'snapshot-values',
        wmTitle: '{icon=fa-coins}',
        wmWants: 'hide',
        wmZorder: null,
        wmFlags: [],
        anchor: {
          pos: 'tc',
          x: 50,
          y: 18
        }
      }
    }
  } satisfies WidgetSpec,
  components: { Widget },
  props: {
    config: {
      type: Object as PropType<SnapshotValuesWidget>,
      required: true
    }
  },
  setup (props) {
    const wm = inject<WidgetManager>('wm')!
    const { t } = useI18n()
    const snapshots = ref<SnapshotValueOverviewSnapshot[]>([])
    const summaries = ref<SnapshotValueOverviewSummary[]>([])
    const expandedSnapshotIds = ref(new Set<number>())
    const compareMode = ref(false)
    const selectedSnapshotIds = ref(new Set<number>())
    const compareResult = ref<{
      olderSnapshot: SnapshotValueOverviewSnapshot | null
      newerSnapshot: SnapshotValueOverviewSnapshot | null
      summaries: SnapshotValueComparisonSummary[]
    } | null>(null)
    const compareResultExpanded = ref(false)
    const message = ref('')
    const messageKind = ref<'info' | 'error'>('info')
    const snapshotRunning = ref(false)
    const toastMessage = ref('')
    const toastKind = ref<'success' | 'error'>('success')
    let toastTimer: ReturnType<typeof window.setTimeout> | null = null
    const deleteSnapshotId = ref<number | null>(null)
    const deleteHoldProgress = ref(0)
    let deleteHideTimer: ReturnType<typeof window.setTimeout> | null = null
    let deleteHoldTimer: ReturnType<typeof window.setInterval> | null = null

    if (props.config.wmFlags[0] === 'uninitialized') {
      props.config.anchor = {
        pos: 'tc',
        x: 50,
        y: 18
      }
    }

    if (props.config.anchor.pos === 'cc' && props.config.anchor.x === 50 && props.config.anchor.y === 42) {
      props.config.anchor = {
        pos: 'tc',
        x: 50,
        y: 18
      }
    }

    const summariesBySnapshotId = computed(() => {
      const map = new Map<number, SnapshotValueOverviewSummary[]>()
      for (const summary of summaries.value) {
        const rows = map.get(summary.snapshot_id) ?? []
        rows.push(summary)
        map.set(summary.snapshot_id, rows)
      }
      return map
    })

    const compareTotalDivineValue = computed(() => {
      if (!compareResult.value) return 0
      return compareResult.value.summaries.reduce((sum, row) => sum + row.delta_divine_value, 0)
    })

    const wrapperStyle = computed(() => {
      const backgroundOpacity = clampPercent(AppConfig().stashCheck?.snapshotValuesBackgroundOpacity ?? 78) / 100
      const textOpacity = clampPercent(AppConfig().stashCheck?.snapshotValuesTextOpacity ?? 100) / 100
      return {
        backgroundColor: `rgba(0, 0, 0, ${backgroundOpacity})`,
        color: `rgba(255, 255, 255, ${textOpacity})`,
        '--snapshot-values-text-opacity': String(textOpacity)
      }
    })

    const buttonStyle = computed(() => {
      const backgroundOpacity = clampPercent(AppConfig().stashCheck?.snapshotValuesBackgroundOpacity ?? 78) / 100
      const textOpacity = clampPercent(AppConfig().stashCheck?.snapshotValuesTextOpacity ?? 100) / 100
      const buttonOpacity = Math.min(1, backgroundOpacity + ((1 - backgroundOpacity) * 0.35))
      const borderOpacity = Math.min(1, buttonOpacity + 0.18)
      return {
        backgroundColor: `rgba(31, 41, 55, ${buttonOpacity})`,
        borderColor: `rgba(148, 163, 184, ${borderOpacity})`,
        color: `rgba(229, 231, 235, ${textOpacity})`
      }
    })

    const showWidgetControls = computed(() => wm.active.value)

    const overviewController = MainProcess.onEvent('MAIN->CLIENT::snapshot-value-overview' as any, (payload: any) => {
      const result = payload as SnapshotValueOverviewResult
      if (!result.ok) {
        messageKind.value = 'error'
        message.value = t('snapshot_values.failed', { error: result.error ?? 'unknown error' })
        return
      }

      message.value = ''
      snapshots.value = result.snapshots ?? []
      summaries.value = result.summaries ?? []

      const availableIds = new Set(snapshots.value.map(snapshot => snapshot.snapshot_id))
      expandedSnapshotIds.value = new Set(
        [...expandedSnapshotIds.value].filter(snapshotId => availableIds.has(snapshotId))
      )
    })

    const compareController = MainProcess.onEvent('MAIN->CLIENT::snapshot-value-compare' as any, (payload: any) => {
      const result = payload as SnapshotValueComparisonResult
      if (!result.ok) {
        messageKind.value = 'error'
        message.value = t('snapshot_values.compare_failed', { error: result.error ?? 'unknown error' })
        return
      }

      compareResult.value = {
        olderSnapshot: result.olderSnapshot ?? null,
        newerSnapshot: result.newerSnapshot ?? null,
        summaries: result.summaries ?? []
      }
      compareResultExpanded.value = false
      compareMode.value = false
      selectedSnapshotIds.value = new Set()
      message.value = ''
    })

    const snapshotStateController = MainProcess.onEvent('MAIN->CLIENT::poe-snapshot-owned-items-state' as any, (payload: any) => {
      snapshotRunning.value = payload?.running === true
    })

    const snapshotResultController = MainProcess.onEvent('MAIN->CLIENT::poe-snapshot-owned-items-result' as any, (payload: any) => {
      snapshotRunning.value = false
      if (payload?.ok === true) {
        refresh()
        showToast(t('snapshot_values.snapshot_complete'), 'success')
        return
      }

      if (payload?.ok === false) {
        showToast(t('snapshot_values.snapshot_failed'), 'error')
      }
    })

    const deleteResultController = MainProcess.onEvent('MAIN->CLIENT::snapshot-value-delete-result' as any, (payload: any) => {
      if (payload?.ok === true) {
        deleteSnapshotId.value = null
        deleteHoldProgress.value = 0
        refresh()
        return
      }

      messageKind.value = 'error'
      message.value = String(payload?.error ?? 'delete failed')
    })

    MainProcess.sendEvent({
      name: 'CLIENT->MAIN::snapshot-values-widget-ready' as any,
      payload: { mounted: true }
    } as any)

    onMounted(() => {
      refresh()
    })

    onUnmounted(() => {
      MainProcess.sendEvent({
        name: 'CLIENT->MAIN::snapshot-values-widget-ready' as any,
        payload: { mounted: false }
      } as any)

      overviewController.abort()
      compareController.abort()
      snapshotStateController.abort()
      snapshotResultController.abort()
      deleteResultController.abort()
      clearSnapshotDeleteTimers()
      if (toastTimer != null) {
        window.clearTimeout(toastTimer)
        toastTimer = null
      }
    })

    function deleteButtonStyle (progress: number) {
      return {
        ...buttonStyle.value,
        '--delete-hold-progress': `${Math.max(0, Math.min(100, progress))}%`
      }
    }

    function showSnapshotDelete (snapshotId: number) {
      if (!showWidgetControls.value) return
      clearSnapshotDeleteTimers()
      deleteSnapshotId.value = snapshotId
      deleteHoldProgress.value = 0
      deleteHideTimer = window.setTimeout(() => {
        deleteSnapshotId.value = null
        deleteHoldProgress.value = 0
        deleteHideTimer = null
      }, 3000)
    }

    function beginSnapshotDelete (snapshotId: number) {
      showSnapshotDelete(snapshotId)
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

        cancelSnapshotDeleteHold()
        deleteSnapshotId.value = null
        MainProcess.sendEvent({
          name: 'CLIENT->MAIN::snapshot-value-delete' as any,
          payload: { snapshotId }
        } as any)
      }, 30)
    }

    function cancelSnapshotDeleteHold () {
      if (deleteHoldTimer != null) {
        window.clearInterval(deleteHoldTimer)
        deleteHoldTimer = null
      }
      deleteHoldProgress.value = 0
    }

    function clearSnapshotDeleteTimers () {
      if (deleteHideTimer != null) {
        window.clearTimeout(deleteHideTimer)
        deleteHideTimer = null
      }
      if (deleteHoldTimer != null) {
        window.clearInterval(deleteHoldTimer)
        deleteHoldTimer = null
      }
    }

    function showToast (text: string, kind: 'success' | 'error') {
      toastMessage.value = text
      toastKind.value = kind

      if (toastTimer != null) {
        window.clearTimeout(toastTimer)
      }

      toastTimer = window.setTimeout(() => {
        toastMessage.value = ''
        toastTimer = null
      }, 3200)
    }

    function refresh () {
      MainProcess.sendEvent({
        name: 'CLIENT->MAIN::snapshot-value-overview' as any,
        payload: { limit: 20 }
      } as any)
    }

    function toggle (snapshotId: number) {
      const next = new Set(expandedSnapshotIds.value)
      if (next.has(snapshotId)) {
        next.delete(snapshotId)
      } else {
        next.add(snapshotId)
      }
      expandedSnapshotIds.value = next
    }

    function startCompare (snapshotId: number) {
      compareMode.value = true
      compareResult.value = null
      compareResultExpanded.value = false
      expandedSnapshotIds.value = new Set()
      selectedSnapshotIds.value = new Set([snapshotId])
      message.value = ''
    }

    function cancelCompare () {
      compareMode.value = false
      selectedSnapshotIds.value = new Set()
    }

    function toggleCompareResult () {
      compareResultExpanded.value = !compareResultExpanded.value
    }

    function selectForCompare (snapshotId: number) {
      const next = new Set(selectedSnapshotIds.value)
      if (next.has(snapshotId)) {
        next.delete(snapshotId)
      } else if (next.size < 2) {
        next.add(snapshotId)
      } else {
        next.clear()
        next.add(snapshotId)
      }

      selectedSnapshotIds.value = next

      if (next.size === 2) {
        const ids = [...next]
        MainProcess.sendEvent({
          name: 'CLIENT->MAIN::snapshot-value-compare' as any,
          payload: {
            firstSnapshotId: ids[0],
            secondSnapshotId: ids[1]
          }
        } as any)
      }
    }

    // Normal overview deltas are intentionally filtered in the renderer to keep
    // the snapshot list lightweight. Explicit comparison mode still uses the
    // main-process SQL path for more controlled comparison queries.
    const DIVINE_DELTA_DISPLAY_EPSILON = 0.005

    function shouldShowDivineDelta (value: number | null | undefined): boolean {
      return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) >= DIVINE_DELTA_DISPLAY_EPSILON
    }

    function formatDivineValue (value: number): string {
      if (!Number.isFinite(value)) return '0'
      if (value >= 100) return value.toFixed(1)
      if (value >= 10) return value.toFixed(2)
      if (value >= 1) return value.toFixed(3)
      return value.toFixed(4)
    }

    function isDivineDeltaGain (value: number | null | undefined): boolean {
      return typeof value === 'number' && value >= 0
    }

    function formatSignedDivineValue (value: number | null | undefined): string {
      const safeValue = typeof value === 'number' && Number.isFinite(value) ? value : 0
      const formatted = Math.abs(safeValue).toFixed(2)
      return `${safeValue >= 0 ? '+' : '-'}${formatted}`
    }

    function formatInteger (value: number): string {
      return Math.trunc(Number.isFinite(value) ? value : 0).toLocaleString()
    }

    function formatSignedInteger (value: number): string {
      const safeValue = Math.trunc(Number.isFinite(value) ? value : 0)
      return `${safeValue >= 0 ? '+' : '-'}${Math.abs(safeValue).toLocaleString()}`
    }

    function formatLocation (summary: SnapshotValueOverviewSummary): string {
      const kind = summary.location_kind || '-'
      const name = summary.location_name || '-'
      return `${kind} / ${name}`
    }

    function formatCompareLocation (summary: SnapshotValueComparisonSummary): string {
      const kind = summary.location_kind || '-'
      const name = summary.location_name || '-'
      return `${kind} / ${name}`
    }

    return {
      t,
      snapshots,
      summariesBySnapshotId,
      expandedSnapshotIds,
      compareMode,
      selectedSnapshotIds,
      compareResult,
      compareResultExpanded,
      compareTotalDivineValue,
      wrapperStyle,
      buttonStyle,
      showWidgetControls,
      message,
      messageKind,
      snapshotRunning,
      toastMessage,
      toastKind,
      deleteSnapshotId,
      deleteHoldProgress,
      deleteButtonStyle,
      showSnapshotDelete,
      beginSnapshotDelete,
      cancelSnapshotDeleteHold,
      refresh,
      toggle,
      startCompare,
      cancelCompare,
      selectForCompare,
      toggleCompareResult,
      shouldShowDivineDelta,
      formatDivineValue,
      formatSignedDivineValue,
      isDivineDeltaGain,
      formatInteger,
      formatSignedInteger,
      formatLocation,
      formatCompareLocation,
    }
  }
})
function clampPercent (value: number): number {
  const next = Math.floor(Number.isFinite(value) ? value : 78)
  return Math.max(0, Math.min(100, next))
}

</script>

<style lang="postcss" module>
.wrapper {
  min-width: 22rem;
  max-width: 32rem;
  max-height: 24rem;
  @apply rounded px-3 py-2 text-sm shadow overflow-hidden;
  text-shadow: 0 1px 3px rgb(0, 0, 0);
}

.title {
  @apply flex items-center justify-between gap-3 text-xs text-gray-200 mb-2;
}

.titleActions {
  @apply flex items-center justify-end gap-2;
}

.loadingIndicator {
  @apply inline-flex items-center justify-end gap-1 text-xs text-gray-100;
}

.loadingSpinner {
  width: 0.9rem;
  height: 0.9rem;
  border: 2px dotted rgba(255, 255, 255, var(--snapshot-values-text-opacity, 1));
  border-radius: 9999px;
  animation: snapshot-values-spin 0.9s linear infinite;
}

.loadingText {
  color: rgba(229, 231, 235, var(--snapshot-values-text-opacity, 1));
}

.toast {
  position: fixed;
  top: 1rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10000;
  @apply rounded px-4 py-2 text-sm shadow-lg border;
}

.toastSuccess {
  background: rgba(17, 24, 39, 0.94);
  border-color: rgba(134, 239, 172, 0.75);
  color: rgba(220, 252, 231, 1);
}

.toastError {
  background: rgba(127, 29, 29, 0.94);
  border-color: rgba(252, 165, 165, 0.78);
  color: rgba(254, 226, 226, 1);
}

.refreshButton {
  @apply rounded px-2 py-1 text-xs bg-gray-800 text-gray-200 border border-gray-600;
}

.message {
  @apply text-xs text-gray-300 mb-2;
}

.error {
  @apply text-red-300;
}


.compareToolbar {
  @apply flex items-center justify-between gap-2 text-xs text-gray-300 mb-2 rounded px-2 py-1 bg-gray-800/70 border border-gray-600/60;
}

.toolbarButton {
  @apply rounded px-2 py-1 text-xs bg-gray-900 text-gray-200 border border-gray-600;
}

.compareResult {
  @apply mb-2 rounded border border-gray-600/60 bg-gray-900/50 px-2 py-1;
}

.compareSummaryHeader {
  @apply flex w-full items-center justify-between gap-2 border-0 bg-transparent p-0 text-left text-gray-200 cursor-pointer;
}

.compareSummaryLeft {
  @apply flex min-w-0 flex-1 items-center gap-2;
}

.compareExpandIcon {
  width: 1.2rem;
  @apply shrink-0 text-gray-100;
}

.compareTitle {
  @apply min-w-0 flex-1 truncate text-xs text-gray-400;
}

.compareSummaryList {
  @apply mt-1 pl-5;
}

.compareRow {
  @apply grid items-center gap-2 py-1 text-gray-200;
  grid-template-columns: minmax(0, 1fr) auto;
}

.gain {
  color: rgba(134, 239, 172, var(--snapshot-values-text-opacity, 1));
}

.loss {
  color: rgba(252, 165, 165, var(--snapshot-values-text-opacity, 1));
}

.selectedSnapshot {
  background: rgba(59, 130, 246, 0.22);
  outline: 1px solid rgba(147, 197, 253, 0.72);
  outline-offset: -1px;
}

.selectedSnapshot .snapshotTime {
  color: rgba(219, 234, 254, var(--snapshot-values-text-opacity, 1));
}

.selectedSnapshot .selectButton {
  color: rgba(219, 234, 254, var(--snapshot-values-text-opacity, 1));
}

.selectButton {
  width: 1.3rem;
  @apply p-0 border-0 bg-transparent text-blue-200 cursor-pointer text-center;
}

.list {
  max-height: 20rem;
  overflow-y: auto;
  @apply pr-1;
}

.snapshotBlock + .snapshotBlock {
  border-top: 1px solid rgba(148, 163, 184, 0.28);
}

.snapshotHeader {
  @apply flex items-center gap-2 py-1;
}

.expandButton {
  width: 1.5rem;
  @apply p-0 border-0 bg-transparent text-gray-100 cursor-pointer text-left;
}

.expandButton:disabled {
  @apply text-gray-600 cursor-not-allowed;
}

.snapshotTime {
  @apply flex-1 truncate;
}

.snapshotDelta {
  @apply shrink-0 text-xs font-semibold;
}

.mapCount {
  color: rgba(209, 213, 219, var(--snapshot-values-text-opacity, 1));
  @apply shrink-0 text-xs;
}

.summaryDelta {
  @apply text-xs font-semibold;
}

.compareButton {
  @apply rounded px-2 py-1 text-xs bg-gray-800 text-gray-200 border border-gray-600;
}

.deleteButton {
  position: relative;
  overflow: hidden;
  @apply rounded px-2 py-1 text-xs bg-gray-800 text-red-200 border border-red-400/60;
}

.deleteButton::before {
  content: '';
  position: absolute;
  inset: 0;
  width: var(--delete-hold-progress, 0%);
  background: rgba(248, 113, 113, 0.34);
  pointer-events: none;
}

.deleteButton {
  @apply select-none;
}

.summaryList {
  @apply pb-2 pl-6;
}

.summaryRow {
  @apply grid items-center gap-2 py-1 text-gray-200;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
}

.goldRow {
  color: rgba(254, 240, 138, var(--snapshot-values-text-opacity, 1));
}

.location {
  @apply truncate;
}

.value {
  @apply font-semibold;
}

.count {
  color: rgba(156, 163, 175, var(--snapshot-values-text-opacity, 1));
  @apply text-xs;
}

.empty {
  color: rgba(156, 163, 175, var(--snapshot-values-text-opacity, 1));
  @apply text-xs;
}

@keyframes snapshot-values-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

:global(.snapshot-values-toast-enter-active),
:global(.snapshot-values-toast-leave-active) {
  transition: transform 0.22s ease, opacity 0.22s ease;
}

:global(.snapshot-values-toast-enter-from),
:global(.snapshot-values-toast-leave-to) {
  opacity: 0;
  transform: translate(-50%, -1rem);
}
</style>
