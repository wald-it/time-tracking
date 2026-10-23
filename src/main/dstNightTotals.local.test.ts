/**
 * The night the clocks go back (2026-10-25, 03:00 CEST → 02:00 CET) in
 * Europe/Berlin: the calendar's day total and the PDF time sheet agree on the
 * worked time of that 25-hour day, and both cut the day at local midnight.
 *
 * Its own file on purpose (#248/#250): `delete process.env.TZ` does not reset
 * Node's zone. Only paths that cut the day in JS are pinned here — the
 * calendar month (`monthEntries`, `localMonthRange`), the calendar's day
 * bucketing (`localDateKey` + `entrySeconds`, the formula CalendarView sums)
 * and the PDF (`localDayRange`). The Heute totals and the weekday average cut
 * with SQLite's 'localtime', which ignores the pin on Windows; they cannot be
 * pinned to Berlin on the UTC Windows runner and are not covered here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { monthEntries } from './entryRanges'
import { localDateKey } from '../shared/dateRanges'
import { entrySeconds } from '../renderer/src/components/kalender/clientShares'

let DatabaseImpl: DatabaseCtor
const previousTz = process.env.TZ
// Imported only after the zone is set: pdf.ts builds its Intl date/time
// formatters when the module loads, and a static import would give them the
// runner's zone (UTC on CI) — the PDF dates went to 24.10. there.
let buildPdfPayload: typeof import('./pdf').buildPdfPayload

beforeAll(async () => {
  process.env.TZ = 'Europe/Berlin'
  DatabaseImpl = await loadSqlite()
  ;({ buildPdfPayload } = await import('./pdf'))
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

/** [startUtc, stopUtc, what it is in local time] */
const ENTRIES: Array<[string, string, string]> = [
  // Outside the day: 23:45 CEST on the 24th, 00:15 CET on the 26th.
  ['2026-10-24T21:45:00.000Z', '2026-10-24T21:55:00.000Z', '24.10. 23:45–23:55'],
  ['2026-10-25T23:15:00.000Z', '2026-10-25T23:30:00.000Z', '26.10. 00:15–00:30'],
  // The night: 01:30 CEST → 02:30 CEST → 02:30 CET → 03:30 CET, three real hours.
  ['2026-10-24T23:30:00.000Z', '2026-10-25T00:30:00.000Z', '25.10. 01:30–02:30 CEST'],
  ['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z', '25.10. 02:30 CEST–02:30 CET'],
  ['2026-10-25T01:30:00.000Z', '2026-10-25T02:30:00.000Z', '25.10. 02:30–03:30 CET'],
  // 23:00–23:30 CET: inside the day only because it has 25 hours (a 24-hour
  // day from local midnight would end at 22:00Z).
  ['2026-10-25T22:00:00.000Z', '2026-10-25T22:30:00.000Z', '25.10. 23:00–23:30 CET']
]
const DAY_SECONDS = 3 * 3600 + 30 * 60

describe('the night the clocks go back (Europe/Berlin, 2026-10-25)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    db.prepare(`INSERT INTO clients (id, name, rate_cent) VALUES (1, 'Acme', 0)`).run()
    const ins = db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, heartbeat_at, billable)
       VALUES (1, ?, ?, ?, ?, 1)`
    )
    for (const [start, stop, label] of ENTRIES) ins.run(label, start, stop, stop)
  })

  it('the pin holds: the day has 25 hours in JS', () => {
    const start = new Date(2026, 9, 25).getTime()
    const end = new Date(2026, 9, 26).getTime()
    expect((end - start) / 3_600_000).toBe(25)
  })

  it('calendar day total = PDF total for the day, 3 h 30 min', () => {
    // Calendar: the month query, bucketed by the local day of the start.
    const month = monthEntries(db, 2026, 10)
    const day = month.filter((e) => localDateKey(new Date(e.started_at)) === '2026-10-25')
    const calendarSeconds = day.reduce((sum, e) => sum + entrySeconds(e, Date.now()), 0)
    expect(day.map((e) => e.description)).toEqual([
      '25.10. 01:30–02:30 CEST',
      '25.10. 02:30 CEST–02:30 CET',
      '25.10. 02:30–03:30 CET',
      '25.10. 23:00–23:30 CET'
    ])
    expect(calendarSeconds).toBe(DAY_SECONDS)

    // PDF time sheet for exactly that local day.
    const pdf = buildPdfPayload(
      db,
      { clientId: 1, fromIso: '2026-10-25', toIso: '2026-10-25' },
      '',
      '2026-10-26T12:00:00.000Z'
    )
    expect(pdf.rows.map((r) => r.description)).toEqual(day.map((e) => e.description))
    expect(pdf.totals.minutes * 60).toBe(calendarSeconds)
    // Every row is dated on the 25th, also the one that starts at 23:30Z on the 24th.
    expect(new Set(pdf.rows.map((r) => r.date))).toEqual(new Set(['25.10.2026']))
    // The doubled hour shows as such: 02:30 → 02:30, one hour.
    const doubled = pdf.rows.find((r) => r.description === '25.10. 02:30 CEST–02:30 CET')!
    expect([doubled.startTime, doubled.stopTime, doubled.minutes]).toEqual(['02:30', '02:30', 60])
  })

  it('the neighbour days keep their own entries', () => {
    const month = monthEntries(db, 2026, 10)
    const keys = month.map((e) => localDateKey(new Date(e.started_at)))
    expect(keys.filter((k) => k === '2026-10-24')).toHaveLength(1)
    expect(keys.filter((k) => k === '2026-10-26')).toHaveLength(1)
    const pdf24 = buildPdfPayload(
      db,
      { clientId: 1, fromIso: '2026-10-24', toIso: '2026-10-24' },
      ''
    )
    const pdf26 = buildPdfPayload(
      db,
      { clientId: 1, fromIso: '2026-10-26', toIso: '2026-10-26' },
      ''
    )
    expect([pdf24.totals.minutes, pdf26.totals.minutes]).toEqual([10, 15])
  })
})
