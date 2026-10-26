/**
 * Owner decision 2026-10-26 (P4): a rate changed in the 1.x settings applies
 * from today. It adds a rate row with valid_from = today and never rewrites the
 * open-ended row, so months already worked out stay as they were (D7).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

function localToday(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

describe('a rate change in the 1.x columns applies from today', () => {
  let db: Database.Database
  const rows = (where: string): Array<{ rate_cent: number | null; valid_from: string }> =>
    db
      .prepare(`SELECT rate_cent, valid_from FROM rate WHERE ${where} ORDER BY valid_from`)
      .all() as Array<{ rate_cent: number | null; valid_from: string }>

  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    db.prepare(
      `INSERT INTO clients (id, name, color, rate_cent) VALUES (1, 'A', '#111', 9000)`
    ).run()
    db.prepare(
      `INSERT INTO projects (id, client_id, name, rate_cent) VALUES (10, 1, 'P', 7000)`
    ).run()
  })
  afterEach(() => db.close())

  it('client: the old row stays, a row from today is added', () => {
    db.prepare(`UPDATE clients SET rate_cent = 12000 WHERE id = 1`).run()
    expect(rows('client_id = 1')).toEqual([
      { rate_cent: 9000, valid_from: '0001-01-01' },
      { rate_cent: 12000, valid_from: localToday() }
    ])
  })

  it('a second change on the same day replaces the row of that day', () => {
    db.prepare(`UPDATE clients SET rate_cent = 12000 WHERE id = 1`).run()
    db.prepare(`UPDATE clients SET rate_cent = 13000 WHERE id = 1`).run()
    expect(rows('client_id = 1')).toEqual([
      { rate_cent: 9000, valid_from: '0001-01-01' },
      { rate_cent: 13000, valid_from: localToday() }
    ])
  })

  it('writing the same rate adds nothing', () => {
    db.prepare(`UPDATE clients SET rate_cent = 9000 WHERE id = 1`).run()
    expect(rows('client_id = 1')).toHaveLength(1)
  })

  it('project: a new rate adds a row from today', () => {
    db.prepare(`UPDATE projects SET rate_cent = 8000 WHERE id = 10`).run()
    expect(rows('project_id = 10')).toEqual([
      { rate_cent: 7000, valid_from: '0001-01-01' },
      { rate_cent: 8000, valid_from: localToday() }
    ])
  })

  it('project: removing the rate from today hands back to the client rate', () => {
    db.prepare(`UPDATE projects SET rate_cent = NULL WHERE id = 10`).run()
    expect(rows('project_id = 10')).toEqual([
      { rate_cent: 7000, valid_from: '0001-01-01' },
      { rate_cent: null, valid_from: localToday() }
    ])
  })

  it('project without any rate stays without a row when it is set to NULL again', () => {
    db.prepare(
      `INSERT INTO projects (id, client_id, name, rate_cent) VALUES (11, 1, 'Q', NULL)`
    ).run()
    db.prepare(`UPDATE projects SET rate_cent = NULL, name = 'Q2' WHERE id = 11`).run()
    expect(rows('project_id = 11')).toEqual([])
  })

  it('an entry before today keeps the old rate, one today gets the new one', () => {
    db.prepare(`UPDATE clients SET rate_cent = 12000 WHERE id = 1`).run()
    const today = localToday()
    const past = db
      .prepare(
        `SELECT (SELECT r.rate_cent FROM rate r WHERE r.client_id = 1 AND r.valid_from <= '2026-01-05'
                  ORDER BY r.valid_from DESC LIMIT 1) AS rate`
      )
      .get() as { rate: number }
    const now = db
      .prepare(
        `SELECT (SELECT r.rate_cent FROM rate r WHERE r.client_id = 1 AND r.valid_from <= ?
                  ORDER BY r.valid_from DESC LIMIT 1) AS rate`
      )
      .get(today) as { rate: number }
    expect(past.rate).toBe(9000)
    expect(now.rate).toBe(12000)
  })
})
