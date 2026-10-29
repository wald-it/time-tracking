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
import { seedEntry } from '../test/entryFixtures'
import {
  readRoundMinutes,
  readRoundedTotals,
  readTodayEntries,
  readTopClients30d,
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
  seedEntry(db, {
    client_id: 1,
    description: 'x',
    started_at: startedAt,
    stopped_at: new Date(Date.parse(startedAt) + minutes * 60_000).toISOString()
  })
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
    // Built forwards from local midnight, not backwards from now: `now - 3h`
    // is yesterday between 00:00 and 03:00, and the test went red at night
    // (same trap as #213).
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    addClosed(db, new Date(midnight.getTime()).toISOString(), 30)
    addClosed(db, new Date(midnight.getTime() + 30 * 60_000).toISOString(), 15)
    const t = readTotals(db)
    expect(t.today_seconds).toBe(45 * 60)
    expect(t.week_seconds).toBe(45 * 60)
  })

  it('counts a running entry up to now, in both windows', () => {
    seedEntry(db, {
      client_id: 1,
      description: 'running',
      started_at: iso(-600_000),
      stopped_at: null
    })
    const t = readTotals(db)
    expect(t.today_seconds).toBeGreaterThanOrEqual(600)
    expect(t.today_seconds).toBeLessThan(660)
    expect(t.week_seconds).toBe(t.today_seconds)
  })

  it('counts a running entry started before midnight — the cross-midnight case', () => {
    const yesterdayEvening = daysAgoAt10(1)
    yesterdayEvening.setHours(22, 0, 0, 0)
    seedEntry(db, {
      client_id: 1,
      description: 'overnight',
      started_at: yesterdayEvening.toISOString(),
      stopped_at: null
    })
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
    seedEntry(db, {
      client_id: 1,
      description: 'trash',
      started_at: iso(-7_200_000),
      stopped_at: iso(-3_600_000),
      deleted_at: iso(0)
    })

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
      seedEntry(db, {
        client_id: 1,
        description: 'running',
        started_at: iso(-120_000),
        stopped_at: null
      })

      // readTotals counts the running entry up to SQLite's own 'now', which a
      // test cannot pin. Bracket it: getDashboard before and after must
      // enclose it (a second boundary between two reads made CI red, 2820
      // against 2821 on 2026-10-27).
      const dashboardAt = (nowMs: number): ReturnType<typeof getDashboard> =>
        getDashboard(
          db as unknown as SqliteDb,
          { exposeRates: false, exposePrivateNotes: false },
          nowMs
        )
      const before = dashboardAt(Date.now() - 1000)
      const mine = readTotals(db)
      const after = dashboardAt(Date.now() + 1000)
      expect(mine.today_seconds).toBeGreaterThanOrEqual(before.today_seconds)
      expect(mine.today_seconds).toBeLessThanOrEqual(after.today_seconds)
      expect(mine.week_seconds).toBeGreaterThanOrEqual(before.week_seconds)
      expect(mine.week_seconds).toBeLessThanOrEqual(after.week_seconds)
      // The bracket is two seconds wide plus the time between the reads: a
      // second definition that drifts by minutes still fails.
      expect(after.today_seconds - before.today_seconds).toBeLessThan(10)
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
    seedEntry(db, {
      client_id: 1,
      description: 'overnight',
      started_at: yesterdayEvening.toISOString(),
      stopped_at: null
    })

    const days = readWeekDaySeconds(db)
    const totals = readTotals(db)
    // A running entry is measured against 'now' inside SQLite, so the two
    // reads may be one second apart.
    expect(Math.abs(days[todayIndex('monday')] - totals.today_seconds)).toBeLessThanOrEqual(1)
    expect(Math.abs(days.reduce((a, b) => a + b, 0) - totals.week_seconds)).toBeLessThanOrEqual(1)
  })

  it('ignores deleted entries', () => {
    seedEntry(db, {
      client_id: 1,
      description: 'trash',
      started_at: iso(-7_200_000),
      stopped_at: iso(-3_600_000),
      deleted_at: iso(0)
    })
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
    seedEntry(db, {
      client_id: 1,
      description: 'overnight',
      started_at: yesterdayEvening.toISOString(),
      stopped_at: null
    })
    seedEntry(db, {
      client_id: 1,
      description: 'trash',
      started_at: iso(-7_200_000),
      stopped_at: iso(-3_600_000),
      deleted_at: iso(0)
    })

    const list = readTodayEntries(db)
    expect(list.map((e) => e.description).sort()).toEqual(['overnight', 'x'])
  })
})

/**
 * The rounded totals in get_summary follow the invoice rule — each entry
 * rounded up to the step, like Heute's "gerundet … h" sub-line and the PDF —
 * so there is one "rounded" number in the product, not two (owner review of
 * #242). Rounding the day total in one piece gives less.
 */
describe('readRoundedTotals', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    db.prepare(
      `INSERT INTO clients (id, name, color, active, rate_cent) VALUES (1,'Acme','#111',1,0)`
    ).run()
  })

  it('rounds each entry up to the step, not the sum', () => {
    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('pdf_round_minutes','15')`
    ).run()
    addClosed(db, daysAgoAt10(0).toISOString(), 10)
    addClosed(db, new Date(daysAgoAt10(0).getTime() + 3_600_000).toISOString(), 10)
    // Three 10-minute entries: 30 min raw. Per entry 3 × 15 = 45 min; the
    // total rounded in one piece would stay at 30.
    addClosed(db, new Date(daysAgoAt10(0).getTime() + 7_200_000).toISOString(), 10)
    const r = readRoundedTotals(db)
    expect(r.today_rounded_seconds).toBe(45 * 60)
    expect(r.week_rounded_seconds).toBe(45 * 60)
  })

  it('equals the raw totals when rounding is off', () => {
    addClosed(db, daysAgoAt10(0).toISOString(), 10)
    const r = readRoundedTotals(db)
    const t = readTotals(db)
    expect(r.today_rounded_seconds).toBe(t.today_seconds)
    expect(r.week_rounded_seconds).toBe(t.week_seconds)
  })
})

/**
 * The Schnellstart keys (HANDOFF §3.11, owner correction to B1): inactive
 * clients never take a slot, and a key's "last project" is one that can still
 * be started.
 */
describe('readTopClients30d', () => {
  let db: Database.Database

  function entry(client: number, project: number | null, daysAgo: number): void {
    const start = daysAgoAt10(daysAgo).toISOString()
    seedEntry(db, {
      client_id: client,
      project_id: project,
      description: 'x',
      started_at: start,
      stopped_at: new Date(Date.parse(start) + 3_600_000).toISOString()
    })
  }

  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    db.prepare(
      `INSERT INTO clients (id, name, color, active, rate_cent) VALUES
         (1,'Acme','#111',1,0), (2,'Archiv','#222',0,0)`
    ).run()
    db.prepare(
      `INSERT INTO projects (id, client_id, name, status, active) VALUES
         (10, 1, 'Alt', 'active', 1), (11, 1, 'Neu', 'active', 1)`
    ).run()
  })

  it('leaves inactive clients out', () => {
    entry(1, null, 1)
    entry(2, null, 1)
    entry(2, null, 2)
    expect(readTopClients30d(db).map((c) => c.client_id)).toEqual([1])
  })

  it('takes the project of the last entry while it is active', () => {
    entry(1, 10, 3)
    entry(1, 11, 1)
    expect(readTopClients30d(db)[0].last_project_id).toBe(11)
  })

  it('falls back to the most recently used ACTIVE project when the last one was archived', () => {
    entry(1, 10, 3)
    entry(1, 11, 1)
    db.prepare(`UPDATE projects SET status = 'archived', active = 0 WHERE id = 11`).run()
    expect(readTopClients30d(db)[0].last_project_id).toBe(10)
  })

  it('is null ("Kein Projekt") when no active project of the client was used', () => {
    entry(1, 11, 1)
    db.prepare(`UPDATE projects SET status = 'paused', active = 0 WHERE id = 11`).run()
    expect(readTopClients30d(db)[0].last_project_id).toBeNull()
  })

  it('stays null when the last entry had no project', () => {
    entry(1, 10, 3)
    entry(1, null, 1)
    expect(readTopClients30d(db)[0].last_project_id).toBeNull()
  })
})
