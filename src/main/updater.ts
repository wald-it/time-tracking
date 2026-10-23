/**
 * v1.5 PR B — Auto-Update via electron-updater (#33).
 *
 * Bridge between electron-updater events and the renderer UI:
 * - Subscribes to all updater lifecycle events.
 * - Pushes a normalized `UpdateStatus` to all open windows via IPC.
 * - Provides imperative IPC handlers for "check now" and "install now".
 *
 * Offline policy: errors during the initial silent check are logged but
 * NOT pushed as an `error` status — we don't want a red banner on every
 * offline app start. Errors triggered by an explicit user "check now"
 * are surfaced (so the Settings UI can show "no connection").
 */
import { BrowserWindow, ipcMain } from 'electron'
import log from 'electron-log/main'
import pkg from 'electron-updater'
const { autoUpdater } = pkg
import type { IpcResult, UpdateStatus } from '../shared/types'
import { clearShutdown, releaseHolders, type Holder, type ReleaseOutcome } from '../mcp/holders'

export type { UpdateStatus }

let lastStatus: UpdateStatus = { status: 'idle' }
let lastCheckIso: string | null = null
let suppressNextError = false // for offline-tolerant initial check

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: String(error) }
}

function broadcast(status: UpdateStatus): void {
  lastStatus = status
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('update:status', status)
    }
  }
}

/** Lifecycle events the updater reacts to, normalized for reduceUpdateStatus. */
export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'not-available'; checkedAt: string }
  | { type: 'error'; message: string }

/**
 * The status transition for one updater lifecycle event. Pure on purpose:
 * the event handlers in initAutoUpdater only wire electron-updater events
 * into this function, so the transitions are testable without booting
 * electron-updater (updater.test.ts).
 */
export function reduceUpdateStatus(prev: UpdateStatus, event: UpdaterEvent): UpdateStatus {
  switch (event.type) {
    case 'checking':
      return { status: 'checking' }
    case 'available':
      return { status: 'available', version: event.version }
    case 'progress': {
      const version =
        prev.status === 'available' || prev.status === 'downloading' ? prev.version : ''
      return { status: 'downloading', version, progress: Math.round(event.percent) }
    }
    case 'downloaded':
      return { status: 'ready', version: event.version }
    case 'not-available':
      return { status: 'not-available', checkedAt: event.checkedAt }
    case 'error':
      return { status: 'error', message: event.message }
  }
}

/**
 * Message for holders that ignored the shutdown request (#198).
 *
 * It has to name the actual blocker, because the installer's own wording sends
 * the user looking for a window that does not exist: an MCP server is a
 * child of the AI client, has no window and no tray icon, and carries the app's
 * own executable name under a foreign parent process.
 *
 * A holder registered after the request went out was started mid-update —
 * typically the AI client respawning its server. releaseHolders re-asks such
 * newcomers (#201), but one that still remains should not be blamed for
 * ignoring a request that predates it.
 */
export function blockedByHoldersMessage(
  remaining: Holder[],
  requestedAt: number | null = null
): string {
  const list = remaining.map((h) => `PID ${h.pid}`).join(', ')
  const [uses, reacted] = remaining.length === 1 ? ['benutzt', 'hat'] : ['benutzen', 'haben']
  const base =
    `Das Update kann nicht installiert werden: ${remaining.length} MCP-Server ` +
    `(${list}) ${uses} noch die TimeTrack-Programmdatei und ${reacted} auf die ` +
    'Aufforderung zum Beenden nicht reagiert. Diese Prozesse haben kein Fenster — ' +
    'sie gehören zu einem laufenden AI-Client (Einstellungen → Integrationen). ' +
    'Beende den AI-Client und versuche es erneut.'
  const startedMidUpdate = requestedAt !== null && remaining.some((h) => h.startedAt >= requestedAt)
  return startedMidUpdate
    ? base +
        ' Mindestens einer dieser Server wurde erst während des Updates gestartet — ' +
        'solange der AI-Client läuft, startet er beendete Server automatisch neu.'
    : base
}

/**
 * The install decision (#198), separated from the IPC wiring so its three
 * branches are testable: refuse while holders remain, release-then-install,
 * and clear the shutdown request when the install throws. All dependencies
 * are explicit — the one production caller below passes the real ones.
 */
export async function performUpdateInstall(deps: {
  getEndpointDir: (() => string) | undefined
  release: (dir: string) => Promise<ReleaseOutcome>
  clear: (dir: string) => void
  quitAndInstall: () => void
  notify: (status: UpdateStatus) => void
  logWarn: (msg: string) => void
  logInfo: (msg: string) => void
}): Promise<IpcResult<void>> {
  try {
    // #198 — hand over a directory the installer can actually replace.
    //
    // Every MCP server runs the installed binary in Node mode, so it locks
    // TimeTrack.exe. On this path the installer's own check does not help:
    // it skips entirely when its parent process is TimeTrack.exe, which is
    // exactly what quitAndInstall makes it (see the CHECK_APP_RUNNING guard
    // in electron-builder's allowOnlyOneInstallerInstance.nsh).
    const dir = deps.getEndpointDir?.()
    if (dir) {
      const outcome = await deps.release(dir)
      if (outcome.stale.length > 0) {
        // #201 — pid reused by an unrelated process; the registration was
        // pruned and never counted. Worth a line: it means a server was
        // hard-killed at some point and left its file behind.
        deps.logInfo(
          `[updater] pruned ${outcome.stale.length} stale MCP registration(s) (pid reuse)`
        )
      }
      if (!outcome.ok) {
        const message = blockedByHoldersMessage(outcome.remaining, outcome.requestedAt)
        deps.logWarn(`[updater] update aborted, ${outcome.remaining.length} MCP holder(s) left`)
        deps.notify({ status: 'error', message })
        return fail(message)
      }
      if (outcome.before.length > 0) {
        deps.logInfo(`[updater] released ${outcome.before.length} MCP holder(s) before install`)
      }
    }

    deps.quitAndInstall()
    return ok(undefined)
  } catch (err) {
    // Never leave a shutdown request behind on a failed install — every MCP
    // server started afterwards would exit the moment it saw it.
    const dir = deps.getEndpointDir?.()
    if (dir) deps.clear(dir)
    return fail((err as Error).message)
  }
}

/**
 * Initialize the updater. Must be called after `app.whenReady()`.
 *
 * In dev mode (no packaged app) this is a no-op except for IPC handler
 * registration — `autoUpdater.checkForUpdates()` would error otherwise.
 */
export function initAutoUpdater(opts: { isDev: boolean; getEndpointDir?: () => string }): void {
  // Wire up logger from PR A so updater events land in main.log.
  autoUpdater.logger = log
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false // we surface a button instead

  autoUpdater.on('checking-for-update', () => {
    broadcast(reduceUpdateStatus(lastStatus, { type: 'checking' }))
  })

  autoUpdater.on('update-available', (info: { version: string }) => {
    broadcast(reduceUpdateStatus(lastStatus, { type: 'available', version: info.version }))
  })

  autoUpdater.on('update-not-available', (info: { version: string }) => {
    lastCheckIso = new Date().toISOString()
    broadcast(reduceUpdateStatus(lastStatus, { type: 'not-available', checkedAt: lastCheckIso }))
    log.info(`No update available (current: ${info.version})`)
  })

  autoUpdater.on(
    'download-progress',
    (p: { percent: number; transferred: number; total: number }) => {
      broadcast(reduceUpdateStatus(lastStatus, { type: 'progress', percent: p.percent }))
    }
  )

  autoUpdater.on('update-downloaded', (info: { version: string }) => {
    broadcast(reduceUpdateStatus(lastStatus, { type: 'downloaded', version: info.version }))
  })

  autoUpdater.on('error', (err: Error) => {
    if (suppressNextError) {
      suppressNextError = false
      log.warn('Update check failed (suppressed, likely offline):', err.message)
      broadcast({ status: 'idle' })
      return
    }
    broadcast(reduceUpdateStatus(lastStatus, { type: 'error', message: err.message }))
  })

  // ── IPC handlers ───────────────────────────────────────────
  ipcMain.handle('update:getStatus', (): IpcResult<UpdateStatus> => ok(lastStatus))
  ipcMain.handle('update:getLastCheck', (): IpcResult<string | null> => ok(lastCheckIso))

  ipcMain.handle('update:check', async (): Promise<IpcResult<void>> => {
    if (opts.isDev) {
      return fail('Update-Check ist im Entwicklungsmodus deaktiviert.')
    }
    try {
      lastCheckIso = new Date().toISOString()
      await autoUpdater.checkForUpdates()
      return ok(undefined)
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipcMain.handle(
    'update:install',
    (): Promise<IpcResult<void>> =>
      performUpdateInstall({
        getEndpointDir: opts.getEndpointDir,
        release: releaseHolders,
        clear: clearShutdown,
        // quitAndInstall(isSilent=false, isForceRunAfter=true)
        // — shows the NSIS installer UI, then re-launches TimeTrack.
        quitAndInstall: () => autoUpdater.quitAndInstall(false, true),
        notify: broadcast,
        logWarn: (m) => log.warn(m),
        logInfo: (m) => log.info(m)
      })
  )

  // ── Initial silent check ──────────────────────────────────
  // Don't surface errors here — offline app starts shouldn't show a banner.
  if (!opts.isDev) {
    suppressNextError = true
    lastCheckIso = new Date().toISOString()
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      log.warn('Initial update check failed:', err.message)
    })
  }
}
