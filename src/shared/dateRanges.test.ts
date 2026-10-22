import { describe, it, expect } from 'vitest'
import { getQuickRange, localDateKey } from './dateRanges'

/**
 * Construct a Date in local time (Y/M/D/H/M). All assertions below also use
 * local-time getters so the suite is timezone-agnostic — it verifies the
 * ranges relative to the host's wall-clock, not against a hardcoded UTC offset.
 */
function local(y: number, m: number, d: number, h = 12, min = 0): Date {
  return new Date(y, m - 1, d, h, min, 0, 0)
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('getQuickRange', () => {
  it('thisWeek anchors to Monday and ends on Sunday 23:59:59.999', () => {
    // 2026-04-24 is a Friday.
    const now = local(2026, 4, 24)
    const r = getQuickRange('thisWeek', now)
    expect(dayKey(r.from)).toBe('2026-04-20') // Mon
    expect(dayKey(r.to)).toBe('2026-04-26') // Sun
    expect(r.from.getHours()).toBe(0)
    expect(r.to.getHours()).toBe(23)
    expect(r.to.getMinutes()).toBe(59)
    expect(r.to.getMilliseconds()).toBe(999)
  })

  it('thisWeek when today is Monday returns the same Monday', () => {
    // 2026-04-20 is a Monday.
    const now = local(2026, 4, 20)
    const r = getQuickRange('thisWeek', now)
    expect(dayKey(r.from)).toBe('2026-04-20')
    expect(dayKey(r.to)).toBe('2026-04-26')
  })

  it('thisWeek when today is Sunday still anchors to the previous Monday', () => {
    // 2026-04-26 is a Sunday.
    const now = local(2026, 4, 26)
    const r = getQuickRange('thisWeek', now)
    expect(dayKey(r.from)).toBe('2026-04-20')
    expect(dayKey(r.to)).toBe('2026-04-26')
  })

  it('lastWeek returns the prior Mon–Sun', () => {
    const now = local(2026, 4, 24) // Fri
    const r = getQuickRange('lastWeek', now)
    expect(dayKey(r.from)).toBe('2026-04-13')
    expect(dayKey(r.to)).toBe('2026-04-19')
  })

  it('thisMonth returns the first to last day of the current month', () => {
    const now = local(2026, 4, 24)
    const r = getQuickRange('thisMonth', now)
    expect(dayKey(r.from)).toBe('2026-04-01')
    expect(dayKey(r.to)).toBe('2026-04-30')
  })

  it('lastMonth returns the previous month, not "30 days ago"', () => {
    const now = local(2026, 4, 24)
    const r = getQuickRange('lastMonth', now)
    expect(dayKey(r.from)).toBe('2026-03-01')
    expect(dayKey(r.to)).toBe('2026-03-31')
  })

  it('lastMonth across year boundary (January → December)', () => {
    const now = local(2026, 1, 5)
    const r = getQuickRange('lastMonth', now)
    expect(dayKey(r.from)).toBe('2025-12-01')
    expect(dayKey(r.to)).toBe('2025-12-31')
  })

  it('thisMonth handles February in a non-leap year', () => {
    const now = local(2026, 2, 14)
    const r = getQuickRange('thisMonth', now)
    expect(dayKey(r.from)).toBe('2026-02-01')
    expect(dayKey(r.to)).toBe('2026-02-28')
  })

  it('lastWeek across DST spring-forward stays on Mon–Sun', () => {
    // EU DST 2026 spring-forward is Sun 2026-03-29.
    // From Mon 2026-04-06: lastWeek = Mon 2026-03-30 .. Sun 2026-04-05.
    // The Sunday inside that range (2026-03-29) is the DST day — we must
    // still get a clean Mon–Sun span without losing or gaining a day.
    const now = local(2026, 4, 6) // Mon after DST week
    const r = getQuickRange('lastWeek', now)
    expect(dayKey(r.from)).toBe('2026-03-30')
    expect(dayKey(r.to)).toBe('2026-04-05')
  })
})

/**
 * `localDateKey` moved here from `CalendarView` in #153, where the export view
 * needed the same formatting to hand a range to the export modal. `dayKey`
 * above is kept as an independent copy on purpose, so the `getQuickRange`
 * assertions do not lean on the function under test here.
 */
describe('localDateKey', () => {
  it('zero-pads single-digit months and days', () => {
    expect(localDateKey(local(2026, 1, 5))).toBe('2026-01-05')
  })

  it('does not pad values that are already two digits', () => {
    expect(localDateKey(local(2026, 12, 31))).toBe('2026-12-31')
  })

  it('reports the local calendar day at midnight, not the UTC one', () => {
    // The reason this helper exists instead of `toISOString().slice(0, 10)`:
    // east of Greenwich, 00:30 local is still the previous day in UTC. The
    // Date is built from local components, so this holds in every timezone.
    expect(localDateKey(local(2026, 3, 15, 0, 30))).toBe('2026-03-15')
  })

  it('reports the local calendar day just before midnight', () => {
    expect(localDateKey(local(2026, 3, 15, 23, 59))).toBe('2026-03-15')
  })

  it('does not roll over across a year boundary', () => {
    expect(localDateKey(local(2026, 1, 1, 0, 1))).toBe('2026-01-01')
    expect(localDateKey(local(2025, 12, 31, 23, 59))).toBe('2025-12-31')
  })
})

describe('getQuickRange — week_start setting (#188)', () => {
  it('defaults to Monday when no week start is passed', () => {
    // 2026-04-24 is a Friday. Same expectation as the tests above, stated
    // explicitly so the default cannot be changed unnoticed.
    const r = getQuickRange('thisWeek', local(2026, 4, 24))
    expect(dayKey(r.from)).toBe('2026-04-20') // Mon
    expect(dayKey(r.to)).toBe('2026-04-26') // Sun
  })

  it('thisWeek anchors to Sunday when configured that way', () => {
    const r = getQuickRange('thisWeek', local(2026, 4, 24), 'sunday')
    expect(dayKey(r.from)).toBe('2026-04-19') // Sun
    expect(dayKey(r.to)).toBe('2026-04-25') // Sat
    expect(r.from.getHours()).toBe(0)
    expect(r.to.getMilliseconds()).toBe(999)
  })

  it('on the boundary day itself the week starts that day', () => {
    // 2026-04-19 is a Sunday.
    const r = getQuickRange('thisWeek', local(2026, 4, 19), 'sunday')
    expect(dayKey(r.from)).toBe('2026-04-19')
    expect(dayKey(r.to)).toBe('2026-04-25')
  })

  it('lastWeek shifts by exactly seven days under both settings', () => {
    const mon = getQuickRange('lastWeek', local(2026, 4, 24), 'monday')
    expect(dayKey(mon.from)).toBe('2026-04-13')
    expect(dayKey(mon.to)).toBe('2026-04-19')

    const sun = getQuickRange('lastWeek', local(2026, 4, 24), 'sunday')
    expect(dayKey(sun.from)).toBe('2026-04-12')
    expect(dayKey(sun.to)).toBe('2026-04-18')
  })

  it('month ranges ignore the setting', () => {
    const a = getQuickRange('thisMonth', local(2026, 4, 24), 'monday')
    const b = getQuickRange('thisMonth', local(2026, 4, 24), 'sunday')
    expect(dayKey(a.from)).toBe(dayKey(b.from))
    expect(dayKey(a.to)).toBe(dayKey(b.to))
  })
})
