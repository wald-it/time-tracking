import {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  ipcMain,
  dialog,
  screen,
  type MenuItemConstructorOptions
} from 'electron'
import log from 'electron-log/main'
import { dirname, join } from 'path'
import { writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import trayRunningIcon from '../../resources/tray-running.png?asset'
import trayStoppedIcon from '../../resources/tray-stopped.png?asset'
import { getDb, getDbPath, recoverZombieEntries, MigrationError } from './db'
import {
  dbErrorDialog,
  hotkeyConflictDialog,
  localeFromSystem,
  migrationErrorDialog,
  appLocale,
  sensitiveSettingDialog,
  trayLabels,
  trayTooltip
} from './mainI18n'
import type { Locale } from '../shared/i18n'
import {
  assertSmokeUserDataIsolated,
  parseSmokeOutPath,
  removeSmokeUserDataDir,
  scheduleRemovalAfterExit,
  setupSmokeUserData
} from './smokeUserData'
import { clearShutdown, pruneDeadHolders } from '../mcp/holders'
import { APP_ID, repairInstallLocation } from './installLocation'
import { registerIpcHandlers } from './ipc'
import { guardWindowLinks } from './externalLinks'
import { localDateKey } from '../shared/dateRanges'
import {
  WINDOW_BOUNDS_KEY,
  createWindowStateKeeper,
  parseWindowState,
  resolveWindow,
  showPlacedWindow
} from './windowBounds'
import {
  startMcpBridge,
  stopMcpBridge,
  generateWriteToken,
  clearWriteToken,
  generateControllerToken,
  clearControllerToken,
  forgetMcpApproval,
  type BridgeDeps
} from './mcpBridge'
import { initAutoUpdater } from './updater'
import {
  changeHotkey,
  hotkeySlot,
  resumeHotkeys,
  suspendHotkeys,
  type HotkeyChange,
  type HotkeySlot
} from './hotkeySlot'
import { readRunning } from './mcpBridgeCore'
import { reconcilePresence, type PresenceDeps } from './graphPresence'
import { graphAccountDepsFor } from './graphHandlers'
import { effectiveClientId, getAccessToken, getStatus } from './graphAccount'
import { applyMiniEnabled, destroyMini, pushMiniState, toggleMini } from './miniWindow'
import {
  generateFeedToken,
  restartFeedServer,
  startFeedServer,
  stopFeedServer,
  type FeedDeps
} from './icalFeed'
import {
  configureIdleWatcher,
  setIdleThresholdMinutes,
  startIdleWatcher,
  stopIdleWatcher,
  rearmIdleWatcher
} from './idle'
import type { Client } from '../shared/types'

// ── Logging (v1.5 PR A) ─────────────────────────────────────────
// electron-log writes to %AppData%\time-tracking\logs\main.log on Windows
// (~/Library/Logs/time-tracking on macOS, ~/.config/time-tracking/logs on
// Linux) — the directory is app.getName(), i.e. package.json → name.
// `spyRendererConsole: true` mirrors renderer console.* into the same
// file via IPC — no separate channel needed. `Object.assign(console, …)`
// routes main-process console.* through the logger too, so existing
// console.error/warn/info calls in db.ts/ipc.ts/etc. land in the file
// without code changes.
log.initialize({ preload: true, spyRendererConsole: true })
log.transports.file.level = 'info'
log.transports.file.maxSize = 5 * 1024 * 1024 // 5 MB, rotates to .old
Object.assign(console, log.functions)

// Catch-all for crashes that escape try/catch.
process.on('uncaughtException', (err) => {
  log.error('uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection:', reason)
})

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

// ── Single-instance enforcement (v1.13.2) ───────────────────────
// Closing the window only hides to tray, so accidental second launches are
// common. A second instance can't acquire Chromium's LevelDB lock on the
// shared profile — its localStorage silently degrades to in-memory and all
// renderer-side prefs set there are lost on exit — and it would also write
// to the same SQLite DB in parallel. Quit the newcomer and focus the
// existing window instead. Smoke-test mode is exempt so a locally running
// TimeTrack instance can't silently break a smoke run on a dev machine.
// (argv is scanned once here; the whenReady smoke block reuses smokeTestArg.)
const smokeTestArg = process.argv.find((a) => a.startsWith('--smoke-test'))

// Smoke runs never see the user's data: userData moves to a fresh temp
// directory before the app is ready (Chromium reads it at startup). The
// default locations are remembered so the smoke block can refuse to open a
// database that still resolves to one of them. A failed setup ends the run
// right here with an ok:false result — thrown at module level it would only
// be logged by the uncaughtException handler and the run would hang.
/** Log the smoke result and write it to `outPath` (exit code stays authoritative). */
function writeSmokeResult(outPath: string, result: object, level: 'log' | 'error'): void {
  const payload = JSON.stringify(result)
  console[level](`[smoke] ${payload}`)
  if (outPath) {
    try {
      writeFileSync(outPath, payload, 'utf8')
    } catch (e) {
      console.warn('[smoke] could not write to outPath:', (e as Error).message)
    }
  }
}

let smokeUserData: string | undefined
let smokeProtectedDirs: string[] = []
if (smokeTestArg !== undefined) {
  const setup = setupSmokeUserData(app)
  if (setup.ok) {
    smokeUserData = setup.userData
    smokeProtectedDirs = setup.protectedDirs
  } else {
    writeSmokeResult(
      parseSmokeOutPath(smokeTestArg),
      { ok: false, error: setup.error, electronVersion: process.versions.electron },
      'error'
    )
    app.exit(1)
  }
}

const isSecondInstance = smokeTestArg === undefined && !app.requestSingleInstanceLock()
if (isSecondInstance) {
  // quit() is asynchronous — the whenReady handler below early-returns on
  // isSecondInstance so the loser never opens the DB, registers global
  // hotkeys, or creates windows while its quit is still in flight.
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    } else {
      // Startup race: second launch arrived before createWindow ran.
      log.info('second-instance signal received before main window exists — ignored')
    }
  })
}

// ── Hotkey registration state ────────────────────────────────────
// Tracked per-slot so `registerHotkey` and `registerMiniHotkey` can update
// independently without clobbering each other (no more `unregisterAll`).
const toggleSlot: HotkeySlot = hotkeySlot(() => {
  mainWindow?.webContents.send('timer:hotkey-toggle')
})
const miniSlot: HotkeySlot = hotkeySlot(() => toggleMini())

// ── State for tray quick-start ──────────────────────────────────
let cachedActiveClients: Client[] = []
let isTimerRunning = false
let runningLabel = ''
let lastTodaySeconds = 0

/** Format seconds as `HH:MM` (no seconds) for the tray tooltip. */
function fmtHHMM(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function refreshActiveClients(): void {
  try {
    const db = getDb()
    cachedActiveClients = db
      .prepare(`SELECT * FROM clients WHERE active = 1 ORDER BY name ASC`)
      .all() as Client[]
  } catch (err) {
    console.warn('[tray] could not refresh client cache:', err)
    cachedActiveClients = []
  }
}

/**
 * The app language for everything index.ts shows: tray, start-up dialogs, the
 * update notification (#296). The shared rule that never throws and keeps the
 * last language while the handle is closed after a restore attempt
 * (mainI18n.appLocale), the same answer the IPC dialogs get.
 */
function appLanguage(): Locale {
  return appLocale(getDb, () => app.getPreferredSystemLanguages())
}

function buildTrayMenu(locale: Locale = appLanguage()): Menu {
  const items: MenuItemConstructorOptions[] = []
  const text = trayLabels(locale)

  items.push({
    label: isTimerRunning ? `● ${runningLabel}` : text.idle,
    enabled: false
  })
  items.push({ type: 'separator' })

  if (isTimerRunning) {
    items.push({
      label: text.stop,
      click: () => mainWindow?.webContents.send('timer:tray-stop')
    })
  } else if (cachedActiveClients.length > 0) {
    const quickStart: MenuItemConstructorOptions[] = cachedActiveClients
      .slice(0, 10) // soft limit so menu stays usable
      .map((c) => ({
        label: `▶ ${c.name}`,
        click: () => mainWindow?.webContents.send('timer:tray-quick-start', c.id)
      }))
    items.push({ label: text.quickStart, enabled: false })
    items.push(...quickStart)
  } else {
    items.push({ label: text.noClients, enabled: false })
  }

  items.push({ type: 'separator' })
  items.push({
    label: text.showWindow,
    click: () => {
      mainWindow?.show()
      mainWindow?.focus()
    }
  })
  items.push({ type: 'separator' })
  items.push({
    label: text.quit,
    click: () => {
      isQuitting = true
      app.quit()
    }
  })

  return Menu.buildFromTemplate(items)
}

function updateTray(running: boolean, label: string, todaySeconds: number): void {
  if (!tray) return
  isTimerRunning = running
  runningLabel = label
  lastTodaySeconds = todaySeconds
  // State-aware tray glyph (PR D #16/#42 follow-up): green clock when running,
  // grey clock when idle. Both files live in resources/ and are bundled by
  // electron-vite's `?asset` resolver.
  tray.setImage(running ? trayRunningIcon : trayStoppedIcon)
  // Tooltip format (v1.2 #31), in the app language since #296:
  //   running: `● {client} · Heute {HH:MM}`
  //   idle:    `TimeTrack — Heute {HH:MM}`
  const locale = appLanguage()
  tray.setToolTip(trayTooltip(locale, running, label, fmtHHMM(todaySeconds)))
  tray.setContextMenu(buildTrayMenu(locale))
}

/** Log a refused change; the slot itself is left as `changeHotkey` says. */
function logHotkeyChange(tag: string, accelerator: string, change: HotkeyChange): HotkeyChange {
  if (!change.ok) {
    console.warn(
      `[${tag}] ${accelerator} not registered (${change.reason}); ` +
        (change.previousKept ? 'previous kept' : 'previous lost as well')
    )
  }
  return change
}

function registerHotkey(accelerator: string): HotkeyChange {
  return logHotkeyChange(
    'hotkey',
    accelerator,
    changeHotkey(globalShortcut, toggleSlot, accelerator, miniSlot.current)
  )
}

/**
 * Mini-Widget hotkey — toggles widget visibility (only when widget is
 * enabled in Settings). Tracked separately from `hotkey_toggle` so changing
 * one doesn't clobber the other (we used to call `unregisterAll`).
 */
function registerMiniHotkey(accelerator: string): HotkeyChange {
  return logHotkeyChange(
    'mini-hotkey',
    accelerator,
    changeHotkey(globalShortcut, miniSlot, accelerator, toggleSlot.current)
  )
}

/**
 * Suspend all global shortcuts — used while the Settings view is capturing
 * a new hotkey, otherwise pressing the existing combo (e.g. Alt+Shift+S)
 * fires the registered handler instead of being captured by the renderer.
 * Restored via {@link resumeGlobalShortcuts}.
 */
function suspendGlobalShortcuts(): void {
  suspendHotkeys(globalShortcut, [toggleSlot, miniSlot])
}

function resumeGlobalShortcuts(): void {
  for (const accelerator of resumeHotkeys(globalShortcut, [toggleSlot, miniSlot])) {
    console.warn(`[hotkey] ${accelerator} could not be registered again after capture`)
  }
}

function applyAutoStart(enabled: boolean): void {
  // Guard: in dev (`pnpm dev`), `process.execPath` points at
  // `node_modules/electron/dist/electron.exe` — registering that as a
  // Windows login item makes Windows launch the bare Electron binary
  // (without an app path) at next login, which pops up Electron's
  // default welcome window. Only persist the autostart entry from a
  // packaged build where execPath is the real `TimeTrack.exe`.
  if (!app.isPackaged) return
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: []
  })
}

function loadStartupSettings(): void {
  try {
    const db = getDb()
    const rows = db.prepare(`SELECT key, value FROM settings`).all() as Array<{
      key: string
      value: string
    }>
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    const idleMin = parseInt(map.idle_threshold_minutes ?? '5', 10)
    setIdleThresholdMinutes(Number.isFinite(idleMin) ? idleMin : 5)
    const hotkey = map.hotkey_toggle ?? 'Alt+Shift+S'
    registerHotkey(hotkey)
    const auto = map.auto_start === '1'
    applyAutoStart(auto)
    // v1.4 PR B — mini-widget hotkey + restore visibility from last session.
    const miniHotkey = map.mini_hotkey ?? 'Alt+Shift+M'
    const miniHotkeyOk = registerMiniHotkey(miniHotkey).ok
    if (!miniHotkeyOk && map.mini_enabled === '1') {
      // Surface the conflict at startup so the user knows their hotkey
      // is silently dead. Non-blocking dialog — the app continues to work,
      // toggling via Settings still works.
      dialog.showMessageBox({
        type: 'warning',
        ...hotkeyConflictDialog(appLanguage(), miniHotkey)
      })
    }
    if (map.mini_enabled === '1') applyMiniEnabled(true)
  } catch (err) {
    console.warn('[startup] settings load failed (using defaults):', err)
    registerHotkey('Alt+Shift+S')
  }
}

/**
 * Default window size: the 1280px the Messinstrument screens are drawn for,
 * clamped to the primary display's work area (taskbar excluded). Minimum
 * 760 × 600 — at 760 the content column still fits the entry table's 640px.
 * A size and position from the last session wins when it is still on screen
 * (`windowBounds.ts`).
 */
const DEFAULT_WINDOW = { width: 1280, height: 860 }
const MIN_WINDOW = { width: 760, height: 600 }
/** Resizing and moving fire continuously; store once the window has settled. */
const WINDOW_SAVE_DEBOUNCE_MS = 500

function loadWindowState(): ReturnType<typeof parseWindowState> {
  try {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(WINDOW_BOUNDS_KEY) as { value: string } | undefined
    return parseWindowState(row?.value)
  } catch (err) {
    console.warn('[window] bounds load failed (using default):', err)
    return null
  }
}

/**
 * Stores the main window's normal bounds and maximized flag: debounced while it
 * is resized or moved, at once when it minimizes, hides to the tray or the app
 * quits — so neither a crash nor a kill loses more than the last half second.
 */
const windowState = createWindowStateKeeper({
  delayMs: WINDOW_SAVE_DEBOUNCE_MS,
  write: (value) => {
    try {
      getDb()
        .prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
        .run(WINDOW_BOUNDS_KEY, value)
    } catch (err) {
      console.warn('[window] bounds save failed:', err)
    }
  }
})

function createWindow(): void {
  const placed = resolveWindow(
    loadWindowState(),
    screen.getAllDisplays().map((d) => d.workArea),
    screen.getPrimaryDisplay().workArea,
    DEFAULT_WINDOW,
    MIN_WINDOW
  )
  mainWindow = new BrowserWindow({
    ...placed.bounds,
    minWidth: placed.minSize.width,
    minHeight: placed.minSize.height,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Windows can size a window created with x/y on a monitor whose scaling
  // differs from the primary's wrongly; setting the bounds once more after
  // creation puts it right (owner review).
  mainWindow.setBounds(placed.bounds)

  mainWindow.on('ready-to-show', () => {
    showPlacedWindow(mainWindow!, placed.maximized)
  })

  const changed = (): void => windowState.changed(mainWindow)
  mainWindow.on('resize', changed)
  mainWindow.on('move', changed)
  mainWindow.on('maximize', changed)
  mainWindow.on('unmaximize', changed)
  mainWindow.on('minimize', () => windowState.flush())

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      windowState.flush(mainWindow)
      mainWindow?.hide()
    }
  })

  // New windows never open; web links go to the system browser, nothing else
  // does; the window never navigates away from the app.
  guardWindowLinks(mainWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Teams presence mirroring (#132): poked from the `tray:update` choke point,
 * which fires on every timer state change from every source (UI, tray, hotkey,
 * mini-widget, idle handlers — and external writes via the renderer resync).
 * Fire-and-forget by contract; the reconciler swallows and logs failures.
 */
function pokePresence(): void {
  try {
    const db = getDb()
    const account = graphAccountDepsFor(db)
    const deps: PresenceDeps = {
      getSetting: account.getSetting,
      getAccountStatus: () => {
        const s = getStatus(account)
        return {
          connected: s.connected,
          personalAccount: s.personalAccount,
          grantedScopes: s.grantedScopes
        }
      },
      getAccessToken: () => getAccessToken(account),
      getClientId: () => effectiveClientId(account),
      log: (m) => log.info(m)
    }
    void reconcilePresence(deps, readRunning(db))
  } catch (err) {
    log.warn('[presence] poke failed', err)
  }
}

/** iCal feed (#169): deps + token bootstrap. */
function icalFeedDeps(): FeedDeps {
  return {
    getDb,
    getSetting: (key) => mcpBridgeDeps().getSetting(key),
    log: (m) => log.info(m)
  }
}

/** The token is persistent (subscribers store the URL) — mint it only once. */
function ensureFeedToken(): void {
  const current = icalFeedDeps().getSetting('ical_feed_token')
  if (!current || current === '') {
    getDb()
      .prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ical_feed_token', ?)`)
      .run(generateFeedToken())
  }
}

/** Dependencies handed to the MCP write bridge (all resolved lazily at call time). */
function mcpBridgeDeps(): BridgeDeps {
  return {
    getDb,
    refreshTray: () => {
      refreshActiveClients()
      tray?.setContextMenu(buildTrayMenu())
    },
    broadcast: (channel, payload) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(channel, payload)
      }
    },
    getMainWindow: () => mainWindow,
    getSetting: (key) =>
      (
        getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
          | { value: string }
          | undefined
      )?.value
  }
}

app.whenReady().then(async () => {
  // Lock loser (v1.13.2): app.quit() above is async and ready can fire
  // before the quit lands. Bail out before touching the DB, hotkeys, tray,
  // or windows — otherwise the dying instance steals global shortcuts and
  // runs recoverZombieEntries against the primary's live DB.
  if (isSecondInstance) return

  electronApp.setAppUserModelId('com.timetrack.app')

  // Smoke-test mode (CI release pipeline). When invoked with
  // `--smoke-test=<path>`, open a fresh DB in the temp userData set up
  // at module load (never the user's live DB), which runs migrations against
  // the packaged better-sqlite3 binary), write a JSON status to
  // <path>, and exit. No window, no tray, no IPC handlers.
  // This is the v1.2 packaged-binary smoke check (E11) that catches
  // native-module and packaging regressions — on every PR since #269.
  if (smokeTestArg !== undefined) {
    const outPath = parseSmokeOutPath(smokeTestArg)
    let smokeDb: ReturnType<typeof getDb> | undefined
    // Close the DB (Windows keeps open files undeletable), drop the temp
    // userData and exit. Chromium holds its profile files until the process
    // is gone, so on Windows the in-process removal fails and a detached
    // cleaner finishes the job after exit. Cleanup never fails the run.
    const finishSmoke = (code: number): void => {
      try {
        smokeDb?.close()
      } catch {
        /* best-effort */
      }
      if (smokeUserData && !removeSmokeUserDataDir(smokeUserData)) {
        if (!scheduleRemovalAfterExit(smokeUserData)) {
          console.warn(`[smoke] could not remove temp userData ${smokeUserData}`)
        }
      }
      app.exit(code)
    }
    try {
      if (!smokeUserData || app.getPath('userData') !== smokeUserData) {
        throw new Error('smoke test refused to run: temp userData is not in effect')
      }
      assertSmokeUserDataIsolated(app.getPath('userData'), smokeProtectedDirs)
      const db = getDb()
      smokeDb = db
      const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as {
        v: number | null
      }

      // PDF pipeline smoke check (v1.3): seed a single client + entry,
      // build the HTML payload, render via the hidden BrowserWindow.
      // Catches regressions in printToPDF / Chromium / template wiring
      // against the packaged binary, not just the unit-tested HTML string.
      const { buildPdfPayload, buildPdfHtml } = await import('./pdf')
      const { renderPdfBuffer } = await import('./pdfWindow')
      let pdfBytes = 0
      try {
        db.prepare(
          `INSERT OR IGNORE INTO clients (id, name, color, rate_cent)
             VALUES (9999, '__smoke__', '#4f46e5', 0)`
        ).run()
        // 08:00–09:00 local today, asked for as today's local day: the PDF
        // range is local, so the row lands in the attachment in any zone.
        const now = new Date()
        const today = localDateKey(now)
        const startIso = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8).toISOString()
        const stopIso = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9).toISOString()
        db.prepare(
          `INSERT INTO entries (client_id, description, started_at, stopped_at)
             VALUES (9999, 'smoke', ?, ?)`
        ).run(startIso, stopIso)
        const payload = buildPdfPayload(
          db,
          {
            clientId: 9999,
            fromIso: today,
            toIso: today
          },
          ''
        )
        const html = buildPdfHtml(payload)
        const buf = await renderPdfBuffer({ html })
        pdfBytes = buf.length
      } finally {
        // Always clean up. The DB is a throwaway in the temp userData, so
        // this only keeps the run self-contained.
        try {
          db.prepare(`DELETE FROM entries WHERE client_id = 9999`).run()
          db.prepare(`DELETE FROM clients WHERE id = 9999`).run()
        } catch {
          /* best-effort */
        }
      }

      const result = {
        ok: true as const,
        schemaVersion: row.v ?? 0,
        dbPath: app.getPath('userData'),
        sessionData: app.getPath('sessionData'),
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node,
        pdfBytes
      }
      writeSmokeResult(outPath, result, 'log')
      finishSmoke(0)
    } catch (err) {
      writeSmokeResult(
        outPath,
        { ok: false, error: (err as Error).message, electronVersion: process.versions.electron },
        'error'
      )
      finishSmoke(1)
    }
    return
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  try {
    getDb()
  } catch (err) {
    // The language setting lives in the database that just failed to open,
    // so these two follow the system language (#270).
    const locale = localeFromSystem(app.getPreferredSystemLanguages())
    const box =
      err instanceof MigrationError
        ? migrationErrorDialog(locale, {
            version: err.migration.version,
            name: err.migration.name,
            cause: err.cause.message,
            backupPath: err.backupPath
          })
        : dbErrorDialog(locale, (err as Error).message)
    dialog.showErrorBox(box.title, box.message)
    isQuitting = true
    app.quit()
    return
  }
  recoverZombieEntries()
  registerIpcHandlers({
    refreshTrayClients: () => {
      refreshActiveClients()
      tray?.setContextMenu(buildTrayMenu())
    },
    // #296: menu and tooltip in the new language right away, not at the next
    // timer event.
    refreshTrayLanguage: () => updateTray(isTimerRunning, runningLabel, lastTodaySeconds),
    setHotkey: (accelerator) => registerHotkey(accelerator),
    setAutoStart: (enabled) => applyAutoStart(enabled),
    setIdleThreshold: (minutes) => setIdleThresholdMinutes(minutes),
    setMiniEnabled: (enabled) => applyMiniEnabled(enabled),
    setMiniHotkey: (accelerator) => registerMiniHotkey(accelerator),
    setMcpWriteEnabled: (enabled) => {
      if (enabled) {
        generateWriteToken()
        startMcpBridge(mcpBridgeDeps())
      } else {
        clearWriteToken()
        // #301: switching write access off ends any approval, also while the
        // controller keeps the bridge running.
        forgetMcpApproval()
        // The bridge socket stays up while the controller scope needs it.
        if (mcpBridgeDeps().getSetting('controller_enabled') !== '1') stopMcpBridge()
      }
    },
    setControllerEnabled: (enabled) => {
      if (enabled) {
        generateControllerToken()
        startMcpBridge(mcpBridgeDeps())
      } else {
        clearControllerToken()
        if (mcpBridgeDeps().getSetting('mcp_write_enabled') !== '1') stopMcpBridge()
      }
    },
    pokePresence,
    setIcalFeedEnabled: (enabled) => {
      if (enabled) {
        ensureFeedToken()
        startFeedServer(icalFeedDeps())
      } else {
        stopFeedServer()
      }
    },
    restartIcalFeed: () => {
      if (icalFeedDeps().getSetting('ical_feed_enabled') === '1') {
        restartFeedServer(icalFeedDeps())
      }
    },
    forgetMcpApproval,
    // #272 (A3): the native confirmation for a setting that widens access.
    confirmSensitiveSetting: async (change) => {
      const opts = sensitiveSettingDialog(appLanguage(), change)
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
      const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      return res.response === 1
    }
  })
  createWindow()

  // #198 — a .shutdown request survives a cancelled or mid-copy-failed
  // installer (customInstall never ran) and would sit there forever. The app
  // starting is proof that no install is in progress, so clear it here.
  clearShutdown(dirname(getDbPath()))

  // #209 — same anchor, same reasoning: no install is in progress, so any
  // registration whose process is gone is simply litter. Servers prune their
  // predecessors when they start too, but that only helps machines where
  // servers keep starting; this covers the app running without them.
  pruneDeadHolders(dirname(getDbPath()))

  // #200 — repair the value the installer reads to tell an upgrade from a
  // fresh install. Left empty it offers a directory page that looks like an
  // ordinary first install but uninstalls the existing one when a different
  // path is chosen; that cost one installation on 2026-08-03.
  //
  // Packaged Windows builds only: in dev the exe is electron.exe under
  // node_modules and there is no installation to describe. Fire-and-forget,
  // because two reg.exe reads have no business sitting in front of the window.
  if (process.platform === 'win32' && app.isPackaged) {
    void repairInstallLocation(dirname(app.getPath('exe')), APP_ID, console).catch((err) =>
      log.warn('[install-location] check failed:', err)
    )
  }

  // v1.5 PR B — init auto-updater after the main window exists so events
  // can be broadcast to the renderer immediately.
  // getEndpointDir anchors the MCP holder registry (#198) on the directory the
  // DB actually lives in — the same anchor mcpBridge.ts uses, so a custom
  // TIMETRACK_DB_PATH keeps app and MCP servers pointing at one place.
  // getSetting carries the update-check switch (#273).
  initAutoUpdater({
    isDev: is.dev,
    getEndpointDir: () => dirname(getDbPath()),
    getSetting: (key) => mcpBridgeDeps().getSetting(key),
    // #296: the same never-throwing app language as tray and dialogs.
    getLocale: appLanguage
  })

  refreshActiveClients()
  configureIdleWatcher({ getWindow: () => mainWindow })
  loadStartupSettings()

  // v1.14 #127 / v1.17 #133 — start the local bridge only when at least one
  // scope is opted in. Fresh tokens are minted per app run (rotation); the
  // socket lives on the primary instance only (this code path is skipped for
  // second-instance / smoke runs above).
  const writeOn = mcpBridgeDeps().getSetting('mcp_write_enabled') === '1'
  const controllerOn = mcpBridgeDeps().getSetting('controller_enabled') === '1'
  if (writeOn) generateWriteToken()
  if (controllerOn) generateControllerToken()
  if (writeOn || controllerOn) startMcpBridge(mcpBridgeDeps())

  // v1.17 #169 — local iCal feed, only while the app runs (like the bridge).
  if (mcpBridgeDeps().getSetting('ical_feed_enabled') === '1') {
    ensureFeedToken()
    startFeedServer(icalFeedDeps())
  }

  tray = new Tray(trayStoppedIcon)
  updateTray(false, '', 0)
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.focus()
    } else {
      mainWindow?.show()
      mainWindow?.focus()
    }
  })

  // Renderer notifies main to update tray state + drive idle watcher.
  // `startedAt` (v1.4 PR B) is forwarded to the mini-widget so it can tick
  // the elapsed time locally without round-trips.
  ipcMain.on(
    'tray:update',
    (
      _event,
      running: boolean,
      label: string,
      todaySeconds: number,
      startedAt: string | null = null
    ) => {
      updateTray(running, label, todaySeconds ?? lastTodaySeconds)
      pushMiniState({ running, label, startedAt })
      if (running) startIdleWatcher()
      else stopIdleWatcher()
      pokePresence()
    }
  )

  // Mini-Widget → main: forward play/stop intent to the main renderer,
  // which owns the timer state machine. We piggy-back on the existing
  // tray-stop / hotkey-toggle channels so there's only one source of truth.
  ipcMain.on('mini:request-stop', () => {
    mainWindow?.webContents.send('timer:tray-stop')
  })
  ipcMain.on('mini:request-start', () => {
    // hotkey-toggle starts when no timer is running and falls back to the
    // first active client — exactly what we want for the play button.
    mainWindow?.webContents.send('timer:hotkey-toggle')
  })

  // Settings view → main: pause/resume registered global shortcuts during
  // hotkey capture so the user can rebind a key (e.g. Alt+Shift+S) without
  // the existing handler firing first and swallowing the keystroke.
  ipcMain.on('hotkey:beginCapture', () => suspendGlobalShortcuts())
  ipcMain.on('hotkey:endCapture', () => resumeGlobalShortcuts())

  // Renderer dismissed idle modal — re-arm.
  ipcMain.on('idle:dismiss', () => rearmIdleWatcher())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
  windowState.flush(mainWindow)
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopIdleWatcher()
  destroyMini()
  stopMcpBridge()
  stopFeedServer()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
