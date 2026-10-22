/**
 * Local day and month boundaries as UTC instants (shared/dateRanges).
 * Pinned to Europe/Berlin for the whole file, on purpose in a file of its own:
 * `delete process.env.TZ` does not reset Node's time zone, so a pin inside a
 * shared test file leaks into the tests after it. Vitest runs each test file
 * in its own process.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { localDayRange, localMonthRange } from './dateRanges'

describe('local day and month ranges as instants', () => {
  const previousTz = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'Europe/Berlin'
  })
  afterAll(() => {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  })

  it('cuts October 2026 at local midnight (CEST start, CET end)', () => {
    expect(localMonthRange(2026, 10)).toEqual({
      start: '2026-09-30T22:00:00.000Z',
      end: '2026-10-31T23:00:00.000Z'
    })
  })

  it('cuts March 2026 at local midnight (CET start, CEST end)', () => {
    expect(localMonthRange(2026, 3)).toEqual({
      start: '2026-02-28T23:00:00.000Z',
      end: '2026-03-31T22:00:00.000Z'
    })
  })

  it('rolls December over into the next year', () => {
    expect(localMonthRange(2026, 12).end).toBe('2026-12-31T23:00:00.000Z')
  })

  it('a day range ends at the local start of the day after, a clock-change day is 25 h', () => {
    const r = localDayRange('2026-10-25', '2026-10-25')
    expect(r).toEqual({ start: '2026-10-24T22:00:00.000Z', end: '2026-10-25T23:00:00.000Z' })
    expect(Date.parse(r.end) - Date.parse(r.start)).toBe(25 * 3600 * 1000)
  })

  it('rejects impossible dates and months instead of rolling them over', () => {
    expect(() => localDayRange('2026-02-30', '2026-03-01')).toThrow(/Datum/)
    expect(() => localDayRange('2026-3-1', '2026-03-01')).toThrow(/Datum/)
    expect(() => localMonthRange(2026, 13)).toThrow(/Monat/)
    expect(() => localMonthRange(2026, 0)).toThrow(/Monat/)
  })
})
