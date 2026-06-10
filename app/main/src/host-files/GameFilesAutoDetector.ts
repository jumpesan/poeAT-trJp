import { app } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import { execFile } from 'child_process'
import type { Logger } from '../RemoteLogger'
import type { ServerEvents } from '../server'

const GAME_FILES_AUTO_DETECTOR_TRACE = false

interface DetectedGameFiles {
  clientLog: string | null
  gameConfig: string | null
  installDir: string | null
  exePath: string | null
  source: 'manual' | 'auto'
  debug?: GameFilesAutoDetectorDebug
}

interface GameFilesAutoDetectorDebug {
  source: 'manual' | 'auto'
  platform: NodeJS.Platform
  powershell?: {
    executed: boolean
    error: string | null
    stdout: string
    stderr: string
    candidates: PoeProcessCandidate[]
  }
  selectedProcessCandidate: PoeProcessCandidate | null
  selectedProcessRejectedReason: string | null
  installDirFromExePath: string | null
  installDirFallbackCandidates: PathCandidateCheck[]
  clientLogCandidates: PathCandidateCheck[]
  gameConfigCandidates: PathCandidateCheck[]
}

interface PoeProcessCandidate {
  name: string
  processId: string
  creationDate: string
  executablePath: string
}

interface PathCandidateCheck {
  filePath: string
  exists: boolean
}

export class GameFilesAutoDetector {
  private autoDetectEnabled = false
  private lastAutoResultKey: string | null = null
  private lastAutoDetectAt = 0
  private autoDetectInFlight = false

  constructor (
    private server: ServerEvents,
    private logger: Logger
  ) {
    this.trace('info [GameFilesAutoDetectorTrace] detector constructor registered IPC handler CLIENT->MAIN::detect-game-files')
    this.server.onEventAnyClient('CLIENT->MAIN::detect-game-files' as any, async () => {
      this.trace('info [GameFilesAutoDetectorTrace] IPC received CLIENT->MAIN::detect-game-files')
      const result = await this.detect('manual')
      this.logDetectedFiles(result)
      this.server.sendEventTo('last-active', {
        name: 'MAIN->CLIENT::detect-game-files-result' as any,
        payload: result as any
      } as any)
    })
  }

  updateAutoDetectEnabled (enabled: boolean) {
    const wasEnabled = this.autoDetectEnabled
    this.trace(`info [GameFilesAutoDetectorTrace] updateAutoDetectEnabled enabled=${enabled}, wasEnabled=${wasEnabled}`)
    this.autoDetectEnabled = enabled
    if (!enabled) {
      this.lastAutoResultKey = null
      this.lastAutoDetectAt = 0
      this.autoDetectInFlight = false
      return
    }

    // If the game was already attached/active before this setting was enabled,
    // no new GameWindow event may fire. Run one event-triggered detection
    // immediately when switching from OFF to ON.
    if (!wasEnabled) {
      void this.detectOnGameWindowEvent({ force: true })
    }
  }


  async detectOnGameWindowEvent (opts?: { force?: boolean }) {
    this.trace(`info [GameFilesAutoDetectorTrace] detectOnGameWindowEvent requested force=${Boolean(opts?.force)}, autoDetectEnabled=${this.autoDetectEnabled}`)
    if (!this.autoDetectEnabled) {
      this.trace('info [GameFilesAutoDetectorTrace] detectOnGameWindowEvent skipped because autoDetectEnabled=false')
      return
    }

    // Existing overlay focus/attach events can fire repeatedly while the game is active.
    // Keep this event-triggered, but throttle the expensive process lookup.
    const now = Date.now()
    if (!opts?.force && now - this.lastAutoDetectAt < 5_000) {
      this.trace(`info [GameFilesAutoDetectorTrace] detectOnGameWindowEvent skipped by throttle elapsedMs=${now - this.lastAutoDetectAt}`)
      return
    }
    if (this.autoDetectInFlight) {
      this.trace('info [GameFilesAutoDetectorTrace] detectOnGameWindowEvent skipped because detection is already in flight')
      return
    }

    this.lastAutoDetectAt = now
    this.autoDetectInFlight = true
    try {
      const result = await this.detect('auto')
      if (!result.exePath && !result.clientLog && !result.gameConfig) return

      const resultKey = [result.exePath, result.clientLog, result.gameConfig].join('|')
      if (resultKey === this.lastAutoResultKey) return
      this.lastAutoResultKey = resultKey
      this.logDetectedFiles(result)

      this.server.sendEventTo('broadcast', {
        name: 'MAIN->CLIENT::auto-detect-game-files-result' as any,
        payload: result as any
      } as any)
    } finally {
      this.autoDetectInFlight = false
    }
  }

  private async detect (source: 'manual' | 'auto'): Promise<DetectedGameFiles> {
    this.trace(`info [GameFilesAutoDetector] detect start source=${source}, platform=${process.platform}`)
    const debug: GameFilesAutoDetectorDebug = {
      source,
      platform: process.platform,
      selectedProcessCandidate: null,
      selectedProcessRejectedReason: null,
      installDirFromExePath: null,
      installDirFallbackCandidates: [],
      clientLogCandidates: [],
      gameConfigCandidates: []
    }

    const exePath = await this.detectRunningPoeExePath(debug)
    let installDir: string | null = exePath ? path.dirname(exePath) : null

    if (installDir) {
      debug.installDirFromExePath = installDir
      this.trace(`info [GameFilesAutoDetector] installDir from exePath=${installDir}`)
    } else {
      const installDirChecks = await this.checkPathCandidates(this.installDirCandidates())
      debug.installDirFallbackCandidates = installDirChecks
      this.logPathCandidates('installDir fallback candidates', installDirChecks)
      installDir = this.firstExistingFromChecks(installDirChecks)
    }

    const clientLogChecks = await this.checkPathCandidates(this.clientLogCandidates(installDir))
    debug.clientLogCandidates = clientLogChecks
    this.logPathCandidates('Client.txt candidates', clientLogChecks)
    const clientLog = this.firstExistingFromChecks(clientLogChecks)

    const gameConfigChecks = await this.checkPathCandidates(this.gameConfigCandidates(installDir))
    debug.gameConfigCandidates = gameConfigChecks
    this.logPathCandidates('production_Config.ini candidates', gameConfigChecks)
    const gameConfig = this.firstExistingFromChecks(gameConfigChecks)

    this.trace(`info [GameFilesAutoDetectorTrace] debug payload=${JSON.stringify(debug)}`)

    return {
      clientLog,
      gameConfig,
      installDir,
      exePath,
      source,
      debug
    }
  }


  private trace (message: string) {
    if (GAME_FILES_AUTO_DETECTOR_TRACE) this.logger.write(message)
  }

  private logDetectedFiles (result: DetectedGameFiles) {
    this.trace(
      `info [GameFilesAutoDetector] source=${result.source}, exePath=${result.exePath ?? '(not found)'}, clientLog=${result.clientLog ?? '(not found)'}, gameConfig=${result.gameConfig ?? '(not found)'}`
    )
  }

  private async detectRunningPoeExePath (debug: GameFilesAutoDetectorDebug): Promise<string | null> {
    if (process.platform === 'win32') {
      return await this.detectRunningPoeExePathWin32(debug)
    }

    // Other platforms already have stable default path candidates below.
    // Keep this conservative until we need process-specific detection there.
    return null
  }

  private async detectRunningPoeExePathWin32 (debug: GameFilesAutoDetectorDebug): Promise<string | null> {
    // Keep the PowerShell side intentionally simple.
    // A previous version filtered with a multi-line Where-Object expression,
    // but joining it with semicolons produced a ParserError in PowerShell.
    // Enumerate processes first and filter PathOfExile candidates in TypeScript
    // so launcher-specific exe names can be handled without fragile PS syntax.
    const script = '$ErrorActionPreference = "SilentlyContinue"; Get-CimInstance Win32_Process | ForEach-Object { $creationDate = if ($_.CreationDate) { $_.CreationDate.ToString("o") } else { "" }; "$($_.Name)`t$($_.ProcessId)`t$creationDate`t$($_.ExecutablePath)" }' 

    try {
      const psResult = await new Promise<{ stdout: string, stderr: string }>((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true }, (error, stdout, stderr) => {
          if (error) reject(Object.assign(error, { stdout, stderr }))
          else resolve({ stdout, stderr })
        })
      })

      const allCandidates = this.parseProcessCandidates(psResult.stdout)
      const candidates = allCandidates.filter(candidate => this.isPoeProcessCandidate(candidate))
      debug.powershell = {
        executed: true,
        error: null,
        stdout: psResult.stdout,
        stderr: psResult.stderr,
        candidates
      }
      this.trace(`info [GameFilesAutoDetector] PowerShell process rows: total=${allCandidates.length}, poeCandidates=${candidates.length}`)
      this.logProcessCandidates(candidates)

      const selected = candidates[0]
      if (!selected) {
        this.trace('info [GameFilesAutoDetector] selected process candidate=(none)')
        debug.selectedProcessCandidate = null
        return null
      }

      debug.selectedProcessCandidate = selected
      this.trace(
        `info [GameFilesAutoDetector] selected process candidate index=0, name=${selected.name}, pid=${selected.processId}, exePath=${selected.executablePath}`
      )

      const exePath = selected.executablePath
      if (!/^PathOfExile.*\.exe$/i.test(path.basename(exePath))) {
        debug.selectedProcessRejectedReason = 'basename guard rejected selected process'
        this.trace(`warn [GameFilesAutoDetector] selected process was rejected by basename guard: ${exePath}`)
        return null
      }

      if (!await this.exists(exePath)) {
        debug.selectedProcessRejectedReason = 'selected executablePath does not exist'
        this.trace(`warn [GameFilesAutoDetector] selected process executablePath does not exist: ${exePath}`)
        return null
      }

      return exePath
    } catch (e: any) {
      debug.powershell = {
        executed: true,
        error: String(e),
        stdout: typeof e?.stdout === 'string' ? e.stdout : '',
        stderr: typeof e?.stderr === 'string' ? e.stderr : '',
        candidates: []
      }
      this.trace(`warn [GameFilesAutoDetector] Failed to detect Path of Exile process by PowerShell: ${String(e)}`)
      return null
    }
  }

  private installDirCandidates (): string[] {
    if (process.platform === 'win32') {
      const dirs = [
        process.env['ProgramFiles(x86)'],
        process.env.ProgramFiles
      ].filter(Boolean) as string[]

      return [
        ...dirs.map(base => path.join(base, 'Grinding Gear Games', 'Path of Exile')),
        ...dirs.map(base => path.join(base, 'Steam', 'steamapps', 'common', 'Path of Exile'))
      ]
    }

    if (process.platform === 'linux') {
      return [
        path.join(app.getPath('home'), '.wine/drive_c/Program Files (x86)/Grinding Gear Games/Path of Exile'),
        path.join(app.getPath('home'), '.local/share/Steam/steamapps/common/Path of Exile')
      ]
    }

    if (process.platform === 'darwin') {
      return [
        path.join(app.getPath('home'), 'Library/Application Support/Path of Exile')
      ]
    }

    return []
  }

  private clientLogCandidates (installDir: string | null): string[] {
    const candidates: string[] = []
    if (installDir) {
      candidates.push(path.join(installDir, 'logs', 'Client.txt'))
    }

    if (process.platform === 'win32') {
      candidates.push(
        'C:\\Program Files (x86)\\Grinding Gear Games\\Path of Exile\\logs\\Client.txt',
        'C:\\Program Files\\Grinding Gear Games\\Path of Exile\\logs\\Client.txt',
        'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Path of Exile\\logs\\Client.txt',
        'C:\\Program Files\\Steam\\steamapps\\common\\Path of Exile\\logs\\Client.txt'
      )
    } else if (process.platform === 'linux') {
      candidates.push(
        path.join(app.getPath('home'), '.wine/drive_c/Program Files (x86)/Grinding Gear Games/Path of Exile/logs/Client.txt'),
        path.join(app.getPath('home'), '.local/share/Steam/steamapps/common/Path of Exile/logs/Client.txt')
      )
    } else if (process.platform === 'darwin') {
      candidates.push(path.join(app.getPath('home'), 'Library/Caches/com.GGG.PathOfExile/Logs/Client.txt'))
    }

    return candidates
  }

  private gameConfigCandidates (installDir: string | null): string[] {
    const candidates: string[] = []
    if (installDir) {
      // Some environments keep it next to the game executable; check it without assuming it exists.
      candidates.push(path.join(installDir, 'production_Config.ini'))
    }

    if (process.platform === 'win32') {
      candidates.push(path.join(app.getPath('documents'), 'My Games\\Path of Exile\\production_Config.ini'))
    } else if (process.platform === 'linux') {
      candidates.push(
        path.join(app.getPath('documents'), 'My Games/Path of Exile/production_Config.ini'),
        path.join(app.getPath('home'), '.local/share/Steam/steamapps/compatdata/238960/pfx/drive_c/users/steamuser/Documents/My Games/Path of Exile/production_Config.ini')
      )
    } else if (process.platform === 'darwin') {
      candidates.push(path.join(app.getPath('appData'), 'Path of Exile/Preferences/production_Config.ini'))
    }

    return candidates
  }

  private isPoeProcessCandidate (candidate: PoeProcessCandidate): boolean {
    const exePath = candidate.executablePath
    if (!exePath) return false

    const exeName = path.basename(exePath)
    return /^PathOfExile.*\.exe$/i.test(candidate.name) ||
      /^PathOfExile.*\.exe$/i.test(exeName) ||
      /\\Path of Exile\\PathOfExile.*\.exe$/i.test(exePath)
  }

  private parseProcessCandidates (stdout: string): PoeProcessCandidate[] {
    return stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [name = '', processId = '', creationDate = '', ...pathParts] = line.split('\t')
        return {
          name,
          processId,
          creationDate,
          executablePath: pathParts.join('\t')
        }
      })
      .filter(candidate => candidate.executablePath)
  }

  private logProcessCandidates (candidates: PoeProcessCandidate[]) {
    if (!candidates.length) {
      this.trace('info [GameFilesAutoDetector] process candidates: none')
      return
    }

    this.trace(`info [GameFilesAutoDetector] process candidates: count=${candidates.length}`)
    for (const [index, candidate] of candidates.entries()) {
      this.trace(
        `info [GameFilesAutoDetector] process candidate[${index}]: name=${candidate.name}, pid=${candidate.processId}, creationDate=${candidate.creationDate || '(unknown)'}, exePath=${candidate.executablePath}`
      )
    }
  }

  private async checkPathCandidates (candidates: string[]): Promise<PathCandidateCheck[]> {
    const seen = new Set<string>()
    const checks: PathCandidateCheck[] = []
    for (const candidate of candidates) {
      if (!candidate || seen.has(candidate)) continue
      seen.add(candidate)
      checks.push({
        filePath: candidate,
        exists: await this.exists(candidate)
      })
    }
    return checks
  }

  private firstExistingFromChecks (checks: PathCandidateCheck[]): string | null {
    return checks.find(check => check.exists)?.filePath ?? null
  }

  private logPathCandidates (label: string, checks: PathCandidateCheck[]) {
    if (!checks.length) {
      this.trace(`info [GameFilesAutoDetector] ${label}: none`)
      return
    }

    this.trace(`info [GameFilesAutoDetector] ${label}: count=${checks.length}`)
    for (const [index, check] of checks.entries()) {
      this.trace(
        `info [GameFilesAutoDetector] ${label}[${index}]: exists=${check.exists ? 'true' : 'false'}, path=${check.filePath}`
      )
    }
  }

  private async findFirstExisting (candidates: string[]): Promise<string | null> {
    const seen = new Set<string>()
    for (const candidate of candidates) {
      if (!candidate || seen.has(candidate)) continue
      seen.add(candidate)
      if (await this.exists(candidate)) return candidate
    }
    return null
  }

  private async exists (filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }
}
