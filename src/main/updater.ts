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
import { BrowserWindow, ipcMain, Notification } from 'electron'
import log from 'electron-log/main'
import pkg, { type UpdateCheckResult } from 'electron-updater'
const { autoUpdater } = pkg
import type { IpcResult, UpdateStatus } from '../shared/types'
import { isUpdateCheckEnabled, UPDATE_CHECK_SETTING_KEY } from '../shared/updateCheck'
import { clearShutdown, releaseHolders, type Holder, type ReleaseOutcome } from '../mcp/holders'
import type { Locale } from '../shared/i18n'
import { dialogT, updateDownloadedNotification } from './mainI18n'

export type { UpdateStatus }

let lastStatus: UpdateStatus = { status: 'idle' }
let lastCheckIso: string | null = null
/**
 * The silent start-up check while it runs (#284). Its `error` events are held
 * here instead of broadcast, and decided when the check settles: only the error
 * that is the check's own rejection stays quiet (offline start); any other —
 * such as an early failure of the download the check started — goes out.
 * A one-shot "swallow the next error" flag got this wrong: left set after a
 * successful check, it ate the next unrelated error.
 */
interface StartupCheck {
  held: Error[]
  /** "Check now" joined it; from then on its errors are the user's. */
  joined: boolean
}
let startupCheck: StartupCheck | null = null

/**
 * Show the "update downloaded" notification once `result`'s download is done:
 * what `checkForUpdatesAndNotify` used to show (#309), in the app language at
 * that moment. The text is our own (mainI18n.updateDownloadedNotification).
 * electron-updater 6.8.11's private `AppUpdater.formatDownloadNotification`
 * default, "{appName} version {version} has been downloaded and will be
 * automatically installed on exit", was wrong twice for TimeTrack:
 * `autoInstallOnAppQuit` is false (installing takes the "Restart now" key),
 * and `{appName}` came from `app.getName()`, the package name `time-tracking`.
 *
 * A failed download is reported through the `error` event, so its rejection
 * is only caught here, not reported twice.
 */
function notifyWhenDownloaded(result: UpdateCheckResult | null, getLocale: () => Locale): void {
  if (!result?.downloadPromise) return
  // Never throws: the start-up check is settled right after this call.
  const version = result.updateInfo?.version ?? ''
  result.downloadPromise
    .then(
      () => {
        // Read when the download is done, so a language switch meanwhile counts.
        // index.ts passes mainI18n.appLocale (#296), which never throws and
        // gives the same answer as the tray and the dialogs. Should a getter
        // throw anyway, the notification still shows, in German (#309).
        let locale: Locale = 'de'
        try {
          locale = getLocale()
        } catch (err) {
          log.warn('[updater] could not read the language for the notification', err)
        }
        new Notification(updateDownloadedNotification(locale, version)).show()
      },
      () => undefined
    )
    .catch((err: unknown) => log.warn('[updater] could not show the download notification', err))
}

function broadcastError(err: Error): void {
  broadcast(reduceUpdateStatus(lastStatus, { type: 'error', message: err.message }))
}

function settleStartupCheck(run: StartupCheck, rejection: Error | null): void {
  if (startupCheck === run) startupCheck = null
  for (const err of run.held) {
    if (err === rejection) {
      log.warn('Update check failed (suppressed, likely offline):', err.message)
      broadcast({ status: 'idle' })
    } else {
      broadcastError(err)
    }
  }
  if (rejection && !run.joined && !run.held.includes(rejection)) {
    log.warn('Initial update check failed:', rejection.message)
  }
}

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
  locale: Locale,
  remaining: Holder[],
  requestedAt: number | null = null
): string {
  // In the app language (#296 part B): singular and plural are their own texts.
  const t = dialogT(locale)
  const vars = { count: remaining.length, list: remaining.map((h) => `PID ${h.pid}`).join(', ') }
  const base = t(
    remaining.length === 1 ? 'mainError.update.blockedOne' : 'mainError.update.blockedMany',
    vars
  )
  const startedMidUpdate = requestedAt !== null && remaining.some((h) => h.startedAt >= requestedAt)
  return startedMidUpdate ? `${base} ${t('mainError.update.startedMidUpdate')}` : base
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
  /** The language of the refusal (#296); must not throw (appLocale). */
  locale: () => Locale
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
        const message = blockedByHoldersMessage(
          deps.locale(),
          outcome.remaining,
          outcome.requestedAt
        )
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
 * The switch as stored (#273). A failed read must not take the rest of the
 * startup down with it (initAutoUpdater runs in the middle of whenReady), and
 * it must not contact GitHub for someone who switched the check off — so an
 * unreadable setting skips the check at start. "Check now" still works.
 */
function startupCheckEnabled(getSetting: (key: string) => string | undefined): boolean {
  try {
    return isUpdateCheckEnabled(getSetting(UPDATE_CHECK_SETTING_KEY))
  } catch (err) {
    log.warn('[updater] could not read the update-check setting, skipping the check at start:', err)
    return false
  }
}

/**
 * Initialize the updater. Must be called after `app.whenReady()`.
 *
 * In dev mode (no packaged app) this is a no-op except for IPC handler
 * registration — `autoUpdater.checkForUpdates()` would error otherwise.
 *
 * The switch under Settings → About → Updates (#273) is read once, here: it
 * decides the check at start, so changing it takes effect at the next start.
 * A download already running when it is switched off finishes. The language
 * of the download notification is read when it fires (#309).
 */
export function initAutoUpdater(opts: {
  isDev: boolean
  getEndpointDir?: () => string
  getSetting: (key: string) => string | undefined
  /** The app language of the download notification, read when it fires. */
  getLocale: () => Locale
}): void {
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
    if (startupCheck) {
      startupCheck.held.push(err)
      return
    }
    broadcastError(err)
  })

  // ── IPC handlers ───────────────────────────────────────────
  ipcMain.handle('update:getStatus', (): IpcResult<UpdateStatus> => ok(lastStatus))
  ipcMain.handle('update:getLastCheck', (): IpcResult<string | null> => ok(lastCheckIso))

  ipcMain.handle('update:check', async (): Promise<IpcResult<void>> => {
    if (opts.isDev) {
      return fail(dialogT(opts.getLocale())('mainError.update.devMode'))
    }
    try {
      // An explicit check surfaces its errors, also when it joins a start-up
      // check that is still running (electron-updater shares one promise).
      if (startupCheck) {
        startupCheck.joined = true
        startupCheck = null
      }
      lastCheckIso = new Date().toISOString()
      const result = await autoUpdater.checkForUpdates()
      // A failed download reaches the UI as an `error` event; without a
      // handler it would also land in main.log as an unhandled rejection (#309).
      result?.downloadPromise?.catch(() => undefined)
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
        logInfo: (m) => log.info(m),
        locale: opts.getLocale
      })
  )

  // ── Initial silent check ──────────────────────────────────
  // Don't surface errors here — offline app starts shouldn't show a banner.
  // Switched off (#273): no request to GitHub at start, so nothing to download.
  if (!opts.isDev && startupCheckEnabled(opts.getSetting)) {
    const run: StartupCheck = { held: [], joined: false }
    startupCheck = run
    lastCheckIso = new Date().toISOString()
    // electron-updater emits `error` and then rejects with the same object
    // (AppUpdater.checkForUpdates), which is how the offline case is told
    // apart from everything else that fails meanwhile.
    // Not checkForUpdatesAndNotify: it chains `void downloadPromise.then(notify)`
    // (electron-updater 6.8.11, AppUpdater.js:294), and that new promise
    // rejects unhandled when the download fails, whatever we attach to
    // downloadPromise (#309). Same check, our own notification.
    autoUpdater
      .checkForUpdates()
      .then(
        (result) => {
          // Both always run: the download's rejection must be handled even if
          // settling throws (a broadcast to a window that is going away), and
          // the check must be settled even if the notify step throws, or its
          // held errors would stay held for the rest of the run (#284).
          try {
            notifyWhenDownloaded(result, opts.getLocale)
          } finally {
            settleStartupCheck(run, null)
          }
        },
        (err: Error) => settleStartupCheck(run, err)
      )
      // Whatever settling throws is a defect: logged as an error, not left as
      // an unhandled rejection (#309).
      .catch((err: unknown) => log.error('[updater] settling the start-up check failed', err))
  }
}
