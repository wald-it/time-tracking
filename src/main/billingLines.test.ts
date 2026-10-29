/**
 * Design 11.1: the one billing rule against hand-computed values (not derived
 * from the code). The JS rule, its SQL twin and the view `billing_lines` are
 * all checked against the same table.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import { billedMinutes, billedMinutesRule, billedMinutesRuleSql } from '../shared/currency'

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

const T0 = '2026-10-01T09:00:00.000Z'
const plus = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString()
const MIN = 60_000

// [raw ms, interval, min unit, expected billed minutes]
const RULE: Array<[string, number, number, number, number]> = [
  ['exactly 15:00 on a 15 grid', 15 * MIN, 15, 0, 15],
  ['15:00.001 starts a second step', 15 * MIN + 1, 15, 0, 30],
  ['14:59.999 is 15 whole minutes', 15 * MIN - 1, 15, 0, 15],
  ['one second, grid 15', 1000, 15, 0, 15],
  ['min unit above the interval lifts first', 4 * MIN, 15, 30, 30],
  ['min unit above the interval, long entry', 31 * MIN, 15, 30, 45],
  ['min unit below the interval changes nothing', 20 * MIN, 15, 10, 30],
  ['min unit 20, interval off', 5 * MIN, 0, 20, 20],
  ['min unit 20, interval off, above it', 25 * MIN, 0, 20, 25],
  ['interval off: whole minutes up', 61_001, 0, 0, 2],
  ['zero length stays zero, min unit or not', 0, 15, 30, 0]
]

describe('the rule, with values worked out by hand', () => {
  for (const [name, ms, interval, unit, expected] of RULE) {
    it(`JS: ${name}`, () => {
      expect(billedMinutes(ms, interval, unit)).toBe(expected)
    })
    it(`SQL twin: ${name}`, () => {
      const db = new DatabaseImpl(':memory:')
      const raw = ms > 0 ? Math.ceil(ms / MIN) : 0
      const row = db
        .prepare(
          `SELECT ${billedMinutesRuleSql('CAST(@raw AS INTEGER)', 'CAST(@interval AS INTEGER)', 'CAST(@unit AS INTEGER)')} AS m`
        )
        .get({ raw, interval, unit }) as { m: number }
      expect(row.m).toBe(expected)
      expect(billedMinutesRule(raw, interval, unit)).toBe(expected)
    })
  }
})

function seedDb(): Database.Database {
  const db = new DatabaseImpl(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  // Client 1 (rate 90 €/h): own profile, 15 min grid and 30 min minimum unit.
  db.prepare('INSERT INTO clients (id, name, rate_cent) VALUES (1, ?, 9000)').run('A')
  // Client 2 (rate 60 €/h): no profile of its own, follows the default (off).
  db.prepare('INSERT INTO clients (id, name, rate_cent) VALUES (2, ?, 6000)').run('B')
  // Project 1 of client 1 overrides only the interval (10), keeps min unit 30.
  db.prepare('INSERT INTO projects (id, client_id, name, rate_cent) VALUES (1, 1, ?, NULL)').run(
    'P'
  )
  db.prepare('DELETE FROM rate').run()
  db.prepare(
    "INSERT INTO rate (client_id, rate_cent, valid_from) VALUES (1, 9000, '0001-01-01')"
  ).run()
  db.prepare(
    "INSERT INTO rate (client_id, rate_cent, valid_from) VALUES (1, 12000, '2026-10-15')"
  ).run()
  db.prepare(
    "INSERT INTO rate (client_id, rate_cent, valid_from) VALUES (2, 6000, '0001-01-01')"
  ).run()
  db.prepare(
    'INSERT INTO billing_profile (client_id, interval_min, min_unit_min) VALUES (1, 15, 30)'
  ).run()
  db.prepare('INSERT INTO billing_profile (project_id, interval_min) VALUES (1, 10)').run()
  return db
}

interface Line {
  entry_id: number
  billed_minutes: number
  rate_cent: number | null
  fee_cent: number | null
}
const lines = (db: Database.Database): Map<number, Line> =>
  new Map(
    (
      db
        .prepare('SELECT entry_id, billed_minutes, rate_cent, fee_cent FROM billing_lines')
        .all() as Line[]
    ).map((l) => [l.entry_id, l])
  )

describe('billing_lines', () => {
  it('resolves profile field by field and the rate by segment date', () => {
    const db = seedDb()
    // 1: client 1, 4 min, 15 grid + 30 unit -> 30 min; rate 90 €/h -> 45 €.
    seedEntry(db, { id: 1, client_id: 1, started_at: T0, stopped_at: plus(4 * MIN) })
    // 2: project override interval 10, unit 30 inherited: 31 min -> 40 min; client rate 90 -> 60 €.
    seedEntry(db, {
      id: 2,
      client_id: 1,
      project_id: 1,
      started_at: T0,
      stopped_at: plus(31 * MIN)
    })
    // 3: after the rate change on 15 Oct: 30 min at 120 €/h -> 60 €.
    seedEntry(db, {
      id: 3,
      client_id: 1,
      started_at: '2026-10-20T09:00:00.000Z',
      stopped_at: '2026-10-20T09:30:00.000Z'
    })
    // 4: client 2 follows the default profile (off): 61 min 1 ms -> 62 min; 60 €/h -> 62 €.
    seedEntry(db, { id: 4, client_id: 2, started_at: T0, stopped_at: plus(61 * MIN + 1) })
    // 5: zero length with a minimum unit bills nothing.
    seedEntry(db, { id: 5, client_id: 1, started_at: T0, stopped_at: T0 })
    const l = lines(db)
    expect(l.get(1)).toMatchObject({ billed_minutes: 30, rate_cent: 9000, fee_cent: 4500 })
    expect(l.get(2)).toMatchObject({ billed_minutes: 40, rate_cent: 9000, fee_cent: 6000 })
    expect(l.get(3)).toMatchObject({ billed_minutes: 30, rate_cent: 12000, fee_cent: 6000 })
    expect(l.get(4)).toMatchObject({ billed_minutes: 62, rate_cent: 6000, fee_cent: 6200 })
    expect(l.get(5)).toMatchObject({ billed_minutes: 0, fee_cent: 0 })
  })

  it('a project rate NULL from a date inherits the client rate, an older project row does not apply', () => {
    const db = seedDb()
    db.prepare(
      "INSERT INTO rate (project_id, rate_cent, valid_from) VALUES (1, 3000, '0001-01-01')"
    ).run()
    db.prepare(
      "INSERT INTO rate (project_id, rate_cent, valid_from) VALUES (1, NULL, '2026-10-10')"
    ).run()
    seedEntry(db, {
      id: 1,
      client_id: 1,
      project_id: 1,
      started_at: T0,
      stopped_at: plus(30 * MIN)
    })
    seedEntry(db, {
      id: 2,
      client_id: 1,
      project_id: 1,
      started_at: '2026-10-12T09:00:00.000Z',
      stopped_at: '2026-10-12T09:30:00.000Z'
    })
    const l = lines(db)
    expect(l.get(1)?.rate_cent).toBe(3000)
    expect(l.get(2)?.rate_cent).toBe(9000)
  })

  it('a deliberate project rate of 0 bills 0 €', () => {
    const db = seedDb()
    db.prepare(
      "INSERT INTO rate (project_id, rate_cent, valid_from) VALUES (1, 0, '0001-01-01')"
    ).run()
    seedEntry(db, {
      id: 1,
      client_id: 1,
      project_id: 1,
      started_at: T0,
      stopped_at: plus(30 * MIN)
    })
    expect(lines(db).get(1)).toMatchObject({ rate_cent: 0, fee_cent: 0 })
  })

  it('a running segment is provisional: minutes up to now, no rate or fee', () => {
    const db = seedDb()
    const start = new Date(Date.now() - 7 * MIN).toISOString()
    seedEntry(db, { id: 1, client_id: 2, started_at: start, stopped_at: null })
    const l = lines(db).get(1)!
    expect(l.billed_minutes).toBeGreaterThanOrEqual(7)
    expect(l.billed_minutes).toBeLessThanOrEqual(8)
    expect(l.rate_cent).toBeNull()
    expect(l.fee_cent).toBeNull()
  })

  it('a deleted entry has no line', () => {
    const db = seedDb()
    seedEntry(db, {
      id: 1,
      client_id: 2,
      started_at: T0,
      stopped_at: plus(MIN),
      deleted_at: plus(2 * MIN)
    })
    expect(lines(db).size).toBe(0)
  })
})
