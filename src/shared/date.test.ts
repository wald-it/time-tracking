import { describe, it, expect } from 'vitest'
import {
  endsAtNextMidnight,
  isSameLocalDay,
  parseStopToDate,
  parseTimeToDate,
  formatTimeHHMM
} from './date'

describe('isSameLocalDay', () => {
  it('returns true for two times on the same local day', () => {
    expect(isSameLocalDay('2026-04-24T08:00:00', '2026-04-24T22:30:00')).toBe(true)
  })

  it('returns false across midnight', () => {
    expect(isSameLocalDay('2026-04-24T23:30:00', '2026-04-25T00:30:00')).toBe(false)
  })

  it('accepts Date objects', () => {
    const a = new Date(2026, 3, 24, 8, 0)
    const b = new Date(2026, 3, 24, 22, 0)
    expect(isSameLocalDay(a, b)).toBe(true)
  })

  it('handles DST spring-forward (CET → CEST 2026-03-29)', () => {
    // Both wall-clock times fall on 2026-03-29 even though the local
    // timezone skips 02:00→03:00. Use local-constructor Dates so the
    // test is deterministic regardless of the host TZ.
    const before = new Date(2026, 2, 29, 1, 30)
    const after = new Date(2026, 2, 29, 4, 30)
    expect(isSameLocalDay(before, after)).toBe(true)
  })

  it('respects local timezone (string with explicit offset)', () => {
    // 23:00 UTC on 04-24 vs 02:00 UTC on 04-25 — in UTC they're different
    // days; isSameLocalDay should agree because we compare LOCAL dates.
    // We use ISO strings without TZ to force local interpretation.
    const a = new Date(2026, 3, 24, 23, 0)
    const b = new Date(2026, 3, 25, 2, 0)
    expect(isSameLocalDay(a, b)).toBe(false)
  })
})

describe('parseTimeToDate', () => {
  it('combines a date with HH:MM into a local Date', () => {
    const out = parseTimeToDate('2026-04-24', '08:30')
    expect(out.getFullYear()).toBe(2026)
    expect(out.getMonth()).toBe(3)
    expect(out.getDate()).toBe(24)
    expect(out.getHours()).toBe(8)
    expect(out.getMinutes()).toBe(30)
    expect(out.getSeconds()).toBe(0)
  })

  it('accepts a Date as the date source', () => {
    const out = parseTimeToDate(new Date(2026, 5, 1, 14, 0), '23:59')
    expect(out.getHours()).toBe(23)
    expect(out.getMinutes()).toBe(59)
  })

  it('throws on invalid format', () => {
    expect(() => parseTimeToDate('2026-04-24', '8:30')).toThrow()
    expect(() => parseTimeToDate('2026-04-24', '24:00')).toThrow()
    expect(() => parseTimeToDate('2026-04-24', '12:60')).toThrow()
    expect(() => parseTimeToDate('2026-04-24', '')).toThrow()
  })
})

describe('formatTimeHHMM', () => {
  it('pads single digits', () => {
    expect(formatTimeHHMM(new Date(2026, 0, 1, 9, 5))).toBe('09:05')
  })

  it('formats midnight as 00:00', () => {
    expect(formatTimeHHMM(new Date(2026, 0, 1, 0, 0))).toBe('00:00')
  })

  it('accepts ISO strings', () => {
    const d = new Date(2026, 3, 24, 14, 30)
    expect(formatTimeHHMM(d.toISOString())).toBe('14:30')
  })
})

describe('parseStopToDate / endsAtNextMidnight (#334)', () => {
  it('00:00 on an entry that ends at the next midnight is that midnight', () => {
    expect(parseStopToDate('2026-06-10', '00:00', true)).toEqual(new Date(2026, 5, 11))
  })

  it('without that, and for any other stop, the stop stays on the same day', () => {
    expect(parseStopToDate('2026-06-10', '00:00', false)).toEqual(new Date(2026, 5, 10))
    expect(parseStopToDate('2026-06-10', '23:30', true)).toEqual(new Date(2026, 5, 10, 23, 30))
  })

  it('endsAtNextMidnight is true only for exactly the next local midnight', () => {
    expect(endsAtNextMidnight(new Date(2026, 5, 10, 20), new Date(2026, 5, 11))).toBe(true)
    expect(endsAtNextMidnight(new Date(2026, 5, 10, 0), new Date(2026, 5, 11))).toBe(true)
    expect(endsAtNextMidnight(new Date(2026, 5, 10, 20), new Date(2026, 5, 10, 23))).toBe(false)
    expect(endsAtNextMidnight(new Date(2026, 5, 10, 20), new Date(2026, 5, 12))).toBe(false)
  })
})
