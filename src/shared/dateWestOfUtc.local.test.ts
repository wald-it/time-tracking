/**
 * The calendar form hands over the day as a bare date ('2026-06-10', from
 * <input type="date">). Read as UTC midnight, that is the previous day
 * everywhere west of UTC, and the form saved entries a day early — with
 * #334's midnight end also an entry moved from the 10th to the 9th. Pinned to
 * America/New_York in its own file: `delete process.env.TZ` does not reset
 * Node's zone (#248). Only JS dates, no SQLite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const previousTz = process.env.TZ
let date: typeof import('./date')

beforeAll(async () => {
  process.env.TZ = 'America/New_York'
  date = await import('./date')
})
// Tidy, not isolation: the file's own process keeps the zone from leaking.
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

describe('the form date west of UTC (America/New_York)', () => {
  it('a bare date is that local day', () => {
    expect(date.parseTimeToDate('2026-06-10', '20:00')).toEqual(new Date(2026, 5, 10, 20))
  })

  it('the midnight end of an entry on the 10th is midnight after the 10th', () => {
    expect(date.parseStopToDate('2026-06-10', '00:00', true)).toEqual(new Date(2026, 5, 11))
  })

  it('a full timestamp is still read as the instant it names', () => {
    expect(date.parseTimeToDate('2026-06-10T22:00:00.000Z', '09:00')).toEqual(
      new Date(2026, 5, 10, 9)
    )
  })
})
