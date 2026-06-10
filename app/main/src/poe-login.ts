import { BrowserWindow, ipcMain, session } from 'electron'

const POE_SESSION = 'persist:poe-login'
const BASE_URL = 'https://www.pathofexile.com'

export function registerPoeLoginIpc () {
  ipcMain.handle('poe-login-open', async () => {
    const poeSession = session.fromPartition(POE_SESSION)

    const win = new BrowserWindow({
      width: 1200,
      height: 900,
      title: 'Path of Exile Login',
      webPreferences: {
        session: poeSession,
        nodeIntegration: false,
        contextIsolation: true,
      },
    })

    await win.loadURL(`${BASE_URL}/login`)

    const timer = setInterval(async () => {
      const cookies = await poeSession.cookies.get({ domain: 'pathofexile.com' })
      const ok = cookies.some(c => c.name === 'POESESSID' && c.value)

      if (ok) {
        clearInterval(timer)
        if (!win.isDestroyed()) win.close()
      }
    }, 1000)

    win.on('closed', () => clearInterval(timer))
  })

  ipcMain.handle('poe-get-characters', async () => {
    const poeSession = session.fromPartition(POE_SESSION)

    const res = await poeSession.fetch(`${BASE_URL}/character-window/get-characters`, {
      headers: {
        Accept: 'application/json',
        Referer: `${BASE_URL}/account/view-profile`,
      },
    })

    const text = await res.text()
    if (!res.ok || !text.trim().startsWith('[')) {
      throw new Error(`get-characters failed: ${res.status} ${text.slice(0, 200)}`)
    }

    const data = JSON.parse(text)

    return data.map((c: any) => ({
      name: c.name,
      league: c.league,
    }))
  })
}