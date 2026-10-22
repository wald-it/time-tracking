import { describe, expect, it } from 'vitest'
import type { ScaleEntry } from '../heute/dayScaleLayout'
import {
  entryClockSpan,
  formatRangeHour,
  MINI_MIN_BAR_WIDTH_PCT,
  miniBar,
  miniTicks,
  monthRange
} from './monthScale'

// All fixtures are built in local time, the way the app reads them.
const at = (day: number, h: number, m = 0, month = 9): number =>
  new Date(2026, month, day, h, m, 0, 0).getTime()
const iso = (ms: number): string => new Date(ms).toISOString()
const done = (day: number, h1: number, m1: number, h2: number, m2: number): ScaleEntry => ({
  started_at: iso(at(day, h1, m1)),
  stopped_at: iso(at(day, h2, m2))
})
const OCTOBER = new Date(2026, 9, 1)
/** "Now" in a different month, so it never takes part in October's range. */
const NOVEMBER_NOON = at(10, 12, 0, 10)

describe('monthRange', () => {
  it('is 07–20 for an empty month that does not contain today', () => {
    expect(monthRange([], OCTOBER, NOVEMBER_NOON)).toEqual({ startHour: 7, endHour: 20 })
  })

  it('stays 07–20 when every entry fits, even on the exact edges', () => {
    const entries = [done(5, 7, 0, 12, 0), done(6, 13, 0, 20, 0)]
    expect(monthRange(entries, OCTOBER, NOVEMBER_NOON)).toEqual({ startHour: 7, endHour: 20 })
  })

  it('widens to whole hours over ALL days of the month — one shared range', () => {
    // Early start on the 3rd, late end on the 28th: both edges move, and the
    // result is the same for every cell.
    const entries = [done(3, 5, 40, 9, 0), done(14, 9, 0, 12, 0), done(28, 18, 0, 21, 10)]
    expect(monthRange(entries, OCTOBER, NOVEMBER_NOON)).toEqual({ startHour: 5, endHour: 22 })
  })

  it("reads each entry at its own day's clock time, not at today's", () => {
    // 06:30 on the 2nd must widen the start to 06 even though "now" is a
    // different day — a ms offset against today would land far off.
    expect(monthRange([done(2, 6, 30, 8, 0)], OCTOBER, NOVEMBER_NOON)).toEqual({
      startHour: 6,
      endHour: 20
    })
  })

  it('takes "now" into account when today lies in the month', () => {
    expect(monthRange([], OCTOBER, at(22, 21, 15))).toEqual({ startHour: 7, endHour: 22 })
    expect(monthRange([], OCTOBER, at(22, 6, 5))).toEqual({ startHour: 6, endHour: 20 })
  })

  it('ignores "now" when today lies in another month', () => {
    const lateInNovember = at(10, 23, 0, 10)
    expect(monthRange([], OCTOBER, lateInNovember)).toEqual({ startHour: 7, endHour: 20 })
  })

  it('runs a running entry up to now', () => {
    const running: ScaleEntry = { started_at: iso(at(22, 15, 0)), stopped_at: null }
    expect(monthRange([running], OCTOBER, at(22, 22, 30))).toEqual({
      startHour: 7,
      endHour: 23
    })
  })

  it('caps an entry past midnight at 24:00 of its start day', () => {
    const overnight: ScaleEntry = { started_at: iso(at(9, 22, 0)), stopped_at: iso(at(10, 1, 0)) }
    expect(monthRange([overnight], OCTOBER, NOVEMBER_NOON)).toEqual({
      startHour: 7,
      endHour: 24
    })
  })
})

describe('entryClockSpan', () => {
  it('measures in the clock of the start day', () => {
    expect(entryClockSpan(done(4, 8, 10, 9, 40), NOVEMBER_NOON)).toEqual({
      startSec: 8 * 3600 + 600,
      endSec: 9 * 3600 + 2400
    })
  })
})

describe('miniBar', () => {
  const range = { startHour: 7, endHour: 20 }

  it('places a bar at its clock time in % of the range', () => {
    const bar = miniBar(done(21, 9, 0, 12, 15), range, NOVEMBER_NOON)
    expect(bar.left).toBeCloseTo((2 / 13) * 100, 6)
    expect(bar.width).toBeCloseTo((3.25 / 13) * 100, 6)
    expect(bar.running).toBe(false)
  })

  it('keeps a two-minute entry visible', () => {
    const bar = miniBar(done(21, 9, 0, 9, 2), range, NOVEMBER_NOON)
    expect(bar.width).toBe(MINI_MIN_BAR_WIDTH_PCT)
  })

  it('marks a running entry and ends it at now', () => {
    const running: ScaleEntry = { started_at: iso(at(22, 14, 0)), stopped_at: null }
    const bar = miniBar(running, range, at(22, 16, 36))
    expect(bar.running).toBe(true)
    expect(bar.left + bar.width).toBeCloseTo(((9 + 36 / 60) / 13) * 100, 6)
  })

  it('never runs past the right edge', () => {
    const bar = miniBar(done(21, 19, 59, 20, 0), range, NOVEMBER_NOON)
    expect(bar.left + bar.width).toBeLessThanOrEqual(100)
  })
})

describe('miniTicks', () => {
  it('ticks at 08/10/12/14/16/18 on the default range', () => {
    const ticks = miniTicks({ startHour: 7, endHour: 20 })
    expect(ticks.map((p) => p.toFixed(2))).toEqual([
      '7.69',
      '23.08',
      '38.46',
      '53.85',
      '69.23',
      '84.62'
    ])
  })

  it('ticks every even hour strictly inside a widened range', () => {
    const ticks = miniTicks({ startHour: 6, endHour: 22 })
    expect(ticks).toHaveLength(7) // 08 … 20
    expect(ticks[0]).toBeCloseTo((2 / 16) * 100, 6)
  })
})

describe('formatRangeHour', () => {
  it('pads to two digits', () => {
    expect(formatRangeHour(7)).toBe('07')
    expect(formatRangeHour(20)).toBe('20')
  })
})
