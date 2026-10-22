import { describe, expect, it } from 'vitest'
import {
  formatEurWhole,
  formatQuota,
  hoursAxis,
  isoWeek,
  monthPeriods,
  moveIndex,
  revenueAxis,
  revenuePoints,
  revenuePx,
  runningIndex,
  stackPx,
  tickPx,
  weekMondays,
  weekPeriods
} from './trendLayout'

const H = 3600
const local = (y: number, m: number, d: number, h = 12): number =>
  new Date(y, m - 1, d, h).getTime()

describe('hoursAxis', () => {
  it('is never shorter than 0–160 h (mockup)', () => {
    expect(hoursAxis(0)).toEqual({ top: 160, ticks: [0, 40, 80, 120, 160] })
    expect(hoursAxis(38 * H)).toEqual({ top: 160, ticks: [0, 40, 80, 120, 160] })
  })

  it('grows in 40 h steps to the next multiple at or above the maximum', () => {
    expect(hoursAxis(160 * H).top).toBe(160)
    expect(hoursAxis(160 * H + 1).top).toBe(200)
    expect(hoursAxis(201 * H)).toEqual({ top: 240, ticks: [0, 40, 80, 120, 160, 200, 240] })
  })

  it('treats a broken maximum as empty', () => {
    expect(hoursAxis(Number.NaN).top).toBe(160)
    expect(hoursAxis(-5).top).toBe(160)
  })

  it('week mode has its own, smaller steps so week columns are not flat', () => {
    expect(hoursAxis(0, 'week')).toEqual({ top: 40, ticks: [0, 10, 20, 30, 40] })
    expect(hoursAxis(43 * H, 'week')).toEqual({ top: 50, ticks: [0, 10, 20, 30, 40, 50] })
    expect(revenueAxis(0, 'week')).toEqual({ top: 4, ticks: [0, 2, 4] })
    expect(revenueAxis(500_000, 'week').top).toBe(6)
  })
})

describe('revenueAxis', () => {
  it('is 0/10/20 T€ by default and grows in 10 T€ steps', () => {
    expect(revenueAxis(0)).toEqual({ top: 20, ticks: [0, 10, 20] })
    expect(revenueAxis(1_669_000)).toEqual({ top: 20, ticks: [0, 10, 20] }) // 16.690 €
    expect(revenueAxis(2_000_001).top).toBe(30)
  })
})

describe('band positions', () => {
  it('puts the top tick at 92 % of the band (184 of 200 px, 92 of 100 px)', () => {
    expect(tickPx(160, 160, 200)).toBeCloseTo(184)
    expect(tickPx(40, 160, 200)).toBeCloseTo(46)
    expect(tickPx(20, 20, 100)).toBeCloseTo(92)
  })

  it('matches the mockup column November 2025 (132:15 h, 120:30 billable, 14.120 €)', () => {
    const stack = stackPx(120.5 * H, 11.75 * H, 160)
    expect(stack.billable).toBeCloseTo(138.6, 1)
    // 11:45 non-billable is 13.5 px; the 2 px gap comes out of that segment.
    expect(stack.nonBillable).toBeCloseTo(11.5, 1)
    expect(revenuePx(1_412_000, 20)).toBeCloseTo(65, 1)
  })

  it('leaves no gap when there is no billable segment', () => {
    const stack = stackPx(0, 40 * H, 160)
    expect(stack.billable).toBe(0)
    expect(stack.nonBillable).toBeCloseTo(46)
  })

  it('never goes negative for a sliver of non-billable time', () => {
    expect(stackPx(100 * H, 60, 160).nonBillable).toBe(0)
  })

  it('draws the revenue line through the column centres', () => {
    expect(revenuePoints([0, 1_000_000, 2_000_000], 20)).toBe('5.0,100.0 15.0,54.0 25.0,8.0')
  })
})

describe('monthPeriods', () => {
  it('trails 12 months to the anchor, year under the first column and January', () => {
    const p = monthPeriods({ year: 2026, month: 10 })
    expect(p).toHaveLength(12)
    expect(p[0]).toEqual({ year: 2025, index: 11, showYear: true })
    expect(p[1]).toEqual({ year: 2025, index: 12, showYear: false })
    expect(p[2]).toEqual({ year: 2026, index: 1, showYear: true })
    expect(p[11]).toEqual({ year: 2026, index: 10, showYear: false })
    expect(p.filter((x) => x.showYear)).toHaveLength(2)
  })

  it('shows the year once when the anchor is December', () => {
    const p = monthPeriods({ year: 2026, month: 12 })
    expect(p[0]).toEqual({ year: 2026, index: 1, showYear: true })
    expect(p.filter((x) => x.showYear)).toHaveLength(1)
  })
})

describe('weeks', () => {
  it('computes ISO week and week-year', () => {
    expect(isoWeek(new Date(2026, 9, 19))).toEqual({ year: 2026, week: 43 })
    // 2027-01-01 is a Friday: it still belongs to 2026-W53.
    expect(isoWeek(new Date(2027, 0, 1))).toEqual({ year: 2026, week: 53 })
    // 2024-12-30 is a Monday in 2025-W01.
    expect(isoWeek(new Date(2024, 11, 30))).toEqual({ year: 2025, week: 1 })
  })

  it('ends with the week that holds the anchor month’s last day', () => {
    const mondays = weekMondays({ year: 2026, month: 10 })
    expect(mondays).toHaveLength(12)
    // 31 Oct 2026 is a Saturday → its Monday is 26 Oct.
    expect(mondays[11]).toEqual(new Date(2026, 9, 26))
    expect(mondays[0]).toEqual(new Date(2026, 7, 10))
  })

  it('puts the year under the first column and under KW01', () => {
    const p = weekPeriods({ year: 2026, month: 1 })
    expect(p[0].showYear).toBe(true)
    const kw1 = p.findIndex((x) => x.index === 1)
    expect(kw1).toBeGreaterThan(0)
    expect(p[kw1]).toEqual({ year: 2026, index: 1, showYear: true })
    expect(p.filter((x) => x.showYear)).toHaveLength(2)
  })
})

describe('runningIndex', () => {
  const oct = { year: 2026, month: 10 }

  it('marks the last month while the anchor is the current month', () => {
    expect(runningIndex('month', oct, local(2026, 10, 22))).toBe(11)
    expect(runningIndex('month', oct, local(2026, 11, 2))).toBe(-1)
    expect(runningIndex('month', { year: 2025, month: 10 }, local(2026, 10, 22))).toBe(-1)
  })

  it('marks the week that holds today, which need not be the last column', () => {
    // Thu 22 Oct 2026 is in the week of Mon 19 Oct, the second-to-last column.
    expect(runningIndex('week', oct, local(2026, 10, 22))).toBe(10)
    expect(runningIndex('week', oct, local(2026, 10, 26, 0))).toBe(11)
    expect(runningIndex('week', oct, local(2026, 12, 1))).toBe(-1)
  })
})

describe('moveIndex', () => {
  it('moves the roving focus and clamps at the edges', () => {
    expect(moveIndex('ArrowLeft', 5, 12)).toBe(4)
    expect(moveIndex('ArrowRight', 5, 12)).toBe(6)
    expect(moveIndex('ArrowLeft', 0, 12)).toBe(0)
    expect(moveIndex('ArrowRight', 11, 12)).toBe(11)
    expect(moveIndex('Home', 5, 12)).toBe(0)
    expect(moveIndex('End', 5, 12)).toBe(11)
    expect(moveIndex('Enter', 5, 12)).toBeNull()
    expect(moveIndex('ArrowLeft', 0, 0)).toBeNull()
  })
})

describe('formatters', () => {
  it('formats the billable quota in whole percent', () => {
    expect(formatQuota(112.5 * H, 126 * H)).toBe('89 %')
    expect(formatQuota(0, 0)).toBe('–')
  })

  it('formats revenue in whole euros like the mockup', () => {
    expect(formatEurWhole(1_307_800)).toBe('13.078 €')
    expect(formatEurWhole(1_307_850)).toBe('13.079 €')
    expect(formatEurWhole(0)).toBe('0 €')
    expect(formatEurWhole(123_456_789)).toBe('1.234.568 €')
  })
})
