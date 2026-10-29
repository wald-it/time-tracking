/**
 * Every surface must report the amount the invoice bills. The PDF and the
 * calendar compute it in TypeScript (`billedMinutes`, `effectiveRateCent`,
 * `feeCent`); analytics and the MCP server sum it in SQLite through
 * `feeCentSql`. This runs both sides over the same entries — including the
 * cases where they used to differ: sub-second spans, a minute plus a few
 * milliseconds, half-cent fees, and a deliberate project rate of 0.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import { billedMinutes, effectiveRateCent, feeCent, feeCentSql } from '../shared/currency'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

interface Row {
  started_at: string
  stopped_at: string
  client_rate: number
  project_rate: number | null | undefined // undefined = no project
}

const T0 = '2026-10-01T09:00:00.000Z'
const plus = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString()

const ROWS: Row[] = [
  { started_at: T0, stopped_at: plus(400), client_rate: 9000, project_rate: undefined },
  { started_at: T0, stopped_at: plus(60_000), client_rate: 9000, project_rate: undefined },
  { started_at: T0, stopped_at: plus(60_001), client_rate: 9000, project_rate: undefined },
  { started_at: T0, stopped_at: plus(59 * 60_000 + 999), client_rate: 8550, project_rate: null },
  { started_at: T0, stopped_at: plus(7 * 60_000), client_rate: 9030, project_rate: undefined },
  { started_at: T0, stopped_at: plus(16 * 60_000 + 1), client_rate: 9000, project_rate: 12345 },
  { started_at: T0, stopped_at: plus(95 * 60_000), client_rate: 9000, project_rate: 0 },
  { started_at: T0, stopped_at: plus(3 * 3600_000 + 7), client_rate: 0, project_rate: 15000 },
  { started_at: T0, stopped_at: T0, client_rate: 9000, project_rate: undefined }
]

function seed(): Database.Database {
  const db = new DatabaseImpl(':memory:')
  // 2.0 P2: `entries` is a read-only view now, so this runs on the migrated
  // schema and seeds through the fixture instead of a hand-made table.
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  ROWS.forEach((r, i) => {
    const id = i + 1
    db.prepare('INSERT INTO clients (id, name, rate_cent) VALUES (?, ?, ?)').run(
      id,
      `Client ${id}`,
      r.client_rate
    )
    if (r.project_rate !== undefined) {
      db.prepare('INSERT INTO projects (id, client_id, name, rate_cent) VALUES (?, ?, ?, ?)').run(
        id,
        id,
        `Project ${id}`,
        r.project_rate
      )
    }
    seedEntry(db, {
      id,
      client_id: id,
      project_id: r.project_rate === undefined ? null : id,
      started_at: r.started_at,
      stopped_at: r.stopped_at
    })
  })
  return db
}

function tsFee(r: Row, step: number): number {
  const ms = Math.max(0, Date.parse(r.stopped_at) - Date.parse(r.started_at))
  return feeCent(billedMinutes(ms, step), effectiveRateCent(r.project_rate, r.client_rate))
}

describe('feeCentSql matches the TypeScript invoice rule', () => {
  for (const step of [0, 1, 6, 15, 30]) {
    it(`per entry, rounding step ${step}`, () => {
      const db = seed()
      const sqlFees = (
        db
          .prepare(
            `SELECT ${feeCentSql(step)} AS fee FROM entries e
             JOIN clients c ON c.id = e.client_id
             LEFT JOIN projects p ON p.id = e.project_id
             ORDER BY e.id`
          )
          .all() as { fee: number }[]
      ).map((r) => r.fee)
      expect(sqlFees).toEqual(ROWS.map((r) => tsFee(r, step)))
    })
  }

  it('bills a deliberate project rate of 0 at 0 €, not the client rate', () => {
    const db = seed()
    const row = db
      .prepare(
        `SELECT ${feeCentSql(0)} AS fee FROM entries e
         JOIN clients c ON c.id = e.client_id
         LEFT JOIN projects p ON p.id = e.project_id
         WHERE e.id = 7`
      )
      .get() as { fee: number }
    expect(row.fee).toBe(0)
  })
})
