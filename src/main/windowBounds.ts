/**
 * Main window size and position across restarts — the pure part, without
 * Electron, so every rule below is testable. `index.ts` feeds it the stored
 * settings value and the current displays, and writes the window state back.
 *
 * Stored as one JSON value in the settings table (`window_bounds`), like
 * `export_prefs`: the normal (restored) bounds plus whether the window was
 * maximized. A broken or foreign value means the default window, never a
 * failed start.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export interface SavedWindowState {
  /** The normal bounds — for a maximized window, the ones it restores to. */
  bounds: Rect
  maximized: boolean
}

export interface ResolvedWindow {
  bounds: Rect
  maximized: boolean
  /** The minimum size, fitted to the work area the window opens on. */
  minSize: Size
}

export const WINDOW_BOUNDS_KEY = 'window_bounds'

/**
 * How much of a saved window must still lie on a display's work area to keep
 * its place: enough to see it and grab it. Less than that (monitor unplugged,
 * resolution lowered, a backup from another machine) and it opens as the
 * default window instead of somewhere unreachable.
 */
export const MIN_VISIBLE = { width: 120, height: 80 }

export function serializeWindowState(state: SavedWindowState): string {
  const { x, y, width, height } = state.bounds
  return JSON.stringify({ x, y, width, height, maximized: state.maximized })
}

/** null for anything that is not a complete, finite, positive window state. */
export function parseWindowState(raw: string | null | undefined): SavedWindowState | null {
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const nums = [v.x, v.y, v.width, v.height]
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const [x, y, width, height] = (nums as number[]).map(Math.round)
  if (width <= 0 || height <= 0) return null
  return { bounds: { x, y, width, height }, maximized: v.maximized === true }
}

function overlap(a: Rect, b: Rect): Size {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), Math.max(lo, hi))
}

function fittedMin(min: Size, work: Rect): Size {
  return { width: Math.min(min.width, work.width), height: Math.min(min.height, work.height) }
}

/** The default size, fitted to the work area and centred on it. */
function centredDefault(work: Rect, def: Size, min: Size): ResolvedWindow {
  const width = Math.min(def.width, work.width)
  const height = Math.min(def.height, work.height)
  return {
    bounds: {
      x: work.x + Math.round((work.width - width) / 2),
      y: work.y + Math.round((work.height - height) / 2),
      width,
      height
    },
    maximized: false,
    minSize: fittedMin(min, work)
  }
}

/**
 * Where the main window opens. A saved state is kept when it still lies on
 * one of the current work areas by at least `MIN_VISIBLE`; it then opens on
 * the work area it overlaps most, with its size held between the minimum and
 * that work area and its position moved fully inside it (a title bar above
 * the screen edge could not be grabbed). Otherwise: the default size, centred
 * on the primary work area, not maximized.
 */
export function resolveWindow(
  saved: SavedWindowState | null,
  workAreas: Rect[],
  primaryWork: Rect,
  def: Size,
  min: Size
): ResolvedWindow {
  if (!saved) return centredDefault(primaryWork, def, min)

  let best: { work: Rect; area: number; size: Size } | null = null
  for (const work of workAreas) {
    const size = overlap(saved.bounds, work)
    const area = size.width * size.height
    if (!best || area > best.area) best = { work, area, size }
  }
  if (
    !best ||
    best.size.width < Math.min(MIN_VISIBLE.width, saved.bounds.width) ||
    best.size.height < Math.min(MIN_VISIBLE.height, saved.bounds.height)
  ) {
    return centredDefault(primaryWork, def, min)
  }

  const { work } = best
  const minSize = fittedMin(min, work)
  const width = clamp(saved.bounds.width, minSize.width, work.width)
  const height = clamp(saved.bounds.height, minSize.height, work.height)
  return {
    bounds: {
      x: clamp(saved.bounds.x, work.x, work.x + work.width - width),
      y: clamp(saved.bounds.y, work.y, work.y + work.height - height),
      width,
      height
    },
    maximized: saved.maximized,
    minSize
  }
}

/** The part of a BrowserWindow the keeper reads; a fake in the tests. */
export interface WindowStateSource {
  isDestroyed(): boolean
  isMinimized(): boolean
  isMaximized(): boolean
  /** Not getBounds(): a maximized window must store the size it restores to. */
  getNormalBounds(): Rect
}

/**
 * The window's state as it should be stored, or null when it cannot be read
 * reliably: destroyed, or minimized (Windows parks a minimized window at
 * -32000 and reports it as not maximized).
 */
export function captureWindowState(win: WindowStateSource | null): SavedWindowState | null {
  if (!win || win.isDestroyed() || win.isMinimized()) return null
  return { bounds: win.getNormalBounds(), maximized: win.isMaximized() }
}

/**
 * Keeps the last readable window state and writes it to the settings table.
 * `changed` takes a snapshot right away and writes it once the window has
 * settled; `flush` writes at once — called when the window minimizes (its
 * state is no longer readable, but the snapshot from just before is), hides
 * to the tray, and when the app quits. A change followed by a minimize inside
 * the debounce is therefore never lost, nor is it when the app then quits
 * from the tray while still minimized.
 */
export function createWindowStateKeeper(opts: {
  write: (value: string) => void
  delayMs: number
}): {
  changed: (win: WindowStateSource | null) => void
  flush: (win?: WindowStateSource | null) => void
} {
  let last: SavedWindowState | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const remember = (win: WindowStateSource | null | undefined): void => {
    const state = captureWindowState(win ?? null)
    if (state) last = state
  }
  const write = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (last) opts.write(serializeWindowState(last))
  }

  return {
    changed(win) {
      remember(win)
      if (timer) clearTimeout(timer)
      timer = setTimeout(write, opts.delayMs)
    },
    flush(win) {
      remember(win)
      write()
    }
  }
}

/** The part of a BrowserWindow `showPlacedWindow` drives; a fake in the tests. */
export interface ShowTarget {
  show(): void
  maximize(): void
  focus(): void
}

/**
 * First appearance of the main window. maximize() shows a hidden window by
 * itself — but without focus — so a maximized start is maximize() + focus()
 * and never show() first (that would flash the normal size before it grows).
 */
export function showPlacedWindow(win: ShowTarget, maximized: boolean): void {
  if (maximized) {
    win.maximize()
    win.focus()
  } else {
    win.show()
  }
}
