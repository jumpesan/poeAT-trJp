import { promises as fs, watchFile, unwatchFile } from 'fs'
import path from 'path'
import { app } from 'electron'
import { guessFileLocation } from './utils'
import { ServerEvents } from '../server'
import { Logger } from '../RemoteLogger'
import { MapRunService } from '../map-run/MapRunService'

const GAME_LOG_WATCHER_DEBUG = false

const POSSIBLE_PATH =
  (process.platform === 'win32') ? [
    'C:\\Program Files (x86)\\Grinding Gear Games\\Path of Exile\\logs\\Client.txt',
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Path of Exile\\logs\\Client.txt'
  ] : (process.platform === 'linux') ? [
    path.join(app.getPath('home'), '.wine/drive_c/Program Files (x86)/Grinding Gear Games/Path of Exile/logs/Client.txt'),
    path.join(app.getPath('home'), '.local/share/Steam/steamapps/common/Path of Exile/logs/Client.txt')
  ] : (process.platform === 'darwin') ? [
    path.join(app.getPath('home'), 'Library/Caches/com.GGG.PathOfExile/Logs/Client.txt')
  ] : []

export class GameLogWatcher {
  private _wantedPath: string | null = null
  get actualPath () { return this._state?.path ?? null }
  private _state: {
    offset: number
    path: string
    file: fs.FileHandle
    isReading: boolean
    readBuff: Buffer
  } | null = null

  constructor (
    private server: ServerEvents,
    private logger: Logger,
    private mapRunService?: MapRunService,
  ) {}

  async restart (logFile: string) {
    this.log(`restart requested logFile=${logFile || '(auto)'}`)
    if (this._wantedPath !== logFile) {
      this._wantedPath = logFile
      if (this._state) {
        unwatchFile(this._state.path)
        await this._state.file.close()
        this._state = null
        this.mapRunService?.resetActiveSeed('game log watcher path changed')
      }
    } else {
      return
    }

    if (!logFile.length) {
      const guessedPath = await guessFileLocation(POSSIBLE_PATH)
      if (guessedPath != null) {
        logFile = guessedPath
      } else {
        this.log('game log file not found')
        this.mapRunService?.resetActiveSeed('game log file not found')
        return
      }
    }

    try {
      const file = await fs.open(logFile, 'r')
      const stats = await file.stat()
      watchFile(logFile, { interval: 450 }, this.handleFileChange.bind(this))
      this._state = {
        path: logFile,
        file: file,
        offset: stats.size,
        isReading: false,
        readBuff: Buffer.allocUnsafe(64 * 1024),
      }
      this.log(`watching ${logFile} offset=${stats.size}`)
    } catch {
      this.mapRunService?.resetActiveSeed('failed to watch game log file')
      this.log('failed to watch file')
    }
  }

  private handleFileChange () {
    if (this._state && !this._state.isReading) {
      this._state.isReading = true
      this.readToEOF()
    }
  }

  private async readToEOF () {
    if (!this._state) return

    const { file, readBuff, offset } = this._state
    const { bytesRead } = await file.read(readBuff, 0, readBuff.length, offset)

    if (bytesRead) {
      this.log(`read bytes=${bytesRead} offset=${offset}`)
      const str = readBuff.toString('utf8', 0, bytesRead)
      const lines = str.split('\n').map(line => line.trim()).filter(line => line.length)
      this.log(`read lines=${lines.length}`)
      this.mapRunService?.handleLines(lines)
      this.server.sendEventTo('broadcast', {
        name: 'MAIN->CLIENT::game-log',
        payload: { lines }
      })
    }

    if (bytesRead) {
      this._state.offset += bytesRead
      this.readToEOF()
    } else {
      this._state.isReading = false
    }
  }

  private log (message: string) {
    if (!GAME_LOG_WATCHER_DEBUG) return
    const line = `[GameLogWatcher] ${message}`
    console.log(line)
    this.logger.write(`info ${line}`)
  }
}
