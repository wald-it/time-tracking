/**
 * The Heute totals and the weekday average on the day the clocks go back
 * (2026-10-25, 03:00 CEST → 02:00 CET) in Europe/Berlin — the two paths
 * `dstNightTotals.local.test.ts` cannot cover (#263).
 *
 * Both cut days with SQLite's 'localtime', which reads the process zone and
 * ignores a `process.env.TZ` set at runtime. So this file pins nothing: it
 * runs in the `berlin` Vitest project, which vitest.config.ts registers only
 * when the process runs in Europe/Berlin (CI: the Linux job with
 * TZ=Europe/Berlin). The first test checks that both clocks really do.
 *
 * The Heute queries also compare against SQLite's 'now', which no test can set
 * from outside. `pinSqliteNow` replaces date/datetime/julianday/strftime on the
 * test connection with wrappers that swap 'now' for a fixed instant and hand
 * every call to a second connection's built-in function — so the 'localtime'
 * arithmetic under test is still SQLite's own, only the clock is fixed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { readTodayEntries, readTotals, readWeekDaySeconds } from './dashboardTotals'
import { buildAnalyticsSummary } from './analyticsHandlers'

let DatabaseImpl: DatabaseCtor
/** A connection whose date functions stay SQLite's built-ins. */
let builtins: Database.Database

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
  builtins = new DatabaseImpl(':memory:')
})
afterAll(() => builtins.close())

/** SQLite's 'now' on `db` becomes `nowUtc` ('YYYY-MM-DD HH:MM:SS', UTC). */
function pinSqliteNow(db: Database.Database, nowUtc: string): void {
  for (const name of ['date', 'datetime', 'julianday', 'strftime']) {
    const stmts = new Map<number, Database.Statement>()
    db.function(name, { varargs: true }, (...args: unknown[]) => {
      const swapped = args.map((a) =>
        typeof a === 'string' && a.toLowerCase() === 'now' ? nowUtc : a
      )
      let stmt = stmts.get(swapped.length)
      if (!stmt) {
        stmt = builtins.prepare(`SELECT ${name}(${swapped.map(() => '?').join(', ')})`).pluck()
        stmts.set(swapped.length, stmt)
      }
      return stmt.get(...swapped)
    })
  }
}

/** [startUtc, stopUtc, what it is in local time] */
const ENTRIES: Array<[string, string, string]> = [
  ['2026-10-19T08:00:00.000Z', '2026-10-19T09:00:00.000Z', '19.10. 10:00–11:00 CEST (Mon)'],
  // 23:45 CEST on Saturday the 24th — the day before, also in UTC.
  ['2026-10-24T21:45:00.000Z', '2026-10-24T21:55:00.000Z', '24.10. 23:45–23:55 CEST'],
  // The night: 01:30 CEST → 02:30 CEST → 02:30 CET → 03:30 CET, three real
  // hours. The first starts on the 24th in UTC.
  ['2026-10-24T23:30:00.000Z', '2026-10-25T00:30:00.000Z', '25.10. 01:30–02:30 CEST'],
  ['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z', '25.10. 02:30 CEST–02:30 CET'],
  ['2026-10-25T01:30:00.000Z', '2026-10-25T02:30:00.000Z', '25.10. 02:30–03:30 CET'],
  // 23:00–23:30 CET: inside the day only because it has 25 hours.
  ['2026-10-25T22:00:00.000Z', '2026-10-25T22:30:00.000Z', '25.10. 23:00–23:30 CET']
]
const DAY_SECONDS = 3 * 3600 + 30 * 60
const HOUR = 3600

describe('Heute and the weekday average across the clock change (Europe/Berlin)', () => {
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
  afterEach(() => db.close())

  it('both clocks run in Berlin: a 25-hour day in JS and in SQLite', () => {
    expect((new Date(2026, 9, 26).getTime() - new Date(2026, 9, 25).getTime()) / HOUR / 1000).toBe(
      25
    )
    const row = db
      .prepare(
        `SELECT DATE('2026-10-24T23:30:00.000Z', 'localtime') AS d,
                datetime('2026-10-25T00:30:00.000Z', 'localtime') AS before,
                datetime('2026-10-25T01:30:00.000Z', 'localtime') AS after`
      )
      .get() as { d: string; before: string; after: string }
    expect(row).toEqual({
      d: '2026-10-25',
      before: '2026-10-25 02:30:00',
      after: '2026-10-25 02:30:00'
    })
  })

  // 23:45 CET on the 25th — the last 15 minutes of the 25-hour day.
  describe('at 23:45 CET on Sunday the 25th', () => {
    beforeEach(() => pinSqliteNow(db, '2026-10-25 22:45:00'))

    it('the pin reaches SQLite: today is the 25th', () => {
      expect(db.prepare(`SELECT DATE('now', 'localtime')`).pluck().get()).toBe('2026-10-25')
    })

    it('today_seconds is the whole 25-hour day, 3 h 30 min', () => {
      expect(readTotals(db)).toEqual({
        today_seconds: DAY_SECONDS,
        // The week (Monday the 19th on) adds Monday's hour and Saturday's 10 min.
        week_seconds: DAY_SECONDS + HOUR + 10 * 60
      })
    })

    it("today's entries are exactly the four of the 25th, newest first", () => {
      expect(readTodayEntries(db).map((e) => e.description)).toEqual([
        '25.10. 23:00–23:30 CET',
        '25.10. 02:30–03:30 CET',
        '25.10. 02:30 CEST–02:30 CET',
        '25.10. 01:30–02:30 CEST'
      ])
    })

    it('the WeekMeter puts the night on Sunday and agrees with the totals', () => {
      const days = readWeekDaySeconds(db)
      expect(days).toEqual([HOUR, 0, 0, 0, 0, 10 * 60, DAY_SECONDS])
      expect(days.reduce((a, b) => a + b, 0)).toBe(readTotals(db).week_seconds)
    })
  })

  it('the weekday average counts the night on Sunday', () => {
    // now = Mon 26 Oct; the span is Tue 28 Jul … Sun 25 Oct: 12 Mondays,
    // 13 of every other weekday.
    const res = buildAnalyticsSummary(db, { year: 2026, month: 10 }, new Date(2026, 9, 26, 12))
    if (!res.ok) throw new Error(res.error)
    const byDay = new Map(res.data.weekday.map((w) => [w.d, w.h]))
    expect(byDay.get('So')).toBe(Math.round(DAY_SECONDS / 13))
    expect(byDay.get('Sa')).toBe(Math.round((10 * 60) / 13))
    expect(byDay.get('Mo')).toBe(HOUR / 12)
  })
})
