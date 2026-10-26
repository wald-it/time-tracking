/**
 * Deleting a client or a project with the 2.0 entry tables (owner decision
 * 2026-10-26): refused while any version points at it, deleted entries and
 * earlier versions included, with a clear message and nothing changed.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seed } from '../test/bridgeKit'
import { writeEntry } from './entryMutations'
import {
  CLIENT_HAS_ENTRIES_ERROR,
  PROJECT_HAS_ENTRIES_ERROR,
  deleteClientGuarded,
  deleteProjectGuarded
} from './masterDataDelete'

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

let db: Database.Database
beforeEach(() => {
  db = new DatabaseImpl(':memory:')
  seed(db)
  // What the app does for every client before P4 seeds rates on creation.
  db.prepare(
    `INSERT INTO rate (client_id, project_id, valid_from, rate_cent) VALUES (1, NULL, '0001-01-01', 0)`
  ).run()
  db.prepare(
    `INSERT INTO rate (client_id, project_id, valid_from, rate_cent) VALUES (2, NULL, '0001-01-01', 0)`
  ).run()
  db.prepare(
    `INSERT INTO rate (client_id, project_id, valid_from, rate_cent) VALUES (NULL, 10, '0001-01-01', 100)`
  ).run()
})

const count = (sql: string, ...args: unknown[]): number =>
  (db.prepare(sql).get(...args) as { n: number }).n

function entry(client_id: number, project_id: number | null, hour: number): number {
  const r = writeEntry(
    db,
    {
      op: 'create',
      fields: {
        client_id,
        project_id,
        description: 'x',
        started_at: new Date(2026, 5, 10, hour).toISOString(),
        stopped_at: new Date(2026, 5, 10, hour + 1).toISOString()
      }
    },
    { source: 'app' }
  )
  if (!r.ok) throw new Error(r.error)
  return r.data.id
}

describe('deleteClientGuarded', () => {
  it('deletes a client without entries, with its rate rows and projects', () => {
    expect(deleteClientGuarded(db, 1)).toEqual({ ok: true, data: undefined })
    expect(count(`SELECT COUNT(*) AS n FROM clients WHERE id = 1`)).toBe(0)
    expect(count(`SELECT COUNT(*) AS n FROM rate WHERE client_id = 1`)).toBe(0)
    expect(count(`SELECT COUNT(*) AS n FROM projects WHERE client_id = 1`)).toBe(0)
    expect(count(`SELECT COUNT(*) AS n FROM clients`)).toBe(1)
  })

  it('refuses a client with a live entry', () => {
    entry(1, 10, 9)
    expect(deleteClientGuarded(db, 1)).toEqual({ ok: false, error: CLIENT_HAS_ENTRIES_ERROR })
    expect(count(`SELECT COUNT(*) AS n FROM clients WHERE id = 1`)).toBe(1)
    expect(count(`SELECT COUNT(*) AS n FROM rate WHERE client_id = 1 OR project_id = 10`)).toBe(2)
  })

  it('refuses a client whose only entry is deleted', () => {
    const id = entry(1, null, 9)
    writeEntry(db, { op: 'delete', id }, { source: 'app' })
    expect(count(`SELECT COUNT(*) AS n FROM entries WHERE client_id = 1`)).toBe(0)
    expect(deleteClientGuarded(db, 1)).toEqual({ ok: false, error: CLIENT_HAS_ENTRIES_ERROR })
  })

  it('refuses a client that only an earlier version points at', () => {
    const id = entry(1, null, 9)
    const moved = writeEntry(db, { op: 'patch', id, patch: { client_id: 2 } }, { source: 'app' })
    expect(moved.ok).toBe(true)
    expect(count(`SELECT COUNT(*) AS n FROM entries WHERE client_id = 1`)).toBe(0)
    expect(deleteClientGuarded(db, 1)).toEqual({ ok: false, error: CLIENT_HAS_ENTRIES_ERROR })
    expect(deleteClientGuarded(db, 2)).toEqual({ ok: false, error: CLIENT_HAS_ENTRIES_ERROR })
  })
})

describe('deleteProjectGuarded', () => {
  it('deletes a project without entries, with its rate rows', () => {
    expect(deleteProjectGuarded(db, 10)).toEqual({ ok: true, data: undefined })
    expect(count(`SELECT COUNT(*) AS n FROM projects WHERE id = 10`)).toBe(0)
    expect(count(`SELECT COUNT(*) AS n FROM rate WHERE project_id = 10`)).toBe(0)
    expect(count(`SELECT COUNT(*) AS n FROM rate WHERE client_id = 1`)).toBe(1)
    expect(count(`SELECT COUNT(*) AS n FROM rate`)).toBe(2)
  })

  it('refuses a project with a live entry', () => {
    entry(1, 10, 9)
    expect(deleteProjectGuarded(db, 10)).toEqual({ ok: false, error: PROJECT_HAS_ENTRIES_ERROR })
    expect(count(`SELECT COUNT(*) AS n FROM projects WHERE id = 10`)).toBe(1)
  })

  it('refuses a project whose only entry is deleted (1.x allowed this)', () => {
    const id = entry(1, 10, 9)
    writeEntry(db, { op: 'delete', id }, { source: 'app' })
    expect(deleteProjectGuarded(db, 10)).toEqual({ ok: false, error: PROJECT_HAS_ENTRIES_ERROR })
  })

  it('refuses a project that only an earlier version points at', () => {
    const id = entry(1, 10, 9)
    expect(
      writeEntry(db, { op: 'patch', id, patch: { project_id: null } }, { source: 'app' }).ok
    ).toBe(true)
    expect(count(`SELECT COUNT(*) AS n FROM entries WHERE project_id = 10`)).toBe(0)
    expect(deleteProjectGuarded(db, 10)).toEqual({ ok: false, error: PROJECT_HAS_ENTRIES_ERROR })
  })
})
