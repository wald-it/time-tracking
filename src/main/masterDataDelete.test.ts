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
  deleteProjectGuarded,
  hasEntryVersionsSql
} from './masterDataDelete'

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

let db: Database.Database
beforeEach(() => {
  db = new DatabaseImpl(':memory:')
  seed(db)
  // The P4 triggers seed a rate row per client; give project 10 its own.
  db.prepare(`UPDATE projects SET rate_cent = 100 WHERE id = 10`).run()
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

describe('hasEntryVersionsSql (#452): the lists flag exactly what the guard refuses', () => {
  it('agrees with both guards for deleted entries, earlier versions and untouched records', () => {
    const gone = entry(1, 10, 9)
    writeEntry(db, { op: 'delete', id: gone }, { source: 'app' })
    const moved = entry(1, 30, 11)
    writeEntry(db, { op: 'patch', id: moved, patch: { project_id: null } }, { source: 'app' })

    const flags = (table: 'clients' | 'projects'): Record<number, number> => {
      const column = table === 'clients' ? 'client_id' : 'project_id'
      const rows = db
        .prepare(`SELECT t.id, ${hasEntryVersionsSql(column, 't.id')} AS f FROM ${table} t`)
        .all() as Array<{ id: number; f: number }>
      return Object.fromEntries(rows.map((r) => [r.id, r.f]))
    }
    // The guard deletes on success; run it in a savepoint and roll back.
    const refused = (guard: () => { ok: boolean }): number => {
      db.exec('SAVEPOINT probe')
      try {
        return guard().ok ? 0 : 1
      } finally {
        db.exec('ROLLBACK TO probe; RELEASE probe')
      }
    }

    expect(flags('clients')).toEqual({ 1: 1, 2: 0 })
    expect(flags('projects')).toEqual({ 10: 1, 20: 0, 30: 1 })
    for (const id of [1, 2]) {
      expect(refused(() => deleteClientGuarded(db, id))).toBe(flags('clients')[id])
    }
    for (const id of [10, 20, 30]) {
      expect(refused(() => deleteProjectGuarded(db, id))).toBe(flags('projects')[id])
    }
  })
})
