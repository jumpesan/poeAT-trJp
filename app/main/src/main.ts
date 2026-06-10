'use strict'

import { app } from 'electron'
import { uIOhook } from 'uiohook-napi'
import os from 'node:os'
import { startServer, eventPipe, server } from './server'
import { Logger } from './RemoteLogger'
import { GameWindow } from './windowing/GameWindow'
import { OverlayWindow } from './windowing/OverlayWindow'
import { GameConfig } from './host-files/GameConfig'
import { Shortcuts } from './shortcuts/Shortcuts'
import { AppUpdater } from './AppUpdater'
import { AppTray } from './AppTray'
import { OverlayVisibility } from './windowing/OverlayVisibility'
import { GameLogWatcher } from './host-files/GameLogWatcher'
import { HttpProxy } from './proxy'
import { PoeLogin } from './host-files/PoeLogin'
import { PoeSnapshot } from './host-files/PoeSnapshot'
import { GameFilesAutoDetector } from './host-files/GameFilesAutoDetector'
import { MapRunDatabase } from './map-run/MapRunDatabase'
import { MapRunService } from './map-run/MapRunService'
import { PoeNinjaTypeService } from './poe-ninja/PoeNinjaTypeService'
import { PoeNinjaDatabase } from './poe-ninja/PoeNinjaDatabase'
import { PoeNinjaValueService } from './poe-ninja/PoeNinjaValueService'
import { AutoSnapshotController } from './snapshot/AutoSnapshotController'

const HOST_TRACE_DEBUG = false

if (!app.requestSingleInstanceLock()) {
  app.exit()
}

if (process.platform !== 'darwin') {
  app.disableHardwareAcceleration()
}
app.enableSandbox()

let tray: AppTray

app.on('ready', async () => {
  tray = new AppTray(eventPipe)
  const logger = new Logger(eventPipe)
  const mapRunDatabase = new MapRunDatabase(logger)
  mapRunDatabase.open()
  const poeNinjaDatabase = new PoeNinjaDatabase(logger)
  poeNinjaDatabase.open()
  const poeNinjaTypeService = new PoeNinjaTypeService(poeNinjaDatabase, logger)
  const poeNinjaValueService = new PoeNinjaValueService(poeNinjaDatabase, logger, eventPipe)
  poeNinjaValueService.registerEvents()
  const gameConfig = new GameConfig(eventPipe, logger)
  const poeWindow = new GameWindow()
  const appUpdater = new AppUpdater(eventPipe)
  const _httpProxy = new HttpProxy(server, logger)

  new PoeLogin(eventPipe)
  if (HOST_TRACE_DEBUG) logger.write('info [PoeSnapshotTrace] initializing PoeSnapshot')
  const poeSnapshot = new PoeSnapshot(eventPipe, poeNinjaValueService)
  const autoSnapshotController = new AutoSnapshotController(poeSnapshot, logger)
  const mapRunService = new MapRunService(mapRunDatabase, logger, eventPipe, () => autoSnapshotController.onAreaChanged('map enter'))
  const gameLogWatcher = new GameLogWatcher(eventPipe, logger, mapRunService)
  if (HOST_TRACE_DEBUG) logger.write('info [PoeSnapshotTrace] PoeSnapshot initialized')
  const gameFilesAutoDetector = new GameFilesAutoDetector(eventPipe, logger)
  if (HOST_TRACE_DEBUG) logger.write('info [GameFilesAutoDetectorTrace] GameFilesAutoDetector initialized')

  app.once('before-quit', () => {
    mapRunService.resetActiveSeed('app before quit')
    mapRunDatabase.close()
    poeNinjaDatabase.close()
  })

  poeWindow.on('active-change', (isActive) => {
    if (HOST_TRACE_DEBUG) logger.write(`info [GameFilesAutoDetectorTrace] GameWindow active-change isActive=${isActive}`)
    if (isActive) void gameFilesAutoDetector.detectOnGameWindowEvent()
  })
  poeWindow.onAttach(() => {
    if (HOST_TRACE_DEBUG) logger.write('info [GameFilesAutoDetectorTrace] GameWindow attached')
    void gameFilesAutoDetector.detectOnGameWindowEvent()
  })

  setTimeout(
    async () => {
      const overlay = new OverlayWindow(eventPipe, logger, poeWindow)
      new OverlayVisibility(eventPipe, overlay, gameConfig)
      const shortcuts = await Shortcuts.create(logger, overlay, poeWindow, gameConfig, eventPipe)
      eventPipe.onEventAnyClient('CLIENT->MAIN::update-host-config', (cfg) => {
        if (HOST_TRACE_DEBUG) logger.write(`info [GameFilesAutoDetectorTrace] update-host-config received autoDetectGameFiles=${Boolean((cfg as any).autoDetectGameFiles)}, clientLog=${cfg.clientLog ?? '(empty)'}, gameConfig=${cfg.gameConfig ?? '(empty)'}`)
        overlay.updateOpts(cfg.overlayKey, cfg.windowTitle)
        shortcuts.updateActions(cfg.shortcuts, cfg.stashScroll, cfg.logKeys, cfg.restoreClipboard, cfg.language)
        gameLogWatcher.restart(cfg.clientLog ?? '')
        autoSnapshotController.updateHostConfig(cfg as any)
        const poeNinjaLeague = typeof (cfg as any).leagueId === 'string' ? (cfg as any).leagueId : undefined
        if (poeNinjaLeague) void poeNinjaTypeService.maybeRefreshTypes(poeNinjaLeague)
        gameConfig.readConfig(cfg.gameConfig ?? '')
        appUpdater.checkAtStartup()
        if (HOST_TRACE_DEBUG) logger.write(`info [GameFilesAutoDetectorTrace] updateAutoDetectEnabled call enabled=${Boolean((cfg as any).autoDetectGameFiles)}`)
        gameFilesAutoDetector.updateAutoDetectEnabled(Boolean((cfg as any).autoDetectGameFiles))
        tray.overlayKey = cfg.overlayKey
      })
      uIOhook.start()
      const port = await startServer(appUpdater, logger)
      // TODO: move up (currently crashes)
      logger.write(`info ${os.type()} ${os.release} / v${app.getVersion()}`)
      overlay.loadAppPage(port)
      tray.serverPort = port
    },
    // fixes(linux): window is black instead of transparent
    process.platform === 'linux' ? 1000 : 0
  )
})
