/**
 * Deleting and restoring an entry that crosses midnight (#323). In 1.x such an
 * entry was two rows sharing a `link_id`, and deleting either half from Heute
 * or the calendar soft-deleted only that half, so the other half kept
 * counting in totals, Auswertung, budget and exports. Since 2.0 the halves
 * are two segments of one entry: a delete takes the entry, undo brings it
 * back whole. The day views still hand over the id of the segment they show,
 * which is the entry's id.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { createManualEntry, deleteEntry, undeleteEntry } from './entryMutations'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

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

  /** A manual entry from local 23:00 to 01:00 the next day: one entry, two segments. */
  function createPair(): number {
    const r = createManualEntry(db, {
      client_id: 1,
      description: 'Nacht',
      started_at: new Date(2026, 5, 10, 23, 0, 0).toISOString(),
      stopped_at: new Date(2026, 5, 11, 1, 0, 0).toISOString()
    })
    if (!r.ok) throw new Error(r.error)
    expect(segmentsShown(r.data.id)).toEqual([0, 1])
    return r.data.id
  }

  /** The `segment_seq` of every row the view shows for the entry. */
  function segmentsShown(id: number): number[] {
    return (
      db
        .prepare(`SELECT segment_seq FROM entries WHERE id = ? ORDER BY segment_seq`)
        .all(id) as Array<{ segment_seq: number }>
    ).map((r) => r.segment_seq)
  }

  function trashed(id: number): boolean {
    const row = db.prepare(`SELECT is_deleted FROM entry WHERE id = ?`).get(id) as {
      is_deleted: number
    }
    return row.is_deleted === 1
  }

  function liveCount(): number {
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE deleted_at IS NULL`).get() as {
        n: number
      }
    ).n
  }

  it('deleting the entry by the id its halves share takes both halves', () => {
    const id = createPair()
    expect(deleteEntry(db, id).ok).toBe(true)
    expect(trashed(id)).toBe(true)
    expect(segmentsShown(id)).toEqual([])
    expect(liveCount()).toBe(0)
  })

  it('undo with that id brings both halves back', () => {
    const id = createPair()
    expect(deleteEntry(db, id).ok).toBe(true)
    const res = undeleteEntry(db, id)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.id).toBe(id)
    expect(trashed(id)).toBe(false)
    expect(segmentsShown(id)).toEqual([0, 1])
    expect(liveCount()).toBe(2)
  })

  it('a single-day entry is deleted and restored on its own', () => {
    const pair = createPair()
    const single = createManualEntry(db, {
      client_id: 1,
      description: 'Tag',
      started_at: '2026-06-12T09:00:00.000Z',
      stopped_at: '2026-06-12T10:00:00.000Z'
    })
    if (!single.ok) throw new Error(single.error)
    expect(deleteEntry(db, single.data.id).ok).toBe(true)
    expect(liveCount()).toBe(2) // the pair is untouched
    expect(undeleteEntry(db, single.data.id).ok).toBe(true)
    expect(liveCount()).toBe(3)
    expect(segmentsShown(pair)).toEqual([0, 1])
  })

  it('refuses to delete an entry that is already in the trash (a stale view), nothing changes', () => {
    const id = createPair()
    expect(deleteEntry(db, id).ok).toBe(true)
    const version = (
      db.prepare(`SELECT current_version_id AS v FROM entry WHERE id = ?`).get(id) as {
        v: number
      }
    ).v
    const res = deleteEntry(db, id)
    expect(res.ok).toBe(false)
    // No second delete version was written.
    expect(db.prepare(`SELECT current_version_id AS v FROM entry WHERE id = ?`).get(id)).toEqual({
      v: version
    })
    expect(trashed(id)).toBe(true)
  })

  it('refuses an unknown id', () => {
    expect(deleteEntry(db, 999).ok).toBe(false)
    expect(undeleteEntry(db, 999).ok).toBe(false)
  })
})
