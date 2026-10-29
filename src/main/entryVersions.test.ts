import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import { listEntryVersions, readEntry, writeEntry } from './entryMutations'

let DatabaseImpl: DatabaseCtor
let db: Database.Database
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})
beforeEach(() => {
  db = new DatabaseImpl(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  db.prepare("INSERT INTO clients (id, name) VALUES (1, 'Acme')").run()
})
afterEach(() => db?.close())

describe('listEntryVersions', () => {
  it('reads all versions with metadata, deleted/restore states and both midnight segments, without writing', () => {
    const segments = [
      {
        started_at: new Date(2026, 8, 10, 23).toISOString(),
        stopped_at: new Date(2026, 8, 11).toISOString()
      },
      {
        started_at: new Date(2026, 8, 11).toISOString(),
        stopped_at: new Date(2026, 8, 11, 1).toISOString()
      }
    ]
    const id = seedEntry(db, {
      client_id: 1,
      segments,
      private_note: 'Internal',
      tags: ',test,',
      reference: 'REF'
    })
    const patched = writeEntry(
      db,
      { op: 'patch', id, patch: { description: 'Correction', billable: 0 } },
      { source: 'mcp', reason: 'Correct scope', now: '2026-09-12T10:00:00.000Z' }
    )
    expect(patched.ok).toBe(true)
    expect(
      writeEntry(db, { op: 'delete', id }, { source: 'app', now: '2026-09-12T11:00:00.000Z' }).ok
    ).toBe(true)
    expect(
      writeEntry(db, { op: 'undelete', id }, { source: 'app', now: '2026-09-12T12:00:00.000Z' }).ok
    ).toBe(true)
    const before = db.serialize()
    const history = listEntryVersions(db, id)
    expect(history.map((v) => [v.version_no, v.deleted])).toEqual([
      [1, false],
      [2, false],
      [3, true],
      [4, false]
    ])
    expect(history[1]).toMatchObject({
      state: 'sealed',
      written_at: '2026-09-12T10:00:00.000Z',
      source: 'mcp',
      reason: 'Correct scope',
      description: 'Correction',
      billable: 0,
      private_note: 'Internal',
      tags: ',test,',
      reference: 'REF'
    })
    for (const version of history) {
      expect(version.segments).toEqual(
        segments.map((s, seq) => ({
          ...s,
          seq,
          segment_date: `2026-09-${seq === 0 ? '10' : '11'}`
        }))
      )
    }
    expect(history[0].description).toBe('')
    // The renderer already receives the internal note through current-entry readers.
    expect(history[3].private_note).toBe(readEntry(db, id)?.private_note)
    expect(db.serialize()).toEqual(before)
  })

  it('returns only the requested entry, including an open version with a null stop', () => {
    const id = seedEntry(db, { client_id: 1, started_at: '2026-09-10T09:00:00.000Z' })
    seedEntry(db, {
      client_id: 1,
      started_at: '2026-09-11T09:00:00.000Z',
      stopped_at: '2026-09-11T10:00:00.000Z'
    })
    expect(listEntryVersions(db, id)).toMatchObject([
      { version_no: 1, state: 'open', stopped_at: null, segments: [{ seq: 0, stopped_at: null }] }
    ])
    expect(listEntryVersions(db, 99999)).toEqual([])
  })
})
