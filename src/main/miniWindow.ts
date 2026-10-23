import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { getDb } from './db'
import { guardWindowLinks } from './externalLinks'

/**
 * v1.4 PR B — Mini-Widget. A frameless 200×40 always-on-top overlay that
 * shows the running timer at a glance. Position is persisted to the
 * `settings` table; sentinel `-1/-1` means "never positioned, use the
 * bottom-right of the primary display".
 *
 * B2: window factory + show/hide/destroy + position persistence.
 * B3 (this commit): push-state-sync from main, hotkey toggle helper,
 *   cached last state so a freshly-shown widget renders immediately.
 */

export interface MiniState {
  running: boolean
  label: string
  startedAt: string | null
}

let miniWindow: BrowserWindow | null = null
let positionDebounce: NodeJS.Timeout | null = null
let lastState: MiniState = { running: false, label: '', startedAt: null }

const MINI_WIDTH = 200
const MINI_HEIGHT = 40
/** Distance from the work-area edge for the bottom-right default. */
const EDGE_MARGIN = 16

interface Position {
  x: number
  y: number
}

function defaultPosition(): Position {
  const wa = screen.getPrimaryDisplay().workArea
  return {
    x: wa.x + wa.width - MINI_WIDTH - EDGE_MARGIN,
    y: wa.y + wa.height - MINI_HEIGHT - EDGE_MARGIN
  }
}

/**
 * Reject saved positions that would land on a disconnected display
 * (user unplugged the second monitor since last close). Returns the
 * default bottom-right position in that case.
 */
function clampPosition(saved: Position): Position {
  const displays = screen.getAllDisplays()
  const onScreen = displays.some((d) => {
    const b = d.bounds
    return (
      saved.x >= b.x - MINI_WIDTH &&
      saved.x <= b.x + b.width &&
      saved.y >= b.y - MINI_HEIGHT &&
      saved.y <= b.y + b.height
    )
  })
  return onScreen ? saved : defaultPosition()
}

function loadPosition(): Position {
  try {
    const db = getDb()
    const rows = db
      .prepare(`SELECT key, value FROM settings WHERE key IN ('mini_x', 'mini_y')`)
      .all() as Array<{ key: string; value: string }>
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    const x = parseInt(map.mini_x ?? '-1', 10)
    const y = parseInt(map.mini_y ?? '-1', 10)
    if (x === -1 || y === -1 || !Number.isFinite(x) || !Number.isFinite(y)) {
      return defaultPosition()
    }
    return clampPosition({ x, y })
  } catch (err) {
    console.warn('[mini] position load failed (using default):', err)
    return defaultPosition()
  }
}

function persistPosition(x: number, y: number): void {
  try {
    const db = getDb()
    const stmt = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    stmt.run('mini_x', String(x))
    stmt.run('mini_y', String(y))
  } catch (err) {
    console.warn('[mini] position persist failed:', err)
  }
}

/**
 * Create the mini window if it doesn't exist, otherwise show + focus
 * the existing one. Idempotent.
 */
export function showMini(): void {
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.show()
    return
  }

  const pos = loadPosition()

  miniWindow = new BrowserWindow({
    width: MINI_WIDTH,
    height: MINI_HEIGHT,
    x: pos.x,
    y: pos.y,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  guardWindowLinks(miniWindow)

  // Keep the widget above fullscreen apps (browsers, IDEs).
  miniWindow.setAlwaysOnTop(true, 'screen-saver')
  miniWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  miniWindow.on('ready-to-show', () => {
    miniWindow?.show()
    // Render the cached state immediately so the user doesn't see the
    // "Kein Timer" stub for a tick when a timer is actually running.
    miniWindow?.webContents.send('mini:state-changed', lastState)
  })

  // Renderer (mini) requests a fresh push (e.g. after HMR reload).
  miniWindow.webContents.on('did-finish-load', () => {
    miniWindow?.webContents.send('mini:state-changed', lastState)
  })

  // Debounced position persistence on drag.
  miniWindow.on('moved', () => {
    if (positionDebounce) clearTimeout(positionDebounce)
    positionDebounce = setTimeout(() => {
      if (!miniWindow || miniWindow.isDestroyed()) return
      const [x, y] = miniWindow.getPosition()
      persistPosition(x, y)
    }, 250)
  })

  miniWindow.on('closed', () => {
    miniWindow = null
    if (positionDebounce) {
      clearTimeout(positionDebounce)
      positionDebounce = null
    }
  })

  // Load the dedicated mini.html bundle (electron-vite multi-entry).
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    miniWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/mini.html`)
  } else {
    miniWindow.loadFile(join(__dirname, '../renderer/mini.html'))
  }
}

/** Hide the mini window without destroying it (cheap to show again). */
export function hideMini(): void {
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.hide()
  }
}

/** Permanently destroy the mini window. Used when the user disables it. */
export function destroyMini(): void {
  if (positionDebounce) {
    clearTimeout(positionDebounce)
    positionDebounce = null
  }
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.destroy()
  }
  miniWindow = null
}

/** Apply the `mini_enabled` setting: show or destroy accordingly. */
export function applyMiniEnabled(enabled: boolean): void {
  if (enabled) showMini()
  else destroyMini()
}

/** True when the widget exists and is currently visible. */
export function isMiniVisible(): boolean {
  return !!miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible()
}

/**
 * Toggle visibility — used by the global hotkey. Only does anything when
 * the user has enabled the widget in Settings; we don't want a hotkey to
 * silently "opt the user in" to a feature they disabled.
 */
export function toggleMini(): void {
  if (!isMiniEnabledInDb()) return
  if (isMiniVisible()) hideMini()
  else showMini()
}

function isMiniEnabledInDb(): boolean {
  try {
    const db = getDb()
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'mini_enabled'`).get() as
      | { value: string }
      | undefined
    return row?.value === '1'
  } catch {
    return false
  }
}

/**
 * Update the cached state and forward it to the mini renderer (if mounted).
 * Called from index.ts on every `tray:update` so the widget stays in sync
 * with the main window without polling.
 */
export function pushMiniState(state: MiniState): void {
  lastState = state
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.webContents.send('mini:state-changed', state)
  }
}
