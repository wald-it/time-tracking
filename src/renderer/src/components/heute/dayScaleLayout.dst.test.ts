/**
 * entrySecondsToday on the night the clocks go back (Europe/Berlin).
 *
 * Pinned to Europe/Berlin for the whole file, on purpose in a file of its own:
 * `delete process.env.TZ` (or assigning back `undefined`) does not reset
 * Node's time zone, so a pin inside a shared test file leaks into the tests
 * after it. Vitest runs each test file in its own process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { entrySecondsToday, type ScaleEntry } from './dayScaleLayout'

const previousTz = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'Europe/Berlin'
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

describe('entrySecondsToday across a DST switch', () => {
  it('counts elapsed seconds on the night the clocks go back', () => {
    const entry: ScaleEntry = {
      started_at: '2026-10-24T22:00:00.000Z', // 00:00 CEST, 25 Oct
      stopped_at: '2026-10-25T03:00:00.000Z' // 04:00 CET
    }
    expect(entrySecondsToday(entry, Date.parse('2026-10-25T10:00:00.000Z'))).toBe(5 * 3600)
  })

  it('still clips an entry from yesterday at midnight', () => {
    const entry: ScaleEntry = {
      started_at: '2026-10-24T20:00:00.000Z', // 22:00 CEST, 24 Oct
      stopped_at: '2026-10-24T23:00:00.000Z' // 01:00 CEST, 25 Oct
    }
    expect(entrySecondsToday(entry, Date.parse('2026-10-25T10:00:00.000Z'))).toBe(3600)
  })
})
