import { describe, expect, it } from 'vitest'
import { parseLongRunThresholdHours, shouldAskLongRun } from './longRun'

describe('long-running threshold', () => {
  it.each([undefined, '', ' ', 'junk', '6h', '1.5', 'NaN', 'Infinity', '0', '-1', '25', '999'])(
    'defaults invalid value %s to six rather than clamping',
    (raw) => {
      expect(parseLongRunThresholdHours(raw)).toBe(6)
    }
  )
  it.each(['1', '6', '12', '24', ' 8 '])('accepts integer hours %s', (raw) => {
    expect(parseLongRunThresholdHours(raw)).toBe(Number(raw))
  })
})

describe('long-running decision', () => {
  const entry = { id: 7, started_at: new Date(2026, 10, 1, 18).toISOString(), stopped_at: null }
  const start = Date.parse(entry.started_at)
  it('asks at six hours, not at 5:59:59', () => {
    expect(shouldAskLongRun(entry, start + 21_599_000, 6, new Set())).toBe(false)
    expect(shouldAskLongRun(entry, start + 21_600_000, 6, new Set())).toBe(true)
  })
  it('does not ask for stopped, absent or already answered entries', () => {
    const now = start + 30_000_000
    expect(
      shouldAskLongRun({ ...entry, stopped_at: new Date(now).toISOString() }, now, 6, new Set())
    ).toBe(false)
    expect(shouldAskLongRun(null, now, 6, new Set())).toBe(false)
    expect(shouldAskLongRun(entry, now, 6, new Set([7]))).toBe(false)
  })
})
