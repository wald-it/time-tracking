import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_VISIBLE,
  captureWindowState,
  createWindowStateKeeper,
  parseWindowState,
  resolveWindow,
  serializeWindowState,
  showPlacedWindow,
  type Rect,
  type WindowStateSource
} from './windowBounds'

const DEF = { width: 1280, height: 860 }
const MIN = { width: 760, height: 600 }
// A 1920×1080 primary with a 40 px taskbar, and a second monitor to its right.
const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
const SECOND: Rect = { x: 1920, y: 0, width: 2560, height: 1400 }

function saved(bounds: Rect, maximized = false): ReturnType<typeof parseWindowState> {
  return { bounds, maximized }
}

describe('parseWindowState', () => {
  it('reads what serializeWindowState wrote', () => {
    const state = { bounds: { x: 10, y: 20, width: 1000, height: 700 }, maximized: true }
    expect(parseWindowState(serializeWindowState(state))).toEqual(state)
  })

  it('treats broken JSON, other shapes and missing values as nothing saved', () => {
    for (const raw of [
      undefined,
      null,
      '',
      '{',
      'null',
      '42',
      '"text"',
      '[1,2,3,4]',
      '{"x":1,"y":2,"width":3}',
      '{"x":"1","y":2,"width":800,"height":600}',
      '{"x":1,"y":2,"width":0,"height":600}',
      '{"x":1,"y":2,"width":-800,"height":600}'
    ]) {
      expect(parseWindowState(raw), String(raw)).toBeNull()
    }
  })

  it('reads a missing or odd maximized flag as not maximized', () => {
    expect(parseWindowState('{"x":1,"y":2,"width":800,"height":600}')?.maximized).toBe(false)
    expect(
      parseWindowState('{"x":1,"y":2,"width":800,"height":600,"maximized":"yes"}')?.maximized
    ).toBe(false)
  })
})

describe('resolveWindow', () => {
  it('opens the default size centred on the primary work area when nothing is saved', () => {
    const r = resolveWindow(null, [PRIMARY], PRIMARY, DEF, MIN)
    expect(r.bounds).toEqual({ x: 320, y: 90, width: 1280, height: 860 })
    expect(r.maximized).toBe(false)
    expect(r.minSize).toEqual(MIN)
  })

  it('keeps a saved window that lies fully on a display, maximized flag included', () => {
    const bounds = { x: 2100, y: 100, width: 1400, height: 900 }
    const r = resolveWindow(saved(bounds, true), [PRIMARY, SECOND], PRIMARY, DEF, MIN)
    expect(r.bounds).toEqual(bounds)
    expect(r.maximized).toBe(true)
  })

  it('falls back to the default when the monitor it was on is unplugged', () => {
    const onSecond = saved({ x: 2100, y: 100, width: 1400, height: 900 }, true)
    const r = resolveWindow(onSecond, [PRIMARY], PRIMARY, DEF, MIN)
    expect(r.bounds).toEqual({ x: 320, y: 90, width: 1280, height: 860 })
    expect(r.maximized).toBe(false)
  })

  it('falls back when only a sliver is left on screen', () => {
    // 100 px of width on the primary: less than MIN_VISIBLE.width.
    const sliver = saved({ x: 1920 - 100, y: 100, width: 1000, height: 700 })
    expect(MIN_VISIBLE.width).toBeGreaterThan(100)
    const r = resolveWindow(sliver, [PRIMARY], PRIMARY, DEF, MIN)
    expect(r.bounds.x).toBe(320)
  })

  it('pulls a partly outside window fully into the work area it overlaps most', () => {
    // Hangs off the right edge and its title bar sits above the screen.
    const partly = saved({ x: 1500, y: -50, width: 1000, height: 700 })
    const r = resolveWindow(partly, [PRIMARY], PRIMARY, DEF, MIN)
    expect(r.bounds).toEqual({ x: 920, y: 0, width: 1000, height: 700 })
  })

  it('picks the display with the larger share when a window spans two', () => {
    // 300 px on the primary, 900 px on the second monitor.
    const spanning = saved({ x: 1620, y: 100, width: 1200, height: 800 })
    const r = resolveWindow(spanning, [PRIMARY, SECOND], PRIMARY, DEF, MIN)
    expect(r.bounds).toEqual({ x: 1920, y: 100, width: 1200, height: 800 })
  })

  it('grows a saved size below the minimum back to the minimum', () => {
    const tiny = saved({ x: 100, y: 100, width: 300, height: 200 })
    const r = resolveWindow(tiny, [PRIMARY], PRIMARY, DEF, MIN)
    expect(r.bounds).toEqual({ x: 100, y: 100, width: 760, height: 600 })
  })

  it('shrinks a saved size larger than the work area to it', () => {
    const huge = saved({ x: 0, y: 0, width: 3000, height: 2000 })
    const r = resolveWindow(huge, [PRIMARY], PRIMARY, DEF, MIN)
    expect(r.bounds).toEqual(PRIMARY)
  })

  it('fits default and minimum to a work area smaller than both', () => {
    const small: Rect = { x: 0, y: 0, width: 700, height: 500 }
    const r = resolveWindow(null, [small], small, DEF, MIN)
    expect(r.bounds).toEqual({ x: 0, y: 0, width: 700, height: 500 })
    expect(r.minSize).toEqual({ width: 700, height: 500 })
  })

  it('handles work areas left of and above the primary (negative coordinates)', () => {
    const left: Rect = { x: -1920, y: -200, width: 1920, height: 1040 }
    const bounds = { x: -1700, y: -100, width: 1200, height: 800 }
    const r = resolveWindow(saved(bounds), [PRIMARY, left], PRIMARY, DEF, MIN)
    expect(r.bounds).toEqual(bounds)
  })
})

/** A window whose state the test sets; getBounds() is the maximized rect. */
function fakeWindow(normal: Rect): WindowStateSource & {
  set: (s: Partial<{ normal: Rect; maximized: boolean; minimized: boolean }>) => void
  getBounds: () => Rect
} {
  let state = { normal, maximized: false, minimized: false, destroyed: false }
  return {
    set: (s) => {
      state = { ...state, ...s }
    },
    isDestroyed: () => state.destroyed,
    isMinimized: () => state.minimized,
    // Windows reports a minimized window as not maximized.
    isMaximized: () => state.maximized && !state.minimized,
    getNormalBounds: () => state.normal,
    getBounds: () => (state.maximized ? PRIMARY : state.normal)
  }
}

describe('captureWindowState', () => {
  it('stores the size a maximized window restores to, not the maximized rect', () => {
    const win = fakeWindow({ x: 100, y: 100, width: 1000, height: 700 })
    win.set({ maximized: true })
    expect(captureWindowState(win)).toEqual({
      bounds: { x: 100, y: 100, width: 1000, height: 700 },
      maximized: true
    })
  })

  it('reads nothing from a minimized or missing window', () => {
    const win = fakeWindow({ x: -32000, y: -32000, width: 160, height: 28 })
    win.set({ minimized: true })
    expect(captureWindowState(win)).toBeNull()
    expect(captureWindowState(null)).toBeNull()
  })
})

describe('createWindowStateKeeper', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function keeper(): { writes: string[]; k: ReturnType<typeof createWindowStateKeeper> } {
    const writes: string[] = []
    return { writes, k: createWindowStateKeeper({ write: (v) => writes.push(v), delayMs: 500 }) }
  }

  it('writes once the window has settled, with the latest state', () => {
    vi.useFakeTimers()
    const { writes, k } = keeper()
    const win = fakeWindow({ x: 0, y: 0, width: 900, height: 700 })
    k.changed(win)
    win.set({ normal: { x: 10, y: 0, width: 900, height: 700 } })
    k.changed(win)
    vi.advanceTimersByTime(499)
    expect(writes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(writes.map((w) => parseWindowState(w)?.bounds.x)).toEqual([10])
  })

  it('a change followed by a minimize inside the debounce is written, maximized flag included', () => {
    vi.useFakeTimers()
    const { writes, k } = keeper()
    const win = fakeWindow({ x: 50, y: 60, width: 900, height: 700 })
    win.set({ maximized: true })
    k.changed(win)
    win.set({ minimized: true })
    k.flush() // the 'minimize' event
    expect(writes.map(parseWindowState)).toEqual([
      { bounds: { x: 50, y: 60, width: 900, height: 700 }, maximized: true }
    ])
  })

  it('quitting while minimized writes the state from before the minimize', () => {
    vi.useFakeTimers()
    const { writes, k } = keeper()
    const win = fakeWindow({ x: 50, y: 60, width: 900, height: 700 })
    k.changed(win)
    win.set({ minimized: true })
    k.flush(win) // before-quit: the window is minimized, nothing readable
    expect(parseWindowState(writes.at(-1))?.bounds).toEqual({
      x: 50,
      y: 60,
      width: 900,
      height: 700
    })
    // and the pending debounce does not write again afterwards
    vi.advanceTimersByTime(1000)
    expect(writes).toHaveLength(1)
  })

  it('writes nothing when it never saw a readable state (e.g. no window yet)', () => {
    const { writes, k } = keeper()
    k.flush(null)
    expect(writes).toEqual([])
  })
})

describe('showPlacedWindow', () => {
  function target(): { calls: string[]; win: Parameters<typeof showPlacedWindow>[0] } {
    const calls: string[] = []
    return {
      calls,
      win: {
        show: () => calls.push('show'),
        maximize: () => calls.push('maximize'),
        focus: () => calls.push('focus')
      }
    }
  }

  it('shows a normal window', () => {
    const { calls, win } = target()
    showPlacedWindow(win, false)
    expect(calls).toEqual(['show'])
  })

  it('maximizes without showing the normal size first, then focuses', () => {
    const { calls, win } = target()
    showPlacedWindow(win, true)
    expect(calls).toEqual(['maximize', 'focus'])
  })
})
