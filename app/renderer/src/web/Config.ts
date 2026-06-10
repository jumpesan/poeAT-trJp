import { reactive as deepReactive, shallowRef, toRaw } from 'vue'
import isDeepEqual from 'fast-deep-equal'
import { Host } from '@/web/background/IPC'
import { HostConfig, ShortcutAction } from '@ipc/types'
import type * as widget from './overlay/widgets'
import type { StashSearchWidget } from './stash-search/widget'
import type { ItemCheckWidget } from './item-check/widget'
import type { ItemSearchWidget } from './item-search/widget'
import { registry as widgetRegistry } from './overlay/widget-registry.js'
import { ITEMS_ITERATOR, type BaseType } from '@/assets/data'


type PoeNinjaItemDataRecord = {
  name: string
  refName: string
  namespace?: string
  tradeTag?: string
  exchangeable?: boolean
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

const GAME_FILES_AUTO_DETECTOR_TRACE = false

function gameFilesAutoDetectorTraceLog (...args: unknown[]) {
  if (GAME_FILES_AUTO_DETECTOR_TRACE) console.log(...args)
}

const _config = shallowRef<Config | null>(null)
let _lastSavedConfig: Config | null = null

export function AppConfig (): Config
export function AppConfig<T extends widget.Widget> (type: string): T | undefined
export function AppConfig (type?: string) {
  if (!type) {
    return _config.value!
  } else {
    return _config.value!.widgets.find(w => w.wmType === type)
  }
}

export function updateConfig (updates: Config) {
  _config.value = deepReactive(JSON.parse(JSON.stringify(updates)))
  document.documentElement.style.fontSize = `${_config.value!.fontSize}px`
}

export function saveConfig (opts?: { isTemporary: boolean }) {
  const rawConfig = toRaw(_config.value!)
  if (rawConfig.widgets.some(w => w.wmZorder === 'exclusive' && w.wmWants === 'show')) {
    return
  }

  if (!isDeepEqual(rawConfig, _lastSavedConfig)) {
    _lastSavedConfig = JSON.parse(JSON.stringify(rawConfig))
    Host.sendEvent({
      name: 'CLIENT->MAIN::save-config',
      payload: {
        contents: JSON.stringify(AppConfig()),
        isTemporary: opts?.isTemporary ?? false
      }
    })
  }
}

export function pushHostConfig () {
  Host.sendEvent({
    name: 'CLIENT->MAIN::update-host-config',
    payload: getConfigForHost()
  })
}

export async function initConfig () {
  Host.onEvent('MAIN->CLIENT::config-changed', (e) => {
    _lastSavedConfig = JSON.parse(e.contents) // should be a deep copy
    updateConfig(JSON.parse(e.contents))
  })

  Host.onEvent('MAIN->CLIENT::auto-detect-game-files-result' as any, (payload: any) => {
    gameFilesAutoDetectorTraceLog('[GameFilesAutoDetectorTrace] Config received auto-detect-game-files-result', payload)
    if (_config.value == null || !_config.value.autoDetectGameFiles) {
      gameFilesAutoDetectorTraceLog('[GameFilesAutoDetectorTrace] Config ignored auto-detect-game-files-result', { hasConfig: _config.value != null, autoDetectGameFiles: _config.value?.autoDetectGameFiles })
      return
    }

    let updated = false
    if (payload?.clientLog && _config.value.clientLog !== payload.clientLog) {
      _config.value.clientLog = payload.clientLog
      updated = true
    }
    if (payload?.gameConfig && _config.value.gameConfig !== payload.gameConfig) {
      _config.value.gameConfig = payload.gameConfig
      updated = true
    }

    if (updated) {
      gameFilesAutoDetectorTraceLog('[GameFilesAutoDetectorTrace] Config applied auto-detect-game-files-result', { clientLog: _config.value.clientLog, gameConfig: _config.value.gameConfig })
      saveConfig()
      pushHostConfig()
    } else {
      gameFilesAutoDetectorTraceLog('[GameFilesAutoDetectorTrace] Config auto-detect result did not change current paths')
    }
  })

  const contents = await Host.getConfig()
  if (!contents) {
    updateConfig(defaultConfig())
    return
  }

  let config: Config
  try {
    config = JSON.parse(contents)
  } catch {
    updateConfig(defaultConfig())
    saveConfig({ isTemporary: true })
    return

    // TODO
    // dialog.showErrorBox(
    //   'Awakened PoE Trade - Incompatible configuration',
    //   // ----------------------
    //   'You are trying to use an older version of Awakened PoE Trade with a newer incompatible configuration file.\n' +
    //   'You need to install the latest version to continue using it.'
    // )
  }

  updateConfig(upgradeConfig(config))
}

export function poeWebApi () {
  const { language, useIntlSite } = AppConfig()
  if (useIntlSite) {
    return 'www.pathofexile.com'
  }
  switch (language) {
    case 'en': return 'www.pathofexile.com'
    case 'ru': return 'ru.pathofexile.com'
    case 'cmn-Hant': return 'pathofexile.tw'
    case 'ko': return 'poe.game.daum.net'
    case 'jp': return 'www.pathofexile.com'
  }
}

export interface Config {
  configVersion: number
  leagueId?: string
  overlayKey: string
  overlayBackground: string
  overlayBackgroundClose: boolean
  restoreClipboard: boolean
  commands: Array<{
    text: string
    hotkey: string | null
    send: boolean
  }>
  clientLog: string | null
  gameConfig: string | null
  autoDetectGameFiles: boolean
  windowTitle: string
  logKeys: boolean
  accountName: string
  stashScroll: boolean
  language: 'en' | 'ru' | 'cmn-Hant' | 'ko' | 'jp'
  realm: 'pc-ggg' | 'pc-garena'
  useIntlSite: boolean
  widgets: widget.Widget[]
  fontSize: number
  showAttachNotification: boolean
  mapRunTimer?: {
    showBestTimeOnEnter: boolean
    showAverageTimeOnEnter: boolean
    recentRunsCount: number
    statsBackgroundOpacity: number
    statsTextOpacity: number
  }
  stashCheck?: {
    selectedCharacter?: {
      name: string
      league: string
    }
    characters?: Array<{
      name: string
      league: string
    }>
    stashTabs?: Array<{
      id: string
      name: string
      type: string
      index: number
    }>
    selectedStashTabIds?: string[]
    includeAllCharactersInventory?: boolean
    inventoryMode?: 'single' | 'all' | 'none'
    autoMapTimerEnabled?: boolean
    autoSnapshotEnabled?: boolean
    autoSnapshotIntervalMinutes?: number
    itemDataRecords?: PoeNinjaItemDataRecord[]
    snapshotValuesBackgroundOpacity?: number
    snapshotValuesTextOpacity?: number
    snapshotNoticeAccepted?: boolean
    snapshotNoticeAcceptedAt?: string
  }
}

export const defaultConfig = (): Config => ({
  configVersion: 26,
  overlayKey: 'Shift + Space',
  overlayBackground: 'rgba(129, 139, 149, 0.15)',
  overlayBackgroundClose: true,
  restoreClipboard: false,
  showAttachNotification: true,
  commands: [{
    text: '/hideout',
    hotkey: 'F5',
    send: true
  }, {
    text: '/exit',
    hotkey: 'F9',
    send: true
  }, {
    text: '@last ty',
    hotkey: null,
    send: true
  }, {
    text: '/invite @last',
    hotkey: null,
    send: true
  }, {
    text: '/tradewith @last',
    hotkey: null,
    send: true
  }, {
    text: '/hideout @last',
    hotkey: null,
    send: true
  }],
  clientLog: null,
  gameConfig: null,
  autoDetectGameFiles: true,
  windowTitle: 'Path of Exile',
  logKeys: false,
  accountName: '',
  stashScroll: true,
  language: 'jp',
  realm: 'pc-ggg',
  useIntlSite: false,
  fontSize: 16,
  widgets: widgetRegistry.widgets.reduce<widget.Widget[]>((widgets, { widget }) => {
    const res: widget.Widget[] = []
    if (widget.instances === 'single') {
      res.push(widget.initInstance!())
    } else if (widget.instances === 'multi' && widget.defaultInstances != null) {
      res.push(...widget.defaultInstances())
    }
    for (const config of res) {
      config.wmId = widgets.length + 1
      widgets.push(config)
    }
    return widgets
  }, []),
  stashCheck: {
    autoSnapshotIntervalMinutes: 0,
    snapshotValuesBackgroundOpacity: 78,
    snapshotValuesTextOpacity: 100
  },
  mapRunTimer: {
    showBestTimeOnEnter: false,
    showAverageTimeOnEnter: false,
    recentRunsCount: 0,
    statsBackgroundOpacity: 75,
    statsTextOpacity: 100
  },
})

function upgradeConfig (_config: Config): Config {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const config = _config as Omit<Config, 'widgets'> & { widgets: Array<Record<string, any>> }

  if (config.configVersion < 3) {
    config.widgets.push({
      ...defaultConfig().widgets.find(w => w.wmType === 'image-strip')!,
      wmId: Math.max(0, ...config.widgets.map(_ => _.wmId)) + 1,
      wmZorder: null
    })

    config.widgets.push({
      ...defaultConfig().widgets.find(w => w.wmType === 'delve-grid')!,
      wmId: Math.max(0, ...config.widgets.map(_ => _.wmId)) + 1,
      wmZorder: null
    })

    config.widgets.find(w => w.wmType === 'menu')!
      .alwaysShow = false

    config.configVersion = 3
  }

  if (config.configVersion < 4) {
    config.widgets.find(w => w.wmType === 'price-check')!
      .chaosPriceThreshold = 0.05

    const mapCheck = config.widgets.find(w => w.wmType === 'map-check')!
    ;(mapCheck as any).selectedStats.forEach((e: any) => {
      e.matcher = e.matchRef
      e.matchRef = undefined
    })

    {
      const widgets = config.widgets.filter(w => w.wmType === 'image-strip')!
      widgets.forEach((imgStrip: any) => {
        imgStrip.images.forEach((e: any, idx: number) => {
          e.id = idx
        })
      })
    }

    config.configVersion = 4
  }

  if (config.configVersion < 5) {
    config.commands.forEach(cmd => {
      cmd.send = true
    })

    config.configVersion = 5
  }

  if (config.configVersion < 6) {
    config.widgets.find(w => w.wmType === 'price-check')!
      .showRateLimitState = ((config as any).logLevel === 'debug')
    config.widgets.find(w => w.wmType === 'price-check')!
      .apiLatencySeconds = 2

    config.configVersion = 6
  }

  if (config.configVersion < 7) {
    const mapCheck = config.widgets.find(w => w.wmType === 'map-check')!
    mapCheck.wmType = 'item-check'
    mapCheck.maps = { selectedStats: mapCheck.selectedStats }
    mapCheck.selectedStats = undefined

    ;(config as any).itemCheckKey = (config as any).mapCheckKey || null
    ;(config as any).mapCheckKey = undefined

    config.configVersion = 7
  }

  if (config.configVersion < 8) {
    const itemCheck = config.widgets.find(w => w.wmType === 'item-check')!
    ;(itemCheck as ItemCheckWidget).maps.showNewStats = false
    itemCheck.maps.selectedStats = (itemCheck as ItemCheckWidget).maps.selectedStats.map(entry => ({
      matcher: entry.matcher,
      decision:
        (entry as any).valueDanger ? 'danger'
          : (entry as any).valueWarning ? 'warning'
              : (entry as any).valueDesirable ? 'desirable'
                  : 'seen'
    }))

    config.configVersion = 8
  }

  if (config.configVersion < 9) {
    config.widgets.find(w => w.wmType === 'price-check')!
      .collapseListings = 'api'

    config.widgets.find(w => w.wmType === 'price-check')!
      .smartInitialSearch = true
    config.widgets.find(w => w.wmType === 'price-check')!
      .lockedInitialSearch = true

    config.widgets.find(w => w.wmType === 'price-check')!
      .activateStockFilter = false

    config.configVersion = 9
  }

  if (config.configVersion < 10) {
    config.widgets.push({
      ...defaultConfig().widgets.find(w => w.wmType === 'settings')!,
      wmId: Math.max(0, ...config.widgets.map(_ => _.wmId)) + 1
    })

    const priceCheck = config.widgets.find(w => w.wmType === 'price-check')!
    priceCheck.hotkey = (config as any).priceCheckKey
    priceCheck.hotkeyHold = (config as any).priceCheckKeyHold
    priceCheck.hotkeyLocked = (config as any).priceCheckLocked
    priceCheck.showSeller = (config as any).showSeller
    priceCheck.searchStatRange = (config as any).searchStatRange
    priceCheck.showCursor = (config as any).priceCheckShowCursor

    if (priceCheck.chaosPriceThreshold === 0.05) {
      priceCheck.chaosPriceThreshold = 0
    }

    config.configVersion = 10
  }

  if (config.configVersion < 11) {
    config.widgets.find(w => w.wmType === 'price-check')!
      .requestPricePrediction = false

    config.configVersion = 11
  }

  if (config.configVersion < 12) {
    const afterSettings = config.widgets.findIndex(w => w.wmType === 'settings')
    config.widgets.splice(afterSettings + 1, 0, {
      ...defaultConfig().widgets.find(w => w.wmType === 'item-search')!,
      wmWants: 'show',
      wmId: Math.max(0, ...config.widgets.map(_ => _.wmId)) + 1
    })

    config.realm = 'pc-ggg'
    if (config.language === 'zh_TW' as string) {
      config.language = 'cmn-Hant'
    }

    config.configVersion = 12
  }

  if (config.configVersion < 13) {
    config.showAttachNotification = true

    config.configVersion = 13
  }

  if (config.configVersion < 14) {
    const imgWidgets = config.widgets.filter(w => w.wmType === 'image-strip') as widget.ImageStripWidget[]
    imgWidgets.forEach((imgStrip) => {
      imgStrip.images.forEach((e) => {
        e.url = e.url.startsWith('app-file://')
          ? e.url.slice('app-file://'.length)
          : e.url
      })
    })

    const itemCheck = config.widgets.find(w => w.wmType === 'item-check') as ItemCheckWidget
    itemCheck.wikiKey = (config as any).wikiKey
    itemCheck.poedbKey = null
    itemCheck.craftOfExileKey = (config as any).craftOfExileKey
    itemCheck.stashSearchKey = null

    config.configVersion = 14
  }

  if (config.configVersion < 15) {
    const priceCheck = config.widgets.find(w => w.wmType === 'price-check') as widget.PriceCheckWidget
    priceCheck.builtinBrowser = false

    const itemSearch = config.widgets.find(w => w.wmType === 'item-search') as ItemSearchWidget
    itemSearch.ocrGemsKey = null

    const itemCheck = config.widgets.find(w => w.wmType === 'item-check') as ItemCheckWidget
    itemCheck.maps.profile = 1
    for (const stat of itemCheck.maps.selectedStats) {
      const p1decision =
        (stat.decision === 'danger') ? 'd'
          : (stat.decision === 'warning') ? 'w'
              : (stat.decision === 'desirable') ? 'g' : 's'

      stat.decision = `${p1decision}--`
    }

    config.configVersion = 15
  }

  if (config.configVersion < 16) {
    const delve = config.widgets.find(w => w.wmType === 'delve-grid') as widget.DelveGridWidget
    delve.toggleKey = (config as any).delveGridKey

    const itemCheck = config.widgets.find(w => w.wmType === 'item-check') as ItemCheckWidget
    itemCheck.hotkey = (config as any).itemCheckKey

    if (itemCheck.maps.profile === undefined) {
      itemCheck.maps.profile = 1
      itemCheck.maps.selectedStats = []
    }

    config.configVersion = 16
  }

  if (config.logKeys === undefined) {
    config.logKeys = false
  }

  const priceCheck = config.widgets.find(w => w.wmType === 'price-check') as widget.PriceCheckWidget
  if (priceCheck.rememberCurrency === undefined) {
    priceCheck.rememberCurrency = false
  }

  for (const widget of config.widgets) {
    if (widget.wmType === 'stash-search') {
      (widget as StashSearchWidget).enableHotkeys ??= true
    }
  }

  if (config.configVersion < 17) {
    for (const widget of config.widgets) {
      for (let i = 0; i < widget.wmFlags.length; ++i) {
        if (widget.wmFlags[i] === 'skip-menu') {
          widget.wmFlags[i] = 'menu::skip'
        }
      }
    }

    const itemSearch = config.widgets.find(w => w.wmType === 'item-search') as widget.Widget
    itemSearch.wmTitle = '{icon=fa-search}'
    const settings = config.widgets.find(w => w.wmType === 'settings') as widget.Widget
    settings.wmTitle = '{icon=fa-cog}'

    // make sure icon for settings comes first in the widget menu
    config.widgets.sort((a, b) => {
      if (a.wmType === 'settings') return -1
      if (b.wmType === 'settings') return 1
      return 0
    })

    config.configVersion = 17
  }

  if (config.configVersion < 18) {
    config.useIntlSite = (config.language === 'cmn-Hant' && config.realm === 'pc-ggg')

    config.configVersion = 18
  }

  if (config.configVersion < 19) {
    if (!config.widgets.some(w => w.wmType === 'map-run-timer')) {
      config.widgets.push({
        ...defaultConfig().widgets.find(w => w.wmType === 'map-run-timer')!,
        wmId: Math.max(0, ...config.widgets.map(_ => _.wmId)) + 1
      })
    }

    config.configVersion = 19
  }

  if (config.configVersion < 20) {
    config.autoDetectGameFiles = false

    config.configVersion = 20
  }

  if (config.configVersion < 21) {
    config.mapRunTimer = {
      showBestTimeOnEnter: false,
      showAverageTimeOnEnter: false,
      recentRunsCount: 0,
      statsBackgroundOpacity: 75,
      statsTextOpacity: 100
    }

    config.configVersion = 21
  }

  if (config.configVersion < 22) {
    config.mapRunTimer ??= {
      showBestTimeOnEnter: false,
      showAverageTimeOnEnter: false,
      recentRunsCount: 0,
      statsBackgroundOpacity: 75,
      statsTextOpacity: 100
    }
    config.mapRunTimer.statsBackgroundOpacity ??= 75
    config.mapRunTimer.statsTextOpacity ??= 100

    config.configVersion = 22
  }


  if (config.configVersion < 23) {
    if (!config.widgets.some(w => w.wmType === 'map-run-stats')) {
      config.widgets.push({
        ...defaultConfig().widgets.find(w => w.wmType === 'map-run-stats')!,
        wmId: Math.max(0, ...config.widgets.map(_ => _.wmId)) + 1
      })
    }

    config.configVersion = 23
  }


  if (config.configVersion < 24) {
    if (!config.widgets.some(w => w.wmType === 'snapshot-values')) {
      config.widgets.push({
        ...defaultConfig().widgets.find(w => w.wmType === 'snapshot-values')!,
        wmId: Math.max(0, ...config.widgets.map(_ => _.wmId)) + 1
      })
    }

    config.stashCheck ??= {}
    config.stashCheck.snapshotValuesBackgroundOpacity ??= 78

    config.configVersion = 24
  }

  if (config.configVersion < 25) {
    config.stashCheck ??= {}
    config.stashCheck.snapshotValuesTextOpacity ??= 100

    config.configVersion = 25
  }

  if (config.configVersion < 26) {
    config.stashCheck ??= {}
    config.stashCheck.autoSnapshotIntervalMinutes ??= config.stashCheck.autoSnapshotEnabled ? 30 : 0
    config.stashCheck.inventoryMode ??= config.stashCheck.includeAllCharactersInventory ? 'all' : 'single'

    config.configVersion = 26
  }

  config.mapRunTimer ??= {
    showBestTimeOnEnter: false,
    showAverageTimeOnEnter: false,
    recentRunsCount: 0,
    statsBackgroundOpacity: 75,
    statsTextOpacity: 100
  }
  config.mapRunTimer.showBestTimeOnEnter ??= false
  config.mapRunTimer.showAverageTimeOnEnter ??= false
  config.mapRunTimer.recentRunsCount ??= 0
  config.mapRunTimer.statsBackgroundOpacity ??= 75
  config.mapRunTimer.statsTextOpacity ??= 100

  config.stashCheck ??= {}
  config.stashCheck.autoSnapshotIntervalMinutes ??= 0
  config.stashCheck.inventoryMode ??= 'single'
  config.stashCheck.snapshotValuesBackgroundOpacity ??= 78
  config.stashCheck.snapshotValuesTextOpacity ??= 100

  /* eslint-enable */

  return config as unknown as Config
}

function getConfigForHost (): HostConfig {
  const actions: ShortcutAction[] = []

  const config = AppConfig()
  const priceCheck = AppConfig('price-check') as widget.PriceCheckWidget
  if (priceCheck.hotkey) {
    actions.push({
      shortcut: `${priceCheck.hotkeyHold} + ${priceCheck.hotkey}`,
      action: { type: 'copy-item', target: 'price-check', focusOverlay: false },
      keepModKeys: true
    })
  }
  if (priceCheck.hotkeyLocked) {
    actions.push({
      shortcut: priceCheck.hotkeyLocked,
      action: { type: 'copy-item', target: 'price-check', focusOverlay: true }
    })
  }
  actions.push({
    shortcut: config.overlayKey,
    action: { type: 'toggle-overlay' },
    keepModKeys: true
  })
  const itemCheck = AppConfig('item-check') as ItemCheckWidget
  if (itemCheck.wikiKey) {
    actions.push({
      shortcut: itemCheck.wikiKey,
      action: { type: 'copy-item', target: 'open-wiki' }
    })
  }
  if (itemCheck.craftOfExileKey) {
    actions.push({
      shortcut: itemCheck.craftOfExileKey,
      action: { type: 'copy-item', target: 'open-craft-of-exile' }
    })
  }
  if (itemCheck.poedbKey) {
    actions.push({
      shortcut: itemCheck.poedbKey,
      action: { type: 'copy-item', target: 'open-poedb' }
    })
  }
  if (itemCheck.stashSearchKey) {
    actions.push({
      shortcut: itemCheck.stashSearchKey,
      action: { type: 'copy-item', target: 'search-similar' }
    })
  }
  if (itemCheck.hotkey) {
    actions.push({
      shortcut: itemCheck.hotkey,
      action: { type: 'copy-item', target: 'item-check', focusOverlay: true }
    })
  }
  const delveGrid = AppConfig('delve-grid') as widget.DelveGridWidget
  if (delveGrid.toggleKey) {
    actions.push({
      shortcut: delveGrid.toggleKey,
      action: { type: 'trigger-event', target: 'delve-grid' },
      keepModKeys: true
    })
  }
  for (const command of config.commands) {
    if (command.hotkey) {
      actions.push({
        shortcut: command.hotkey,
        action: { type: 'paste-in-chat', text: command.text, send: command.send }
      })
    }
  }
  for (const widget of config.widgets) {
    if (widget.wmType === 'stash-search') {
      const stashSearch = widget as StashSearchWidget
      if (!stashSearch.enableHotkeys) continue

      for (const entry of stashSearch.entries) {
        if (entry.hotkey) {
          actions.push({
            shortcut: entry.hotkey,
            action: { type: 'stash-search', text: entry.text }
          })
        }
      }
    } else if (widget.wmType === 'timer') {
      const stopwatch = widget as widget.StopwatchWidget
      if (stopwatch.toggleKey) {
        actions.push({
          shortcut: stopwatch.toggleKey,
          keepModKeys: true,
          action: {
            type: 'trigger-event',
            target: `stopwatch-start-stop:${widget.wmId}`
          }
        })
      }
      if (stopwatch.resetKey) {
        actions.push({
          shortcut: stopwatch.resetKey,
          keepModKeys: true,
          action: {
            type: 'trigger-event',
            target: `stopwatch-reset:${widget.wmId}`
          }
        })
      }
    } else if (widget.wmType === 'item-search') {
      const itemSearch = widget as ItemSearchWidget
      if (itemSearch.ocrGemsKey) {
        actions.push({
          shortcut: itemSearch.ocrGemsKey,
          keepModKeys: true,
          action: { type: 'ocr-text', target: 'heist-gems' }
        })
      }
    }
  }

  return {
    shortcuts: actions,
    restoreClipboard: config.restoreClipboard,
    clientLog: config.clientLog,
    gameConfig: config.gameConfig,
    autoDetectGameFiles: config.autoDetectGameFiles,
    stashScroll: config.stashScroll,
    overlayKey: config.overlayKey,
    logKeys: config.logKeys,
    windowTitle: config.windowTitle,
    leagueId: config.leagueId,
    language: config.language,
    stashCheck: {
      selectedCharacter: config.stashCheck?.selectedCharacter,
      characters: config.stashCheck?.characters ?? [],
      selectedStashTabIds: config.stashCheck?.selectedStashTabIds ?? [],
      inventoryMode: config.stashCheck?.inventoryMode ?? 'single',
      autoSnapshotIntervalMinutes: config.stashCheck?.autoSnapshotIntervalMinutes ?? 0,
      itemDataRecords: collectPoeNinjaItemDataRecords()
    }
  } as HostConfig
}
