/**
 * Deleting and restoring an entry that crosses midnight (#323). Such an entry
 * is two rows sharing a `link_id`; deleting either half from Heute or the
 * calendar used to soft-delete only that half, so the other half kept
 * counting in totals, Auswertung, budget and exports. Undo must bring back
 * exactly what the delete removed.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { createManualEntry, deleteEntry, undeleteEntry } from './entryMutations'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

type Row = { id: number; link_id: string | null; deleted_at: string | null }

describe('deleteEntry / undeleteEntry (#323)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    db.prepare(
      `INSERT INTO clients (id, name, color, active, rate_cent) VALUES (1,'Acme','#111',1,0)`
    ).run()
  })

  /** A manual entry from local 23:00 to 01:00 the next day: two linked rows. */
  function createPair(): Row[] {
    const r = createManualEntry(db, {
      client_id: 1,
      description: 'Nacht',
      started_at: new Date(2026, 5, 10, 23, 0, 0).toISOString(),
      stopped_at: new Date(2026, 5, 11, 1, 0, 0).toISOString()
    })
    if (!r.ok) throw new Error(r.error.code)
    return rowsOf(r.data.link_id!)
  }

  function rowsOf(linkId: string): Row[] {
    return db
      .prepare(`SELECT id, link_id, deleted_at FROM entries WHERE link_id = ? ORDER BY id`)
      .all(linkId) as Row[]
  }

  function liveCount(): number {
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE deleted_at IS NULL`).get() as {
        n: number
      }
    ).n
  }

  it.each([
    ['first', 0],
    ['second', 1]
  ])('deleting the %s half deletes both halves', (_label, index) => {
    const pair = createPair()
    expect(deleteEntry(db, pair[index].id).ok).toBe(true)
    const after = rowsOf(pair[0].link_id!)
    expect(after.every((r) => r.deleted_at !== null)).toBe(true)
    expect(liveCount()).toBe(0)
  })

  it.each([
    ['first', 0],
    ['second', 1]
  ])('undo with the id of the %s half brings both halves back', (_label, index) => {
    const pair = createPair()
    expect(deleteEntry(db, pair[index].id).ok).toBe(true)
    const res = undeleteEntry(db, pair[index].id)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.id).toBe(pair[index].id)
    expect(rowsOf(pair[0].link_id!).every((r) => r.deleted_at === null)).toBe(true)
    expect(liveCount()).toBe(2)
  })

  it('undo restores only what this delete removed, not a half deleted earlier', () => {
    // A pair left half-deleted by 1.x (the UI deleted only the clicked half).
    const pair = createPair()
    db.prepare(`UPDATE entries SET deleted_at = '2026-06-12T08:00:00.000Z' WHERE id = ?`).run(
      pair[0].id
    )
    expect(deleteEntry(db, pair[1].id).ok).toBe(true)
    expect(liveCount()).toBe(0)
    // The earlier delete keeps its own timestamp.
    expect(rowsOf(pair[0].link_id!)[0].deleted_at).toBe('2026-06-12T08:00:00.000Z')

    expect(undeleteEntry(db, pair[1].id).ok).toBe(true)
    const after = rowsOf(pair[0].link_id!)
    expect(after[0].deleted_at).toBe('2026-06-12T08:00:00.000Z')
    expect(after[1].deleted_at).toBeNull()
  })

  it('a single-day entry is deleted and restored on its own', () => {
    const pair = createPair()
    const single = createManualEntry(db, {
      client_id: 1,
      description: 'Tag',
      started_at: '2026-06-12T09:00:00.000Z',
      stopped_at: '2026-06-12T10:00:00.000Z'
    })
    if (!single.ok) throw new Error(single.error.code)
    expect(deleteEntry(db, single.data.id).ok).toBe(true)
    expect(liveCount()).toBe(2) // the pair is untouched
    expect(undeleteEntry(db, single.data.id).ok).toBe(true)
    expect(liveCount()).toBe(3)
    expect(rowsOf(pair[0].link_id!).every((r) => r.deleted_at === null)).toBe(true)
  })

  it('refuses to delete a half that is already in the trash (a stale view), so undo cannot restore the wrong rows', () => {
    const pair = createPair()
    db.prepare(`UPDATE entries SET deleted_at = '2026-06-12T08:00:00.000Z' WHERE id = ?`).run(
      pair[0].id
    )
    const res = deleteEntry(db, pair[0].id)
    expect(res.ok).toBe(false)
    // Nothing changed: the live half stays live, the trashed half keeps its time.
    const after = rowsOf(pair[0].link_id!)
    expect(after[0].deleted_at).toBe('2026-06-12T08:00:00.000Z')
    expect(after[1].deleted_at).toBeNull()
  })

  it('refuses an unknown id', () => {
    expect(deleteEntry(db, 999).ok).toBe(false)
    expect(undeleteEntry(db, 999).ok).toBe(false)
  })
})
