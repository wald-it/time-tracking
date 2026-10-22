import { describe, expect, it } from 'vitest'
import {
  MIN_VISIBLE,
  parseWindowState,
  resolveWindow,
  serializeWindowState,
  type Rect
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
