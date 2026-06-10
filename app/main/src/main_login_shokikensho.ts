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
import { BrowserWindow, session } from 'electron'

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
  const gameLogWatcher = new GameLogWatcher(eventPipe, logger)
  const gameConfig = new GameConfig(eventPipe, logger)
  const poeWindow = new GameWindow()
  const appUpdater = new AppUpdater(eventPipe)
  const _httpProxy = new HttpProxy(server, logger)
  const poeSession = session.fromPartition('persist:poe-login')

  const loginWin = new BrowserWindow({
    width: 1200,
    height: 900,
    title: 'PoE Login Test',
    webPreferences: {
      session: poeSession,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  await loginWin.loadURL('https://www.pathofexile.com/login')
  
  setInterval(async () => {
    try {

      const cookies = await poeSession.cookies.get({
        domain: 'pathofexile.com'
      })

      const cookieString = cookies
        .filter(c =>
          c.name === 'POESESSID'
          || c.name === 'cf_clearance'
        )
        .map(c =>
          `${c.name}=${c.value}`
        )
        .join('; ')

      const response = await poeSession.fetch(
        'https://www.pathofexile.com/character-window/get-items',
        {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Origin: 'https://www.pathofexile.com',
            Referer: 'https://www.pathofexile.com/account/view-profile/jumpesan-4994'
          },
          body: new URLSearchParams({
            accountName: 'jumpesan#4994',
            character: 'jumpewitch',
            realm: 'pc'
          })
        }
      )

      console.log('status:', response.status)
      console.log('content-type:', response.headers.get('content-type'))

      const text = await response.text()

      console.log(text.substring(0, 500))

      if (!response.ok || !text.trim().startsWith('{')) {
        return
      }

      const data = JSON.parse(text)

      const inventory = (data.items ?? []).filter(
        (x: any) => x.inventoryId === 'MainInventory'
      )

      console.log('\n=== INVENTORY ===')
      for (const item of inventory) {
        console.log({
          name: item.name || '',
          type: item.typeLine,
          stack: item.stackSize ?? 1,
          x: item.x,
          y: item.y
        })
      }

    }catch(ex){
      console.error(ex)
    }

  },10000)



  setTimeout(
    async () => {
      const overlay = new OverlayWindow(eventPipe, logger, poeWindow)
      new OverlayVisibility(eventPipe, overlay, gameConfig)
      const shortcuts = await Shortcuts.create(logger, overlay, poeWindow, gameConfig, eventPipe)
      eventPipe.onEventAnyClient('CLIENT->MAIN::update-host-config', (cfg) => {
        overlay.updateOpts(cfg.overlayKey, cfg.windowTitle)
        shortcuts.updateActions(cfg.shortcuts, cfg.stashScroll, cfg.logKeys, cfg.restoreClipboard, cfg.language)
        gameLogWatcher.restart(cfg.clientLog ?? '')
        gameConfig.readConfig(cfg.gameConfig ?? '')
        appUpdater.checkAtStartup()
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
