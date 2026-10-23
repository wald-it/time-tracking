/**
 * #334 where a day has no 00:00: in America/Santiago the clocks jump from
 * 00:00 to 01:00 when summer time starts (2026-09-06), so the split boundary
 * after 2026-09-05 is 01:00 and the drawer shows the first half ending at
 * 01:00. Its own file: `delete process.env.TZ` does not reset Node's zone
 * (vault note, #248). Only JS dates here, no SQLite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const previousTz = process.env.TZ
let date: typeof import('./date')
let split: typeof import('./midnightSplit')

beforeAll(async () => {
  process.env.TZ = 'America/Santiago'
  date = await import('./date')
  split = await import('./midnightSplit')
})
// Tidy, not isolation: the file's own process is what keeps the zone from
// leaking (see the header).
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

describe('a first half that ends at 01:00 because 00:00 does not exist', () => {
  it('the pin holds: midnight after 2026-09-05 is 01:00', () => {
    const next = split.localMidnightAfter(new Date(2026, 8, 5, 20))
    expect(date.formatTimeHHMM(next)).toBe('01:00')
  })

  it('the form reads 01:00 on that entry as the boundary, not as 01:00 the same day', () => {
    const start = new Date(2026, 8, 5, 20)
    const boundary = split.localMidnightAfter(start)
    expect(date.endsAtNextMidnight(start, boundary)).toBe(true)
    expect(date.parseStopToDate('2026-09-05T12:00:00', '01:00', true)).toEqual(boundary)
  })
})
