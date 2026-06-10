<template>
  <div class="settings-page">
    <section class="panel">
      <h2>{{ _$.SETTINGS_STASH_CHECK_POE_LOGIN }}</h2>
      <button class="btn" @click="login">{{ _$.SETTINGS_STASH_CHECK_LOGIN }}</button>
      <span class="login-status" :class="{ ok: loggedIn }">
        {{ loggedIn ? _$.SETTINGS_STASH_CHECK_LOGGED_IN : _$.SETTINGS_STASH_CHECK_NOT_LOGGED_IN }}
      </span>
    </section>

    <section class="panel">
      <h2>{{ _$.SETTINGS_STASH_CHECK_POE_NINJA_PRICE }}</h2>

      <p class="snapshot-notice">
        {{ _$.SETTINGS_STASH_CHECK_POE_NINJA_PRICE_NOTICE }}
      </p>

      <div class="snapshot-actions">
        <button
          class="btn"
          :disabled="poeNinjaRefreshing || poeNinjaCooldownRemainingMs > 0 || !props.config.leagueId"
          @click="refreshPoeNinjaPrices"
        >
          {{ poeNinjaRefreshButtonText }}
        </button>
      </div>

      <div class="current">
        {{ _$.SETTINGS_STASH_CHECK_POE_NINJA_LAST_UPDATED }}: {{ poeNinjaLastUpdatedText }}
      </div>

      <div v-if="poeNinjaMessage" class="snapshot-status" :class="{ ok: poeNinjaOk, error: poeNinjaOk === false }">
        {{ poeNinjaMessage }}
      </div>
    </section>

    <section class="panel">
      <h2>{{ _$.SETTINGS_STASH_CHECK_ITEM_SAVE }}</h2>

      <p class="snapshot-notice">
        {{ _$.SETTINGS_STASH_CHECK_SNAPSHOT_NOTICE_SHORT }}
      </p>

      <div class="automation-options">
        <label class="option-row">
          <span>{{ stashCheckT(':auto_snapshot_interval') }}</span>
          <select v-model.number="autoSnapshotIntervalMinutes">
            <option :value="0">{{ stashCheckT(':auto_snapshot_interval_off') }}</option>
            <option :value="15">{{ stashCheckT(':auto_snapshot_interval_15') }}</option>
            <option :value="30">{{ stashCheckT(':auto_snapshot_interval_30') }}</option>
            <option :value="60">{{ stashCheckT(':auto_snapshot_interval_60') }}</option>
          </select>
        </label>
      </div>

      <div class="current">
        {{ _$.SETTINGS_STASH_CHECK_TARGET_CHARACTER }}: {{ currentCharacter }}
      </div>

      <div class="current">
        {{ selectedStashTabCountText }}
      </div>

      <div class="snapshot-actions">
        <button
          class="btn"
          :disabled="snapshotRunning || !hasSnapshotCharacter"
          @click="takeOwnedItemsSnapshot"
        >
          {{ snapshotRunning ? _$.SETTINGS_STASH_CHECK_TAKING_SNAPSHOT : _$.SETTINGS_STASH_CHECK_TAKE_OWNED_ITEMS_SNAPSHOT }}
        </button>
      </div>

      <div v-if="snapshotMessage" class="snapshot-status" :class="{ ok: snapshotOk, error: snapshotOk === false }">
        {{ snapshotMessage }}
      </div>

      <div v-if="lastSnapshotPath" class="snapshot-path">
        {{ _$.SETTINGS_STASH_CHECK_SAVE_PATH }}: {{ lastSnapshotPath }}
      </div>

      <div class="row section-row">
        <button class="btn" @click="refreshCharacters">
          {{ _$.SETTINGS_STASH_CHECK_REFRESH_CHARACTERS }}
        </button>

        <select v-model="selectedCharacterKey">
          <option :value="NO_INVENTORY_CHARACTER_KEY">{{ stashCheckT(':inventory_none') }}</option>
          <option :value="ALL_CHARACTERS_CHARACTER_KEY">{{ stashCheckT(':inventory_all_characters') }}</option>
          <option
            v-for="c in characters"
            :key="`${c.name}:${c.league}`"
            :value="`${c.name}:${c.league}`"
          >
            {{ c.name }} ({{ c.league }})
          </option>
        </select>

        <button class="btn" @click="confirmCharacter">
          {{ _$.SETTINGS_STASH_CHECK_CONFIRM }}
        </button>
      </div>

      <div class="section-row">
        <div class="row">
          <button
            class="btn"
            :disabled="refreshingStashTabs || snapshotRunning || !loggedIn || !props.config.leagueId"
            @click="refreshStashTabs"
          >
            {{ refreshingStashTabs ? _$.SETTINGS_STASH_CHECK_FETCHING_STASH_TABS : _$.SETTINGS_STASH_CHECK_REFRESH_STASH_TABS }}
          </button>

          <button class="btn" :disabled="stashTabs.length === 0" @click="confirmStashTabs">
            {{ _$.SETTINGS_STASH_CHECK_CONFIRM }}
          </button>
        </div>

        <div v-if="stashTabMessage" class="snapshot-status" :class="{ ok: stashTabMessageOk, error: stashTabMessageOk === false }">
          {{ stashTabMessage }}
        </div>

        <h3 class="sub-title">{{ _$.SETTINGS_STASH_CHECK_STASH_TABS }}</h3>

        <div v-if="stashTabs.length > 0" class="bulk-actions">
          <button class="btn small" @click="toggleAllStashTabs">
            {{ _$.SETTINGS_STASH_CHECK_TOGGLE_ALL_STASH_TABS }}
          </button>
          <button class="btn small" @click="toggleBasicStashTabs">
            {{ _$.SETTINGS_STASH_CHECK_TOGGLE_BASIC_STASH_TABS }}
          </button>
          <button class="btn small" @click="toggleSpecialStashTabs">
            {{ _$.SETTINGS_STASH_CHECK_TOGGLE_SPECIAL_STASH_TABS }}
          </button>
        </div>

        <div v-if="stashTabs.length > 0" class="stash-tab-list">
          <label
            v-for="tab in stashTabs"
            :key="tab.id"
            class="stash-tab-row"
          >
            <input
              v-model="selectedStashTabIdsDraft"
              type="checkbox"
              :value="tab.id"
            >
            <span class="stash-tab-name">{{ tab.index }}: {{ tab.name }}</span>
            <span class="stash-tab-type">{{ tab.type }}</span>
          </label>
        </div>

        <div v-else class="empty-list">
          {{ _$.SETTINGS_STASH_CHECK_NO_STASH_TABS }}
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>{{ stashCheckT(':display_settings') }}</h2>

      <div class="opacity-setting">
        <label class="opacity-label">
          <span>{{ mapTimerT(':stats_background_opacity') }}</span>
          <span class="opacity-value">{{ snapshotValuesBackgroundOpacity }}%</span>
        </label>
        <input
          v-model.number="snapshotValuesBackgroundOpacity"
          type="range"
          min="0"
          max="100"
          step="1"
          class="opacity-range"
        >
      </div>

      <div class="opacity-setting">
        <label class="opacity-label">
          <span>{{ mapTimerT(':stats_text_opacity') }}</span>
          <span class="opacity-value">{{ snapshotValuesTextOpacity }}%</span>
        </label>
        <input
          v-model.number="snapshotValuesTextOpacity"
          type="range"
          min="0"
          max="100"
          step="1"
          class="opacity-range"
        >
      </div>

      <div class="opacity-setting">
        <span class="opacity-preview-label">{{ mapTimerT(':opacity_preview') }}</span>
        <div
          class="opacity-preview"
          :style="snapshotValuesOpacityPreviewStyle"
        >
          <div>{{ mapTimerT(':name') }}</div>
          <div>stash / かれんしー！ 72.91 div</div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Host } from '@/web/background/IPC'
import { CLIENT_STRINGS as _$, ITEMS_ITERATOR, type BaseType } from '@/assets/data'
import { saveConfig, type Config } from '@/web/Config'
import { useI18nNs } from '@/web/i18n'

type Character = {
  name: string
  league: string
}

type StashTab = {
  id: string
  name: string
  type: string
  index: number
}

type SnapshotResult = {
  ok: boolean
  savedPath?: string
  itemCount?: number
  inventoryItemCount?: number
  characterInventoryCount?: number
  failedCharacterInventoryCount?: number
  stashItemCount?: number
  fetchedStashTabCount?: number
  stashTabCount?: number
  summaryGroupCount?: number
  error?: string
  errorKind?: 'temporarily-unavailable' | 'request-failed'
  responseStatus?: number
  poeErrorCode?: number
  poeErrorMessage?: string
}

type StashTabsResult = {
  ok: boolean
  tabs?: StashTab[]
  error?: string
  errorKind?: 'temporarily-unavailable' | 'request-failed'
}

type PoeNinjaRefreshResult = {
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

type PoeNinjaStatusResult = {
  ok: boolean
  running: boolean
  cooldownUntil: string | null
  lastSuccessfulFetchAt: string | null
}

type PoeNinjaItemDataRecord = {
  name: string
  refName: string
  namespace?: string
  tradeTag?: string
  exchangeable?: boolean
}

// Treat normal, premium, and quad tabs as user-managed general stash tabs.
// All other tab types are treated as specialized stash tabs.
const BASIC_STASH_TAB_TYPES = new Set([
  'NormalStash',
  'PremiumStash',
  'QuadStash'
])

const props = defineProps<{
  config: Config
}>()

const NO_INVENTORY_CHARACTER_KEY = '__no_inventory__'
const ALL_CHARACTERS_CHARACTER_KEY = '__all_characters__'
const { t: stashCheckT } = useI18nNs('stash_check')
const { t: mapTimerT } = useI18nNs('map_timer')

props.config.stashCheck ??= {}

const characters = ref<Character[]>(props.config.stashCheck.characters ?? [])
const stashTabs = ref<StashTab[]>(props.config.stashCheck.stashTabs ?? [])

const saved = props.config.stashCheck.selectedCharacter
const savedInventoryMode = props.config.stashCheck.inventoryMode

const selectedCharacterKey = ref(
  savedInventoryMode === 'none'
    ? NO_INVENTORY_CHARACTER_KEY
    : savedInventoryMode === 'all'
      ? ALL_CHARACTERS_CHARACTER_KEY
      : saved
        ? `${saved.name}:${saved.league}`
        : ''
)

const selectedStashTabIdsDraft = ref<string[]>(getInitialSelectedStashTabIds())

const currentCharacter = ref(
  savedInventoryMode === 'none'
    ? stashCheckT(':inventory_none')
    : savedInventoryMode === 'all'
      ? stashCheckT(':inventory_all_characters')
      : saved
        ? `${saved.name} (${saved.league})`
        : _$.SETTINGS_STASH_CHECK_UNSELECTED
)

const loggedIn = ref(false)
const snapshotRunning = ref(false)
const snapshotMessage = ref('')
const snapshotOk = ref<boolean | null>(null)
const lastSnapshotPath = ref('')
const refreshingStashTabs = ref(false)
const stashTabMessage = ref('')
const stashTabMessageOk = ref<boolean | null>(null)
const poeNinjaRefreshing = ref(false)
const poeNinjaMessage = ref('')
const poeNinjaOk = ref<boolean | null>(null)
const poeNinjaLastUpdatedAt = ref<string | null>(null)
const poeNinjaCooldownUntil = ref<string | null>(null)
const nowMs = ref(Date.now())
let poeNinjaClockTimer: ReturnType<typeof window.setInterval> | null = null
const POE_SNAPSHOT_TRACE = false

function poeSnapshotTraceLog (...args: unknown[]) {
  if (POE_SNAPSHOT_TRACE) console.log(...args)
}

function poeSnapshotTraceError (...args: unknown[]) {
  if (POE_SNAPSHOT_TRACE) console.error(...args)
}

function clampPercent (value: number, fallback: number): number {
  const next = Math.floor(Number.isFinite(value) ? value : fallback)
  return Math.max(0, Math.min(100, next))
}

function saveStashCheckConfig () {
  saveConfig()
}

let snapshotDebugSeq = 0
let stashTabsDebugSeq = 0

function nextDebugRequestId (prefix: string): string {
  const seq = prefix === 'snapshot' ? ++snapshotDebugSeq : ++stashTabsDebugSeq
  return `${prefix}-${Date.now()}-${seq}`
}

function toPlainCharacter (character: Character | null | undefined): Character | null {
  if (!character) return null

  return {
    name: String(character.name ?? ''),
    league: String(character.league ?? '')
  }
}

function toPlainCharacters (sourceCharacters: Character[]): Character[] {
  return sourceCharacters
    .map((character) => toPlainCharacter(character))
    .filter((character): character is Character => Boolean(character?.name))
}

function toPlainStashTabIds (ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  return ids.map(id => String(id))
}

const autoSnapshotIntervalMinutes = computed({
  get: () => props.config.stashCheck?.autoSnapshotIntervalMinutes ?? 0,
  set: (value: number) => {
    props.config.stashCheck ??= {}
    const allowed = new Set([0, 15, 30, 60])
    props.config.stashCheck.autoSnapshotIntervalMinutes = allowed.has(value) ? value : 0
    saveStashCheckConfig()
  }
})

const snapshotValuesBackgroundOpacity = computed({
  get: () => props.config.stashCheck?.snapshotValuesBackgroundOpacity ?? 78,
  set: (value: number) => {
    props.config.stashCheck ??= {}
    props.config.stashCheck.snapshotValuesBackgroundOpacity = clampPercent(value, 78)
    saveStashCheckConfig()
  }
})

const snapshotValuesTextOpacity = computed({
  get: () => props.config.stashCheck?.snapshotValuesTextOpacity ?? 100,
  set: (value: number) => {
    props.config.stashCheck ??= {}
    props.config.stashCheck.snapshotValuesTextOpacity = clampPercent(value, 100)
    saveStashCheckConfig()
  }
})

const snapshotValuesOpacityPreviewStyle = computed(() => ({
  backgroundColor: `rgba(0, 0, 0, ${snapshotValuesBackgroundOpacity.value / 100})`,
  color: `rgba(255, 255, 255, ${snapshotValuesTextOpacity.value / 100})`
}))

const selectedStashTabCount = computed(() => getSelectedStashTabIdsForSnapshot().length)
const selectedStashTabCountText = computed(() => {
  return formatClientString(_$.SETTINGS_STASH_CHECK_SELECTED_STASH_TAB_COUNT, {
    count: String(selectedStashTabCount.value)
  })
})

const poeNinjaCooldownRemainingMs = computed(() => {
  if (!poeNinjaCooldownUntil.value) return 0
  const cooldownUntil = new Date(poeNinjaCooldownUntil.value).getTime()
  if (!Number.isFinite(cooldownUntil)) return 0
  return Math.max(0, cooldownUntil - nowMs.value)
})

const poeNinjaRefreshButtonText = computed(() => {
  if (poeNinjaRefreshing.value) return _$.SETTINGS_STASH_CHECK_POE_NINJA_REFRESHING
  if (poeNinjaCooldownRemainingMs.value > 0) {
    return formatClientString(_$.SETTINGS_STASH_CHECK_POE_NINJA_COOLDOWN, {
      seconds: String(Math.ceil(poeNinjaCooldownRemainingMs.value / 1000))
    })
  }
  return _$.SETTINGS_STASH_CHECK_POE_NINJA_REFRESH
})

const poeNinjaLastUpdatedText = computed(() => {
  return poeNinjaLastUpdatedAt.value ?? _$.SETTINGS_STASH_CHECK_POE_NINJA_NEVER_UPDATED
})

const hasSnapshotCharacter = computed(() => Boolean(getSnapshotAnchorCharacter()))

function getInitialSelectedStashTabIds (): string[] {
  const savedIds = props.config.stashCheck?.selectedStashTabIds

  if (Array.isArray(savedIds)) {
    return [...savedIds]
  }

  const savedTabs = props.config.stashCheck?.stashTabs ?? []
  return savedTabs.map(tab => tab.id)
}

function getSelectedStashTabIdsForSnapshot (): string[] {
  const savedIds = props.config.stashCheck?.selectedStashTabIds

  if (Array.isArray(savedIds)) {
    return savedIds
  }

  return stashTabs.value.map(tab => tab.id)
}

function formatClientString (template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (_matched: string, key: string) => values[key] ?? '')
}

function uniqueIds (ids: string[]): string[] {
  return [...new Set(ids)]
}

function isBasicStashTab (tab: StashTab): boolean {
  return BASIC_STASH_TAB_TYPES.has(tab.type)
}

function selectStashTabsByPredicate (predicate: (tab: StashTab) => boolean) {
  selectedStashTabIdsDraft.value = uniqueIds([
    ...selectedStashTabIdsDraft.value,
    ...stashTabs.value.filter(predicate).map(tab => tab.id)
  ])
}

function clearStashTabsByPredicate (predicate: (tab: StashTab) => boolean) {
  const removeIds = new Set(stashTabs.value.filter(predicate).map(tab => tab.id))
  selectedStashTabIdsDraft.value = selectedStashTabIdsDraft.value.filter(id => !removeIds.has(id))
}

function areAllStashTabsSelectedByPredicate (predicate: (tab: StashTab) => boolean): boolean {
  const targetIds = stashTabs.value.filter(predicate).map(tab => tab.id)

  if (targetIds.length === 0) {
    return false
  }

  const selectedIds = new Set(selectedStashTabIdsDraft.value)
  return targetIds.every(id => selectedIds.has(id))
}

function toggleStashTabsByPredicate (predicate: (tab: StashTab) => boolean) {
  if (areAllStashTabsSelectedByPredicate(predicate)) {
    clearStashTabsByPredicate(predicate)
    return
  }

  selectStashTabsByPredicate(predicate)
}

function toggleAllStashTabs () {
  toggleStashTabsByPredicate(() => true)
}

function toggleBasicStashTabs () {
  toggleStashTabsByPredicate(isBasicStashTab)
}

function toggleSpecialStashTabs () {
  toggleStashTabsByPredicate(tab => !isBasicStashTab(tab))
}

function refreshPoeNinjaStatus () {
  Host.sendEvent({
    name: 'CLIENT->MAIN::poe-ninja-price-status' as any,
    payload: undefined
  } as any)
}

function refreshPoeNinjaPrices () {
  const league = props.config.leagueId

  if (!league) {
    poeNinjaOk.value = false
    poeNinjaMessage.value = _$.SETTINGS_STASH_CHECK_SELECT_LEAGUE_FIRST
    return
  }

  poeNinjaRefreshing.value = true
  poeNinjaOk.value = null
  poeNinjaMessage.value = _$.SETTINGS_STASH_CHECK_POE_NINJA_REFRESHING

  Host.sendEvent({
    name: 'CLIENT->MAIN::poe-ninja-refresh-values' as any,
    payload: { league, itemDataRecords: collectPoeNinjaItemDataRecords() }
  } as any)
}


function collectPoeNinjaItemDataRecords (): PoeNinjaItemDataRecord[] {
  const records: PoeNinjaItemDataRecord[] = []

  for (const item of ITEMS_ITERATOR('"refName"') as Generator<BaseType>) {
    records.push({
      name: item.name,
      refName: item.refName,
      namespace: item.namespace,
      tradeTag: item.tradeTag,
      exchangeable: item.exchangeable === true
    })
  }

  return records
}

function applyPoeNinjaStatus (status: PoeNinjaStatusResult) {
  poeNinjaRefreshing.value = Boolean(status.running)
  poeNinjaCooldownUntil.value = status.cooldownUntil
  poeNinjaLastUpdatedAt.value = status.lastSuccessfulFetchAt
}

function login () {
  props.config.stashCheck ??= {}

  if (!props.config.stashCheck.snapshotNoticeAccepted) {
    const accepted = window.confirm([
      _$.SETTINGS_STASH_CHECK_SNAPSHOT_NOTICE_TITLE,
      '',
      _$.SETTINGS_STASH_CHECK_SNAPSHOT_NOTICE_BODY
    ].join('\n'))

    if (!accepted) {
      return
    }

    props.config.stashCheck.snapshotNoticeAccepted = true
    props.config.stashCheck.snapshotNoticeAcceptedAt = new Date().toISOString()
  }

  Host.sendEvent({
    name: 'CLIENT->MAIN::poe-login-open',
    payload: undefined
  })
}

function refreshCharacters () {
  Host.sendEvent({
    name: 'CLIENT->MAIN::poe-get-characters',
    payload: undefined
  })
}

Host.onEvent('MAIN->CLIENT::poe-characters', (e) => {
  characters.value = e.characters
  props.config.stashCheck ??= {}
  props.config.stashCheck.characters = e.characters
  loggedIn.value = true
  saveStashCheckConfig()

  if (characters.value.length > 0 && !selectedCharacterKey.value) {
    const c = characters.value[0]
    selectedCharacterKey.value = `${c.name}:${c.league}`
  }
})

function getSelectedCharacterDraft (): Character | null {
  if (selectedCharacterKey.value === NO_INVENTORY_CHARACTER_KEY || selectedCharacterKey.value === ALL_CHARACTERS_CHARACTER_KEY) {
    return null
  }

  return characters.value.find(
    c => `${c.name}:${c.league}` === selectedCharacterKey.value
  ) ?? null
}

function getSnapshotAnchorCharacter (): Character | null {
  const selected = getSelectedCharacterDraft()
  if (selected) return selected
  return characters.value[0] ?? props.config.stashCheck?.selectedCharacter ?? null
}

function isAllCharactersInventorySelected (): boolean {
  return selectedCharacterKey.value === ALL_CHARACTERS_CHARACTER_KEY
}

function isNoInventorySelected (): boolean {
  return selectedCharacterKey.value === NO_INVENTORY_CHARACTER_KEY
}

function applySnapshotDraftSelections () {
  props.config.stashCheck ??= {}

  const draftCharacter = getSelectedCharacterDraft()
  if (isNoInventorySelected()) {
    props.config.stashCheck.inventoryMode = 'none'
    currentCharacter.value = stashCheckT(':inventory_none')
  } else if (isAllCharactersInventorySelected()) {
    props.config.stashCheck.inventoryMode = 'all'
    const anchor = getSnapshotAnchorCharacter()
    if (anchor) {
      props.config.stashCheck.selectedCharacter = {
        name: anchor.name,
        league: anchor.league
      }
    }
    currentCharacter.value = stashCheckT(':inventory_all_characters')
  } else if (draftCharacter) {
    props.config.stashCheck.inventoryMode = 'single'
    props.config.stashCheck.selectedCharacter = {
      name: draftCharacter.name,
      league: draftCharacter.league
    }
    currentCharacter.value = `${draftCharacter.name} (${draftCharacter.league})`
  }

  props.config.stashCheck.stashTabs = stashTabs.value
  props.config.stashCheck.selectedStashTabIds = toPlainStashTabIds(selectedStashTabIdsDraft.value)
  saveStashCheckConfig()
}

function confirmCharacter () {
  props.config.stashCheck ??= {}

  if (isNoInventorySelected()) {
    props.config.stashCheck.inventoryMode = 'none'
    currentCharacter.value = stashCheckT(':inventory_none')
    saveStashCheckConfig()
    return
  }

  if (isAllCharactersInventorySelected()) {
    props.config.stashCheck.inventoryMode = 'all'
    const anchor = getSnapshotAnchorCharacter()
    if (anchor) {
      props.config.stashCheck.selectedCharacter = {
        name: anchor.name,
        league: anchor.league
      }
    }
    currentCharacter.value = stashCheckT(':inventory_all_characters')
    saveStashCheckConfig()
    return
  }

  const found = getSelectedCharacterDraft()

  if (!found) {
    currentCharacter.value = _$.SETTINGS_STASH_CHECK_UNSELECTED
    return
  }

  props.config.stashCheck.inventoryMode = 'single'
  props.config.stashCheck.selectedCharacter = {
    name: found.name,
    league: found.league
  }

  currentCharacter.value = `${found.name} (${found.league})`
  saveStashCheckConfig()
}

function refreshStashTabs () {
  const league = props.config.leagueId

  if (!league) {
    stashTabMessageOk.value = false
    stashTabMessage.value = _$.SETTINGS_STASH_CHECK_SELECT_LEAGUE_FIRST
    return
  }

  refreshingStashTabs.value = true
  stashTabMessageOk.value = null
  stashTabMessage.value = _$.SETTINGS_STASH_CHECK_FETCHING_STASH_TABS

  const debugRequestId = nextDebugRequestId('stash-tabs')
  poeSnapshotTraceLog('[PoeSnapshotTrace] settings/stash-check refreshStashTabs request:', {
    debugRequestId,
    league
  })

  const payload = { league, debugRequestId }

  poeSnapshotTraceLog('[PoeSnapshotTrace] settings/stash-check sending CLIENT->MAIN::poe-get-stash-tabs before:', {
    debugRequestId,
    league
  })

  try {
    Host.sendEvent({
      name: 'CLIENT->MAIN::poe-get-stash-tabs' as any,
      payload
    } as any)

    poeSnapshotTraceLog('[PoeSnapshotTrace] settings/stash-check sending CLIENT->MAIN::poe-get-stash-tabs after:', {
      debugRequestId
    })
  } catch (error) {
    poeSnapshotTraceError('[PoeSnapshotTrace] settings/stash-check sending CLIENT->MAIN::poe-get-stash-tabs failed:', {
      debugRequestId,
      error
    })
    refreshingStashTabs.value = false
    stashTabMessageOk.value = false
    stashTabMessage.value = formatClientString(_$.SETTINGS_STASH_CHECK_STASH_TABS_FAILED, { error: String(error) })
  }
}

Host.onEvent('MAIN->CLIENT::poe-stash-tabs' as any, (payload: any) => {
  const e = payload as StashTabsResult
  poeSnapshotTraceLog('[PoeSnapshotTrace] settings/stash-check received poe-stash-tabs:', {
    ok: e?.ok,
    tabCount: e?.tabs?.length,
    error: e?.error,
    errorKind: e?.errorKind,
    payload
  })
  refreshingStashTabs.value = false

  if (!e.ok) {
    stashTabMessageOk.value = false
    stashTabMessage.value = formatClientString(_$.SETTINGS_STASH_CHECK_STASH_TABS_FAILED, { error: e.error ?? 'unknown error' })
    return
  }

  stashTabs.value = e.tabs ?? []
  props.config.stashCheck ??= {}
  props.config.stashCheck.stashTabs = stashTabs.value

  const savedIds = props.config.stashCheck.selectedStashTabIds
  const availableIds = new Set(stashTabs.value.map(tab => tab.id))
  const nextSelected = Array.isArray(savedIds)
    ? savedIds.filter(id => availableIds.has(id))
    : stashTabs.value.map(tab => tab.id)

  selectedStashTabIdsDraft.value = nextSelected
  props.config.stashCheck.selectedStashTabIds = [...selectedStashTabIdsDraft.value]
  saveStashCheckConfig()

  stashTabMessageOk.value = true
  stashTabMessage.value = formatClientString(_$.SETTINGS_STASH_CHECK_STASH_TABS_REFRESHED, { count: String(stashTabs.value.length) })
})

function confirmStashTabs () {
  props.config.stashCheck ??= {}
  props.config.stashCheck.stashTabs = stashTabs.value
  props.config.stashCheck.selectedStashTabIds = [...selectedStashTabIdsDraft.value]
  saveStashCheckConfig()
}

function takeOwnedItemsSnapshot () {
  applySnapshotDraftSelections()
  const character = toPlainCharacter(getSnapshotAnchorCharacter())

  if (!character) {
    snapshotOk.value = false
    snapshotMessage.value = _$.SETTINGS_STASH_CHECK_SELECT_CHARACTER_FIRST
    return
  }

  const selectedStashTabIds = toPlainStashTabIds(getSelectedStashTabIdsForSnapshot())
  const debugRequestId = nextDebugRequestId('snapshot')

  snapshotRunning.value = true
  snapshotOk.value = null
  snapshotMessage.value = _$.SETTINGS_STASH_CHECK_FETCHING_OWNED_ITEMS
  lastSnapshotPath.value = ''

  const inventoryMode = isNoInventorySelected() ? 'none' : isAllCharactersInventorySelected() ? 'all' : 'single'
  const allCharactersInventory = inventoryMode === 'all'
  const skipCharacterInventory = inventoryMode === 'none'
  const snapshotCharacters = allCharactersInventory ? toPlainCharacters(characters.value) : []

  poeSnapshotTraceLog('[PoeSnapshotTrace] settings/stash-check takeOwnedItemsSnapshot request:', {
    debugRequestId,
    character,
    allCharactersInventory,
    skipCharacterInventory,
    characterCount: snapshotCharacters.length,
    selectedStashTabIdCount: selectedStashTabIds.length,
    selectedStashTabIds: selectedStashTabIds.slice(0, 20)
  })

  const payload = {
    character,
    selectedStashTabIds,
    allCharactersInventory,
    skipCharacterInventory,
    characters: snapshotCharacters,
    itemDataRecords: collectPoeNinjaItemDataRecords(),
    debugRequestId
  }

  poeSnapshotTraceLog('[PoeSnapshotTrace] settings/stash-check sending CLIENT->MAIN::poe-snapshot-owned-items before:', {
    debugRequestId,
    character,
    allCharactersInventory,
    skipCharacterInventory,
    characterCount: snapshotCharacters.length,
    selectedStashTabIdCount: selectedStashTabIds.length,
    selectedStashTabIds: selectedStashTabIds.slice(0, 20)
  })

  try {
    Host.sendEvent({
      name: 'CLIENT->MAIN::poe-snapshot-owned-items' as any,
      payload
    } as any)

    poeSnapshotTraceLog('[PoeSnapshotTrace] settings/stash-check sending CLIENT->MAIN::poe-snapshot-owned-items after:', {
      debugRequestId
    })
  } catch (error) {
    poeSnapshotTraceError('[PoeSnapshotTrace] settings/stash-check sending CLIENT->MAIN::poe-snapshot-owned-items failed:', {
      debugRequestId,
      error
    })
    snapshotRunning.value = false
    snapshotOk.value = false
    snapshotMessage.value = formatClientString(_$.SETTINGS_STASH_CHECK_SNAPSHOT_FAILED, { error: String(error) })
  }
}

function checkLoginStatus () {
  Host.sendEvent({
    name: 'CLIENT->MAIN::poe-login-status',
    payload: undefined
  })
}

Host.onEvent(
  'MAIN->CLIENT::poe-login-status',
  (e) => {
    loggedIn.value = e.loggedIn
  }
)

Host.onEvent(
  'MAIN->CLIENT::poe-login-window-closed' as any,
  (e: any) => {
    if (e?.completed) {
      loggedIn.value = true
    }

    checkLoginStatus()
  }
)

Host.onEvent(
  'MAIN->CLIENT::poe-ninja-price-status' as any,
  (payload: any) => {
    applyPoeNinjaStatus(payload as PoeNinjaStatusResult)
  }
)

Host.onEvent(
  'MAIN->CLIENT::poe-ninja-refresh-values-result' as any,
  (payload: any) => {
    const e = payload as PoeNinjaRefreshResult
    poeNinjaRefreshing.value = false
    poeNinjaCooldownUntil.value = e.cooldownUntil ?? null

    if (e.fetchedAt) {
      poeNinjaLastUpdatedAt.value = e.fetchedAt
    }

    if (e.ok) {
      poeNinjaOk.value = true
      poeNinjaMessage.value = formatClientString(_$.SETTINGS_STASH_CHECK_POE_NINJA_REFRESH_SUCCESS, {
        types: String(e.refreshedTypeCount ?? 0),
        rows: String(e.cachedRowCount ?? 0)
      })
      return
    }

    poeNinjaOk.value = false
    if (e.status === 'running') {
      poeNinjaMessage.value = _$.SETTINGS_STASH_CHECK_POE_NINJA_ALREADY_RUNNING
      return
    }
    if (e.status === 'cooldown') {
      poeNinjaMessage.value = _$.SETTINGS_STASH_CHECK_POE_NINJA_COOLDOWN_MESSAGE
      return
    }

    poeNinjaMessage.value = formatClientString(_$.SETTINGS_STASH_CHECK_POE_NINJA_REFRESH_FAILED, {
      error: e.error ?? 'unknown error'
    })
  }
)

Host.onEvent(
  'MAIN->CLIENT::poe-snapshot-owned-items-result' as any,
  (payload: any) => {
    const e = payload as SnapshotResult
    poeSnapshotTraceLog('[PoeSnapshotTrace] settings/stash-check received poe-snapshot-owned-items-result:', {
      ok: e?.ok,
      savedPath: e?.savedPath,
      itemCount: e?.itemCount,
      inventoryItemCount: e?.inventoryItemCount,
      characterInventoryCount: e?.characterInventoryCount,
      failedCharacterInventoryCount: e?.failedCharacterInventoryCount,
      stashItemCount: e?.stashItemCount,
      fetchedStashTabCount: e?.fetchedStashTabCount,
      stashTabCount: e?.stashTabCount,
      error: e?.error,
      errorKind: e?.errorKind,
      responseStatus: e?.responseStatus,
      poeErrorCode: e?.poeErrorCode,
      poeErrorMessage: e?.poeErrorMessage,
      payload
    })
    snapshotRunning.value = false
    snapshotOk.value = e.ok

    if (e.ok) {
      snapshotMessage.value = formatClientString(_$.SETTINGS_STASH_CHECK_OWNED_SNAPSHOT_SUCCESS, {
        count: String(e.itemCount ?? 0),
        inventory: String(e.inventoryItemCount ?? 0),
        fetchedTabs: String(e.fetchedStashTabCount ?? 0),
        totalTabs: String(e.stashTabCount ?? 0)
      })
      lastSnapshotPath.value = e.savedPath ?? ''
      return
    }

    if (e.errorKind === 'temporarily-unavailable') {
      snapshotMessage.value = _$.SETTINGS_STASH_CHECK_SNAPSHOT_TEMPORARILY_UNAVAILABLE
      return
    }

    snapshotMessage.value = formatClientString(_$.SETTINGS_STASH_CHECK_SNAPSHOT_FAILED, { error: e.error ?? 'unknown error' })
  }
)

onMounted(() => {
  checkLoginStatus()
  refreshPoeNinjaStatus()
  poeNinjaClockTimer = window.setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (poeNinjaClockTimer !== null) {
    window.clearInterval(poeNinjaClockTimer)
    poeNinjaClockTimer = null
  }
})
</script>

<script lang="ts">
export default {
  name: 'settings.stash_check'
}
</script>

<style scoped>
.panel {
  border: 1px solid #526174;
  padding: 12px;
  margin-bottom: 16px;
  border-radius: 4px;
}

.row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}

.current {
  margin-top: 12px;
}

.section-row {
  margin-top: 16px;
}

.sub-title {
  margin: 12px 0 8px;
  font-size: 1em;
}

.snapshot-notice {
  margin: 8px 0 12px;
  color: #b8c3d4;
  line-height: 1.5;
}

.automation-options {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.option-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.option-row.disabled {
  opacity: 0.55;
}

.inline-option {
  margin-left: 4px;
}

.snapshot-actions {
  margin-top: 12px;
}

.snapshot-status {
  margin-top: 8px;
}

.snapshot-status.ok {
  color: #8fd18f;
}

.snapshot-status.error {
  color: #d07b7b;
}

.snapshot-path {
  margin-top: 6px;
  word-break: break-all;
}

.opacity-setting {
  margin-top: 12px;
}

.opacity-label {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.opacity-value {
  color: #9ca3af;
  min-width: 3rem;
  text-align: right;
}

.opacity-range {
  margin-top: 8px;
  width: 100%;
}

.opacity-preview-label {
  color: #9ca3af;
  font-size: 0.9rem;
}

.opacity-preview {
  margin-top: 8px;
  border-radius: 4px;
  padding: 8px 10px;
  text-shadow: 0 1px 3px rgb(0, 0, 0);
}

.login-status {
  margin-left: 8px;
  color: #d07b7b;
}

.login-status.ok {
  color: #8fd18f;
}

.bulk-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0;
}

.btn.small {
  font-size: 0.9em;
  padding: 2px 8px;
}

.stash-tab-list {
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid #526174;
  border-radius: 4px;
  padding: 6px;
}

.stash-tab-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.stash-tab-name {
  flex: 1;
}

.stash-tab-type {
  color: #b8c3d4;
  font-size: 0.9em;
}

.empty-list {
  color: #b8c3d4;
}
</style>
