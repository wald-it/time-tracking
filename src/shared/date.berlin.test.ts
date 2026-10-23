/**
 * #334 on the day the clocks go back (2026-10-25 has 25 hours in
 * Europe/Berlin): the next midnight is a calendar day later, not 24 hours.
 * Runs in the `berlin` project, so it means something only in that zone.
 */
import { describe, expect, it } from 'vitest'
import { endsAtNextMidnight, parseStopToDate } from './date'

describe('the end of the 25-hour day (Europe/Berlin)', () => {
  it('midnight after the 25th is 00:00 on the 26th, 25 hours after its start', () => {
    const stop = parseStopToDate('2026-10-25', '00:00', true)
    expect([stop.getDate(), stop.getHours(), stop.getMinutes()]).toEqual([26, 0, 0])
    expect((stop.getTime() - new Date(2026, 9, 25).getTime()) / 3_600_000).toBe(25)
    expect(endsAtNextMidnight(new Date(2026, 9, 25, 20), stop)).toBe(true)
  })
})
