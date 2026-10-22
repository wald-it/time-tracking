import { describe, it, expect } from 'vitest'
import {
  billedMinutes,
  effectiveRateCent,
  feeCent,
  formatEur,
  roundMinutes,
  formatHoursMinutes
} from './currency'

describe('feeCent', () => {
  it('returns 0 when rate is 0 or minutes are 0', () => {
    expect(feeCent(60, 0)).toBe(0)
    expect(feeCent(0, 8500)).toBe(0)
  })

  it('60 minutes at 85 EUR/h = 8500 cent', () => {
    expect(feeCent(60, 8500)).toBe(8500)
  })

  it('30 minutes at 85 EUR/h = 4250 cent', () => {
    expect(feeCent(30, 8500)).toBe(4250)
  })

  it('rounds half-up to the nearest cent (84 min × 85 EUR/h)', () => {
    // (84/60) * 8500 = 11900 exactly — no rounding artifact here
    expect(feeCent(84, 8500)).toBe(11900)
    // 1 min at 85 EUR/h = 141.6666… cent → 142
    expect(feeCent(1, 8500)).toBe(142)
  })

  it('handles tiny rates without losing pennies', () => {
    // 7 min at 1 cent/h = 0.1166... → rounds to 0
    expect(feeCent(7, 1)).toBe(0)
    // 30 min at 1 cent/h = 0.5 → rounds half-up to 1
    expect(feeCent(30, 1)).toBe(1)
  })
})

describe('formatEur', () => {
  it('formats common amounts in DE locale', () => {
    expect(formatEur(0)).toBe('0,00 €')
    expect(formatEur(50)).toBe('0,50 €')
    expect(formatEur(123)).toBe('1,23 €')
    expect(formatEur(8500)).toBe('85,00 €')
  })

  it('inserts thousand separators (dots in DE)', () => {
    expect(formatEur(123456)).toBe('1.234,56 €')
    expect(formatEur(1234567890)).toBe('12.345.678,90 €')
  })

  it('keeps two decimal places even for round amounts', () => {
    expect(formatEur(10000)).toBe('100,00 €')
  })

  it('handles negative cents (refunds, corrections)', () => {
    expect(formatEur(-123)).toBe('-1,23 €')
  })
})

describe('roundMinutes', () => {
  it('passes through unchanged when step is 0 or negative', () => {
    expect(roundMinutes(83, 0)).toBe(83)
    expect(roundMinutes(83, -5)).toBe(83)
  })

  it('keeps zero at zero (no work, no billable time)', () => {
    expect(roundMinutes(0, 15)).toBe(0)
    expect(roundMinutes(-5, 15)).toBe(0)
  })

  it('ceils to 5-minute steps (every started step counts)', () => {
    expect(roundMinutes(1, 5)).toBe(5)
    expect(roundMinutes(5, 5)).toBe(5)
    expect(roundMinutes(82, 5)).toBe(85)
    expect(roundMinutes(83, 5)).toBe(85)
    expect(roundMinutes(85, 5)).toBe(85)
  })

  it('ceils to 15-minute steps (angebrochene Viertelstunde voll)', () => {
    expect(roundMinutes(1, 15)).toBe(15)
    expect(roundMinutes(7, 15)).toBe(15)
    expect(roundMinutes(8, 15)).toBe(15)
    expect(roundMinutes(15, 15)).toBe(15)
    expect(roundMinutes(16, 15)).toBe(30)
    expect(roundMinutes(22, 15)).toBe(30)
    expect(roundMinutes(23, 15)).toBe(30)
  })
})

describe('formatHoursMinutes', () => {
  it('formats H:MM with two-digit minutes', () => {
    expect(formatHoursMinutes(0)).toBe('0:00')
    expect(formatHoursMinutes(5)).toBe('0:05')
    expect(formatHoursMinutes(84)).toBe('1:24')
    expect(formatHoursMinutes(600)).toBe('10:00')
  })

  it('handles negative durations', () => {
    expect(formatHoursMinutes(-65)).toBe('-1:05')
  })
})

describe('billedMinutes', () => {
  it('ceils a sub-minute entry to 1 minute instead of 0', () => {
    expect(billedMinutes(5_000, 0)).toBe(1)
  })
  it('ceils to whole minutes, then up to the step', () => {
    expect(billedMinutes(61_000, 0)).toBe(2)
    expect(billedMinutes(16 * 60_000, 15)).toBe(30)
  })
  it('keeps zero at zero', () => {
    expect(billedMinutes(0, 15)).toBe(0)
  })
})

describe('effectiveRateCent', () => {
  it('prefers a positive project rate', () => {
    expect(effectiveRateCent(15000, 10000)).toBe(15000)
  })
  it('falls back to the client rate for null, undefined or 0', () => {
    expect(effectiveRateCent(null, 10000)).toBe(10000)
    expect(effectiveRateCent(undefined, 10000)).toBe(10000)
    expect(effectiveRateCent(0, 10000)).toBe(10000)
  })
})
