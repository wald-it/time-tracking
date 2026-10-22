import { describe, expect, it } from 'vitest'
import {
  barGeometry,
  clockSeconds,
  dayRange,
  formatClock,
  formatHm,
  hourLabels,
  layoutDayScale,
  pctOf,
  scaleTicks,
  type ScaleEntry
} from './dayScaleLayout'

// All fixtures are built in local time, the way the app reads them.
const at = (h: number, m = 0, day = 22): number => new Date(2026, 9, day, h, m, 0, 0).getTime()
const iso = (ms: number): string => new Date(ms).toISOString()
const done = (h1: number, m1: number, h2: number, m2: number): ScaleEntry => ({
  started_at: iso(at(h1, m1)),
  stopped_at: iso(at(h2, m2))
})
const running = (h: number, m: number, day = 22): ScaleEntry => ({
  started_at: iso(at(h, m, day)),
  stopped_at: null
})

describe('dayRange', () => {
  it('is 07–20 on an empty day', () => {
    expect(dayRange([], at(12))).toEqual({ startHour: 7, endHour: 20 })
  })

  it('stays 07–20 when everything fits, even on the exact edges', () => {
    expect(dayRange([done(7, 0, 20, 0)], at(12))).toEqual({ startHour: 7, endHour: 20 })
  })

  it('extends the start to the whole hour of an entry before 07:00', () => {
    expect(dayRange([done(5, 40, 6, 30)], at(12))).toEqual({ startHour: 5, endHour: 20 })
  })

  it('extends the end to the next whole hour of an entry after 20:00', () => {
    expect(dayRange([done(19, 0, 21, 10)], at(23, 30))).toEqual({ startHour: 7, endHour: 24 })
    expect(dayRange([done(19, 0, 20, 1)], at(20, 30))).toEqual({ startHour: 7, endHour: 21 })
  })

  it('extends the end when "now" is after 20:00, even with no entry there', () => {
    expect(dayRange([done(9, 0, 10, 0)], at(21, 15))).toEqual({ startHour: 7, endHour: 22 })
  })

  it('extends the start when "now" is before 07:00 (needle must fit)', () => {
    expect(dayRange([], at(6, 20))).toEqual({ startHour: 6, endHour: 20 })
  })

  it('clamps an entry running since yesterday to the start of today', () => {
    expect(dayRange([running(23, 0, 21)], at(1, 30))).toEqual({ startHour: 0, endHour: 20 })
  })
})

describe('clockSeconds', () => {
  it('measures wall-clock seconds of the day of "now"', () => {
    expect(clockSeconds(at(8, 10), at(12))).toBe(8 * 3600 + 10 * 60)
  })
  it('clamps yesterday to 0 and tomorrow to 86 400', () => {
    expect(clockSeconds(at(23, 0, 21), at(12))).toBe(0)
    expect(clockSeconds(at(1, 0, 23), at(12))).toBe(86400)
  })
})

describe('ticks and hour labels', () => {
  const range = { startHour: 7, endHour: 20 }

  it('places a tick every 15 min with three lengths, both ends inclusive', () => {
    const ticks = scaleTicks(range, 16 * 3600 + 52 * 60)
    expect(ticks).toHaveLength(13 * 4 + 1)
    expect(ticks[0]).toMatchObject({ left: 0, length: 14 })
    expect(ticks[1].length).toBe(5)
    expect(ticks[2].length).toBe(9)
    expect(ticks[3].length).toBe(5)
    expect(ticks[4].length).toBe(14)
    expect(ticks[ticks.length - 1]).toMatchObject({ left: 100, length: 14 })
  })

  it('dims ticks strictly after "now" (reference: 16:52 → from 17:00)', () => {
    const ticks = scaleTicks(range, 16 * 3600 + 52 * 60)
    const firstDim = ticks.findIndex((t) => t.dim)
    expect(ticks[firstDim].sec).toBe(17 * 3600)
    expect(ticks.slice(0, firstDim).every((t) => !t.dim)).toBe(true)
    expect(ticks.slice(firstDim).every((t) => t.dim)).toBe(true)
    // A tick exactly at "now" is not after now.
    expect(scaleTicks(range, 17 * 3600).find((t) => t.sec === 17 * 3600)?.dim).toBe(false)
  })

  it('labels every hour, two digits, ink3 after now', () => {
    const hours = hourLabels(range, 16 * 3600 + 52 * 60)
    expect(hours.map((h) => h.label)).toEqual([
      '07',
      '08',
      '09',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
      '19',
      '20'
    ])
    expect(hours.find((h) => h.hour === 16)?.dim).toBe(false)
    expect(hours.find((h) => h.hour === 17)?.dim).toBe(true)
    expect(hours[1].left).toBeCloseTo(7.692, 3)
  })
})

describe('bars and needle', () => {
  it('matches the reference render (08:10–09:40 in 07–20)', () => {
    const b = barGeometry(done(8, 10, 9, 40), { startHour: 7, endHour: 20 }, at(16, 52))
    expect(b.left).toBeCloseTo(8.974, 3)
    expect(b.width).toBeCloseTo(11.538, 3)
    expect(b.running).toBe(false)
  })

  it('lets a running bar end at the needle', () => {
    const layout = layoutDayScale([running(14, 5)], at(16, 52))
    const [bar] = layout.bars
    expect(bar.running).toBe(true)
    expect(bar.left).toBeCloseTo(54.487, 3)
    expect(bar.left + bar.width).toBeCloseTo(layout.needle, 6)
    expect(layout.needle).toBeCloseTo(75.897, 3)
  })

  it('draws an entry running since yesterday from the left edge of today', () => {
    const layout = layoutDayScale([running(23, 0, 21)], at(1, 30))
    expect(layout.range.startHour).toBe(0)
    expect(layout.bars[0].left).toBe(0)
    expect(layout.bars[0].startSec).toBe(0)
    expect(layout.bars[0].endSec).toBe(1.5 * 3600)
  })

  it('keeps a very short entry visible', () => {
    const b = barGeometry(done(9, 0, 9, 0), { startHour: 7, endHour: 20 }, at(12))
    expect(b.width).toBeGreaterThan(0)
  })

  it('keeps the needle inside the scale when "now" is after 20:00', () => {
    const layout = layoutDayScale([done(9, 0, 10, 0)], at(21, 30))
    expect(layout.range.endHour).toBe(22)
    expect(layout.needle).toBeGreaterThan(0)
    expect(layout.needle).toBeLessThan(100)
    expect(layout.ticks[layout.ticks.length - 1].sec).toBe(22 * 3600)
  })

  it('has a needle but no bars on an empty day', () => {
    const layout = layoutDayScale([], at(10))
    expect(layout.bars).toEqual([])
    expect(layout.needle).toBeCloseTo(pctOf(10 * 3600, { startHour: 7, endHour: 20 }), 6)
  })
})

describe('formatting', () => {
  it('formats clock and H:MM', () => {
    expect(formatClock(at(8, 5))).toBe('08:05')
    expect(formatHm(4 * 3600 + 52 * 60 + 59)).toBe('4:52')
    expect(formatHm(0)).toBe('0:00')
  })
})
