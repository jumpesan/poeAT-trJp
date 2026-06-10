import { BrowserWindow, session } from 'electron'
import type { ServerEvents } from '../server'
import type { OverlayWindow } from '../windowing/OverlayWindow'

const POE_SESSION = 'persist:poe-login'
const BASE_URL = 'https://www.pathofexile.com'
const LOGIN_URL = `${BASE_URL}/login`
const LOGIN_SUCCESS_PATH = '/my-account'
const COOKIE_STABLE_MS = 2000
const POE_LOGIN_DEBUG = false

function poeLoginDebugLog (...args: unknown[]) {
  if (POE_LOGIN_DEBUG) console.log(...args)
}

type PoeCookieState = {
  hasPoeSession: boolean
  hasCfClearance: boolean
}

export class PoeLogin {
  private loginWin: BrowserWindow | null = null
  private loginVerified = false
  private completingLogin = false

  constructor (
    private server: ServerEvents,
    private overlay?: OverlayWindow
  ) {
    this.server.onEventAnyClient('CLIENT->MAIN::poe-login-open', async () => {
      await this.openLoginWindow()
    })

    this.server.onEventAnyClient('CLIENT->MAIN::poe-get-characters', async () => {
      const characters = await this.getCharacters()

      this.server.sendEventTo('broadcast', {
        name: 'MAIN->CLIENT::poe-characters',
        payload: { characters }
      })
    })

    this.server.onEventAnyClient('CLIENT->MAIN::poe-login-status', async () => {
      const cookieState = await this.getCookieState()
      const loggedIn = cookieState.hasPoeSession

      this.server.sendEventTo('broadcast', {
        name: 'MAIN->CLIENT::poe-login-status',
        payload: {
          loggedIn,
          verified: this.loginVerified || cookieState.hasPoeSession,
          ...cookieState
        }
      } as any)
    })
  }

  private async openLoginWindow () {
    const poeSession = session.fromPartition(POE_SESSION)

    if (this.loginWin && !this.loginWin.isDestroyed()) {
      this.loginWin.focus()
      return
    }

    this.completingLogin = false

    const loginWin = new BrowserWindow({
      width: 1200,
      height: 900,
      title: 'Path of Exile Login',
      webPreferences: {
        session: poeSession,
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    this.loginWin = loginWin

    const maybeCompleteLogin = async (urlText?: string) => {
      if (!urlText || this.completingLogin || loginWin.isDestroyed()) return
      if (!this.isLoginSuccessUrl(urlText)) return

      const cookieState = await this.getCookieState()
      if (!cookieState.hasPoeSession) return

      this.completingLogin = true
      poeLoginDebugLog('[PoeLogin] login success url reached, closing window')
      await this.wait(COOKIE_STABLE_MS)

      if (loginWin.isDestroyed()) return

      const stableCookieState = await this.getCookieState()
      if (!stableCookieState.hasPoeSession) {
        this.completingLogin = false
        return
      }

      this.loginVerified = true
      loginWin.close()
    }

    loginWin.webContents.on('will-navigate', (_event, url) => {
      poeLoginDebugLog('[PoeLogin] will-navigate:', url)
      void maybeCompleteLogin(url)
    })

    loginWin.webContents.on('did-navigate', (_event, url) => {
      poeLoginDebugLog('[PoeLogin] did-navigate:', url)
      void maybeCompleteLogin(url)
    })

    loginWin.webContents.on('did-navigate-in-page', (_event, url) => {
      poeLoginDebugLog('[PoeLogin] did-navigate-in-page:', url)
      void maybeCompleteLogin(url)
    })

    loginWin.webContents.on('did-redirect-navigation', (_event, url) => {
      poeLoginDebugLog('[PoeLogin] did-redirect-navigation:', url)
      void maybeCompleteLogin(url)
    })

    loginWin.webContents.on('did-finish-load', () => {
      const currentUrl = loginWin.webContents.getURL()
      poeLoginDebugLog('[PoeLogin] did-finish-load:', currentUrl)
      void maybeCompleteLogin(currentUrl)
    })

    loginWin.webContents.on('did-stop-loading', () => {
      const currentUrl = loginWin.webContents.getURL()
      poeLoginDebugLog('[PoeLogin] did-stop-loading:', currentUrl)
      void maybeCompleteLogin(currentUrl)
    })

    loginWin.on('closed', () => {
      this.loginWin = null
      this.completingLogin = false
      this.overlay?.assertOverlayActive()
      this.server.sendEventTo('broadcast', {
        name: 'MAIN->CLIENT::poe-login-window-closed',
        payload: { completed: this.loginVerified }
      } as any)
    })

    try {
      await loginWin.loadURL(LOGIN_URL)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      if (this.loginVerified || this.completingLogin || loginWin.isDestroyed()) {
        poeLoginDebugLog('[PoeLogin] login loadURL cancelled after completion:', message)
      } else {
        console.warn('[PoeLogin] login loadURL failed:', err)
      }

      if (!loginWin.isDestroyed()) {
        loginWin.close()
      }
    }
  }

  private isLoginSuccessUrl (urlText: string): boolean {
    try {
      const url = new URL(urlText)
      const path = url.pathname.replace(/\/$/, '')

      return url.origin === BASE_URL && path === LOGIN_SUCCESS_PATH
    } catch {
      return false
    }
  }

  private async getCookieState (): Promise<PoeCookieState> {
    const poeSession = session.fromPartition(POE_SESSION)
    const cookies = await poeSession.cookies.get({ url: BASE_URL })

    return {
      hasPoeSession: cookies.some(c => c.name === 'POESESSID' && Boolean(c.value)),
      hasCfClearance: cookies.some(c => c.name.toLowerCase() === 'cf_clearance' && Boolean(c.value))
    }
  }

  private wait (ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private async getCharacters () {
    const poeSession = session.fromPartition(POE_SESSION)

    const res = await poeSession.fetch(`${BASE_URL}/character-window/get-characters`, {
      headers: {
        Accept: 'application/json',
        Referer: `${BASE_URL}/account/view-profile`
      }
    })

    const text = await res.text()

    if (!res.ok || !text.trim().startsWith('[')) {
      throw new Error(`get-characters failed: ${res.status} ${text.slice(0, 200)}`)
    }

    const data = JSON.parse(text)

    return data.map((c: any) => ({
      name: c.name,
      league: c.league
    }))
  }
}
