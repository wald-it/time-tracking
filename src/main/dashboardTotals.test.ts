/**
 * Tests for the shared today/week totals (#186).
 *
 * Two jobs: pin the window semantics (running entry counts, entries outside
 * the window do not), and pin the numbers against the *other* copy of the same
 * definition — `getDashboard()` in the read-only MCP layer. Both are read by
 * different surfaces; if one is ever changed alone, this goes red instead of
 * the dial quietly disagreeing with the app.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import {
  readRoundMinutes,
  readTodayEntries,
  readTotals,
  readWeekDaySeconds,
  readWeekStart
} from './dashboardTotals'
import { weekStartModifiers } from '../shared/weekStart'
import { getDashboard, type SqliteDb } from '../mcp/queries'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

function iso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString()
}

/**
 * ISO timestamp for 12:00 **local** on a `YYYY-MM-DD` day. The queries compare
 * `DATE(started_at,'localtime')`, so building the instant from local parts is
 * what keeps the test honest in any timezone.
 */
function atLocalNoon(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0, 0).toISOString()
}

/**
 * Seconds elapsed today, by the same wall clock SQLite reads. Used to phrase
 * assertions in terms of what the current hour permits instead of a constant
 * that only holds later in the day (#213). Faking the clock would not help
 * here: a running entry is measured with `strftime('%s','now')` inside SQLite,
 * which `vi.setSystemTime()` does not move.
 */
function secondsSinceLocalMidnight(): number {
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  return Math.floor((Date.now() - midnight.getTime()) / 1000)
}

/** Local-midnight-safe: a date N days back at 10:00 local time. */
function daysAgoAt10(days: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(10, 0, 0, 0)
  return d
}

function addClosed(db: Database.Database, startedAt: string, minutes: number): void {
  db.prepare(
    `INSERT INTO entries (client_id, description, started_at, stopped_at, billable)
     VALUES (1, 'x', ?, ?, 1)`
  ).run(startedAt, new Date(Date.parse(startedAt) + minutes * 60_000).toISOString())
}

describe('readTotals', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    db.prepare(
      `INSERT INTO clients (id, name, color, active, rate_cent) VALUES (1,'Acme','#111',1,0)`
    ).run()
  })

  it('is zero on an empty database', () => {
    expect(readTotals(db)).toEqual({ today_seconds: 0, week_seconds: 0 })
  })

  it('sums closed entries of today into both windows', () => {
    addClosed(db, iso(-3 * 3_600_000), 30)
    addClosed(db, iso(-2 * 3_600_000), 15)
    const t = readTotals(db)
    expect(t.today_seconds).toBe(45 * 60)
    expect(t.week_seconds).toBe(45 * 60)
  })

  it('counts a running entry up to now, in both windows', () => {
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, billable)
       VALUES (1, 'running', ?, 1)`
    ).run(iso(-600_000))
    const t = readTotals(db)
    expect(t.today_seconds).toBeGreaterThanOrEqual(600)
    expect(t.today_seconds).toBeLessThan(660)
    expect(t.week_seconds).toBe(t.today_seconds)
  })

  it('counts a running entry started before midnight — the cross-midnight case', () => {
    const yesterdayEvening = daysAgoAt10(1)
    yesterdayEvening.setHours(22, 0, 0, 0)
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, billable)
       VALUES (1, 'overnight', ?, 1)`
    ).run(yesterdayEvening.toISOString())
    // `OR stopped_at IS NULL` puts it in today's window even though it started
    // yesterday — the app, the tray and the dial all show it that way.
    //
    // Measured against what the clock allows rather than a fixed 8h (#213):
    // the entry has been running since 22:00 yesterday, so its total must
    // exceed everything today alone could have contributed. That is precisely
    // the property under test — the pre-midnight portion is counted — and it
    // holds at every hour. The old `> 8 * 3600` silently assumed the suite ran
    // after 06:00 local, so CI went red whenever it started early in the UTC
    // morning while every local run stayed green.
    expect(readTotals(db).today_seconds).toBeGreaterThan(secondsSinceLocalMidnight() + 3600)
  })

  it('excludes deleted entries and entries older than the week window', () => {
    addClosed(db, daysAgoAt10(0).toISOString(), 60)
    addClosed(db, daysAgoAt10(30).toISOString(), 120)
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, billable, deleted_at)
       VALUES (1, 'trash', ?, ?, 1, ?)`
    ).run(iso(-7_200_000), iso(-3_600_000), iso(0))

    const t = readTotals(db)
    expect(t.today_seconds).toBe(60 * 60)
    expect(t.week_seconds).toBe(60 * 60)
  })

  it('week ≥ today whenever both windows are populated', () => {
    addClosed(db, daysAgoAt10(0).toISOString(), 45)
    // Two days back is inside the window on most weekdays; either way the
    // invariant week ≥ today must hold.
    addClosed(db, daysAgoAt10(2).toISOString(), 90)
    const t = readTotals(db)
    expect(t.week_seconds).toBeGreaterThanOrEqual(t.today_seconds)
  })

  it('readRoundMinutes: off unless the setting holds a positive number', () => {
    const set = (v: string): void => {
      db.prepare(
        `INSERT OR REPLACE INTO settings (key, value) VALUES ('pdf_round_minutes', ?)`
      ).run(v)
    }
    // Unset ⇒ no rounding.
    expect(readRoundMinutes(db)).toBe(0)
    set('15')
    expect(readRoundMinutes(db)).toBe(15)
    set('0')
    expect(readRoundMinutes(db)).toBe(0)
    // Garbage must not switch rounding on — same tolerance as the renderer's
    // parseInt in RoundingContext.
    set('abc')
    expect(readRoundMinutes(db)).toBe(0)
    set('-5')
    expect(readRoundMinutes(db)).toBe(0)
  })

  it('readWeekStart: Monday unless the setting says sunday', () => {
    expect(readWeekStart(db)).toBe('monday')
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('week_start','sunday')`).run()
    expect(readWeekStart(db)).toBe('sunday')
    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('week_start','nonsense')`
    ).run()
    expect(readWeekStart(db)).toBe('monday')
  })

  // The two settings pick different start days, so a fixed calendar date would
  // only exercise one of them depending on when the suite runs. Instead: ask
  // SQLite where the window starts for the configured setting, then place one
  // entry exactly ON that day and one exactly the day BEFORE. That is
  // deterministic on every weekday, which is the whole point — the bug this
  // replaces was invisible on six days out of seven.
  for (const week of ['monday', 'sunday'] as const) {
    it(`week window follows the setting — ${week}`, () => {
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('week_start', ?)`).run(week)
      const start = (
        db.prepare(`SELECT DATE('now','localtime',${weekStartModifiers(week)}) AS d`).get() as {
          d: string
        }
      ).d
      const before = (db.prepare(`SELECT DATE(?, '-1 day') AS d`).get(start) as { d: string }).d

      addClosed(db, atLocalNoon(start), 30)
      addClosed(db, atLocalNoon(before), 60)

      // Only the entry inside the window counts; the day before is out.
      expect(readTotals(db).week_seconds).toBe(30 * 60)
    })
  }

  it('the two settings disagree exactly on the days between them', () => {
    // An entry on the most recent Sunday: inside a Sunday-anchored week
    // always, inside a Monday-anchored week only when that Sunday is today.
    const sunday = (
      db.prepare(`SELECT DATE('now','localtime','-6 days','weekday 0') AS d`).get() as { d: string }
    ).d
    const todayIsSunday =
      (db.prepare(`SELECT DATE('now','localtime') AS d`).get() as { d: string }).d === sunday
    addClosed(db, atLocalNoon(sunday), 45)

    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('week_start','sunday')`).run()
    expect(readTotals(db).week_seconds).toBe(45 * 60)

    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('week_start','monday')`).run()
    expect(readTotals(db).week_seconds).toBe(todayIsSunday ? 45 * 60 : 0)
  })

  // Under BOTH settings: the MCP dashboard is the second copy of this
  // definition, and a setting that reaches only one of them would be worse
  // than no setting at all.
  for (const week of ['monday', 'sunday'] as const) {
    it(`agrees with getDashboard() — ${week}`, () => {
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('week_start', ?)`).run(week)
      addClosed(db, daysAgoAt10(0).toISOString(), 45)
      addClosed(db, daysAgoAt10(2).toISOString(), 90)
      addClosed(db, daysAgoAt10(5).toISOString(), 75)
      addClosed(db, daysAgoAt10(20).toISOString(), 30)
      db.prepare(
        `INSERT INTO entries (client_id, description, started_at, billable)
         VALUES (1, 'running', ?, 1)`
      ).run(iso(-120_000))

      const mine = readTotals(db)
      const theirs = getDashboard(
        db as unknown as SqliteDb,
        { exposeRates: false, exposePrivateNotes: false },
        Date.now()
      )
      expect(mine.today_seconds).toBe(theirs.today_seconds)
      expect(mine.week_seconds).toBe(theirs.week_seconds)
    })
  }
})

/**
 * The WeekMeter on "Heute" (Messinstrument, HANDOFF §3.7/§4.1) splits the week
 * total by day. It must be the SAME week as `readTotals`, split — not a second
 * definition that drifts: today's slot equals `today_seconds`, the slots sum
 * to `week_seconds`, under both week-start settings, including a timer that
 * runs across midnight (it belongs to today, as in `readTotals`).
 */
describe('readWeekDaySeconds', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    db.prepare(
      `INSERT INTO clients (id, name, color, active, rate_cent) VALUES (1,'Acme','#111',1,0)`
    ).run()
  })

  function weekStartDay(week: 'monday' | 'sunday'): string {
    return (
      db.prepare(`SELECT DATE('now','localtime',${weekStartModifiers(week)}) AS d`).get() as {
        d: string
      }
    ).d
  }

  function todayIndex(week: 'monday' | 'sunday'): number {
    return (
      db
        .prepare(`SELECT CAST(julianday(DATE('now','localtime')) - julianday(?) AS INTEGER) AS i`)
        .get(weekStartDay(week)) as { i: number }
    ).i
  }

  function setWeek(week: 'monday' | 'sunday'): void {
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('week_start', ?)`).run(week)
  }

  it('is seven zeros on an empty database', () => {
    expect(readWeekDaySeconds(db)).toEqual([0, 0, 0, 0, 0, 0, 0])
  })

  for (const week of ['monday', 'sunday'] as const) {
    it(`today's slot is today_seconds and the slots sum to week_seconds — ${week}`, () => {
      setWeek(week)
      addClosed(db, daysAgoAt10(0).toISOString(), 45)
      addClosed(db, daysAgoAt10(2).toISOString(), 90)
      addClosed(db, daysAgoAt10(5).toISOString(), 75)
      addClosed(db, daysAgoAt10(20).toISOString(), 30)

      const days = readWeekDaySeconds(db)
      const totals = readTotals(db)
      expect(days).toHaveLength(7)
      expect(days[todayIndex(week)]).toBe(totals.today_seconds)
      expect(days.reduce((a, b) => a + b, 0)).toBe(totals.week_seconds)
      // Nothing after today: the future slots stay empty.
      for (let i = todayIndex(week) + 1; i < 7; i++) expect(days[i]).toBe(0)
    })

    it(`an entry on the first day of the week lands in slot 0, the day before nowhere — ${week}`, () => {
      setWeek(week)
      const start = weekStartDay(week)
      const before = (db.prepare(`SELECT DATE(?, '-1 day') AS d`).get(start) as { d: string }).d
      addClosed(db, atLocalNoon(start), 30)
      addClosed(db, atLocalNoon(before), 60)

      const days = readWeekDaySeconds(db)
      expect(days[0]).toBe(30 * 60)
      expect(days.reduce((a, b) => a + b, 0)).toBe(30 * 60)
    })
  }

  it('puts a timer running since yesterday evening into today, like readTotals', () => {
    const yesterdayEvening = daysAgoAt10(1)
    yesterdayEvening.setHours(22, 0, 0, 0)
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, billable)
       VALUES (1, 'overnight', ?, 1)`
    ).run(yesterdayEvening.toISOString())

    const days = readWeekDaySeconds(db)
    const totals = readTotals(db)
    // A running entry is measured against 'now' inside SQLite, so the two
    // reads may be one second apart.
    expect(Math.abs(days[todayIndex('monday')] - totals.today_seconds)).toBeLessThanOrEqual(1)
    expect(Math.abs(days.reduce((a, b) => a + b, 0) - totals.week_seconds)).toBeLessThanOrEqual(1)
  })

  it('ignores deleted entries', () => {
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, billable, deleted_at)
       VALUES (1, 'trash', ?, ?, 1, ?)`
    ).run(iso(-7_200_000), iso(-3_600_000), iso(0))
    expect(readWeekDaySeconds(db)).toEqual([0, 0, 0, 0, 0, 0, 0])
  })
})

/**
 * "Heute" lists ALL of today's entries (B5, HANDOFF §4.1) — the DayScale and
 * the entry table need them with start and end. `recentEntries` (last five
 * overall) keeps its meaning; this is a separate list with the same window as
 * today's total.
 */
describe('readTodayEntries', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    db.prepare(
      `INSERT INTO clients (id, name, color, active, rate_cent) VALUES (1,'Acme','#111',1,0)`
    ).run()
  })

  it('returns every entry of today, newest first — more than five', () => {
    const base = daysAgoAt10(0)
    for (let i = 0; i < 7; i++) {
      addClosed(db, new Date(base.getTime() - i * 20 * 60_000).toISOString(), 10)
    }
    const list = readTodayEntries(db)
    expect(list).toHaveLength(7)
    const starts = list.map((e) => Date.parse(e.started_at))
    expect([...starts].sort((a, b) => b - a)).toEqual(starts)
  })

  it('includes a timer running since yesterday, excludes yesterday and deleted entries', () => {
    addClosed(db, daysAgoAt10(0).toISOString(), 30)
    addClosed(db, daysAgoAt10(1).toISOString(), 30)
    const yesterdayEvening = daysAgoAt10(1)
    yesterdayEvening.setHours(22, 0, 0, 0)
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, billable)
       VALUES (1, 'overnight', ?, 1)`
    ).run(yesterdayEvening.toISOString())
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, billable, deleted_at)
       VALUES (1, 'trash', ?, ?, 1, ?)`
    ).run(iso(-7_200_000), iso(-3_600_000), iso(0))

    const list = readTodayEntries(db)
    expect(list.map((e) => e.description).sort()).toEqual(['overnight', 'x'])
  })
})
