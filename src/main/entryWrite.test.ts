/**
 * The one write path of the 2.0 entry lifecycle (design doc section 5),
 * P2 acceptance tests 11.3 (write path properties), 11.7 (per-operation
 * validation), the #335 cases of 11.4, and the triggers of section 4.2 / D5.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seed } from '../test/bridgeKit'
import { seedEntry } from '../test/entryFixtures'
import { ENTRIES_VIEW_READ_ONLY } from './entryLifecycle/schemaV2'
import {
  ANCHOR_REUSED_ERROR,
  OVERLAP_ERROR,
  STALE_EDIT_ERROR,
  createManualEntry,
  readEntry,
  updateManualEntry,
  writeEntry,
  type EntryView,
  type WriteOp
} from './entryMutations'
import { handleRequest } from './mcpBridgeCore'
import { makeCtx } from '../test/bridgeKit'

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

/** Local wall-clock time in June 2026 — splitAtMidnight cuts at local midnight. */
const local = (d: number, h: number, m = 0, s = 0): string =>
  new Date(2026, 5, d, h, m, s).toISOString()

const app = { source: 'app' as const }

function must<T>(r: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error)
  return r.data
}

let db: Database.Database
beforeEach(() => {
  db = new DatabaseImpl(':memory:')
  seed(db)
})

/** The generated set of 11.3: single, pair, imported, running. */
function generatedSet(): Record<'single' | 'pair' | 'imported' | 'running', EntryView> {
  const single = must(
    writeEntry(
      db,
      {
        op: 'create',
        fields: {
          client_id: 1,
          project_id: 10,
          description: 'Single',
          started_at: local(10, 9),
          stopped_at: local(10, 10),
          tags: ',a,b,',
          reference: 'REF-1',
          billable: 0,
          private_note: 'note'
        }
      },
      app
    )
  )
  const pair = must(
    writeEntry(
      db,
      {
        op: 'create',
        fields: {
          client_id: 1,
          description: 'Pair',
          started_at: local(10, 22),
          stopped_at: local(11, 2),
          tags: ',night,'
        }
      },
      app
    )
  )
  const imported = must(
    writeEntry(
      db,
      {
        op: 'create',
        fields: {
          client_id: 2,
          project_id: 20,
          description: 'Meeting',
          started_at: local(12, 14),
          stopped_at: local(12, 15)
        },
        graph_event_id: 'evt-1'
      },
      { source: 'import' }
    )
  )
  const running = must(
    writeEntry(
      db,
      {
        op: 'start',
        fields: { client_id: 2, description: 'Now', started_at: local(13, 8), project_id: 20 }
      },
      app
    )
  )
  return { single, pair, imported, running }
}

const CONTENT = [
  'client_id',
  'project_id',
  'description',
  'started_at',
  'stopped_at',
  'tags',
  'reference',
  'billable',
  'private_note'
] as const

describe('11.3 write path properties', () => {
  /** Every patch is valid by construction: the moved range gets its own day per entry. */
  const patchesFor = (day: number): Array<Record<string, unknown>> => [
    { description: 'changed' },
    { tags: ',x,' },
    { reference: 'R-2' },
    { billable: 0 },
    { private_note: 'n2' },
    { project_id: null },
    { client_id: 2, project_id: 20 },
    { started_at: local(day, 9), stopped_at: local(day, 10) }
  ]

  it('patch: every field not in the patch is identical; id, created_at, graph_event_id never change', () => {
    const set = generatedSet()
    for (const [i, key] of (['single', 'pair', 'imported'] as const).entries()) {
      for (const patch of patchesFor(1 + i)) {
        const before = readEntry(db, set[key].id)!
        const res = writeEntry(db, { op: 'patch', id: before.id, patch }, app)
        const after = must(res)
        expect(after.id).toBe(before.id)
        expect(after.created_at).toBe(before.created_at)
        expect(after.graph_event_id).toBe(before.graph_event_id)
        expect(after.created_source).toBe(before.created_source)
        // A patch that changes nothing writes no version.
        const changes = Object.entries(patch).some(([k, v]) => before[k as keyof EntryView] !== v)
        expect(after.version_no).toBe(before.version_no + (changes ? 1 : 0))
        for (const f of CONTENT) {
          if (!(f in patch)) expect(after[f]).toBe(before[f])
        }
        // Row-level: the old version is untouched.
        const old = db
          .prepare(`SELECT * FROM entry_version WHERE id = ?`)
          .get(before.version_id) as Record<string, unknown>
        for (const f of CONTENT) expect(old[f]).toBe(before[f])
      }
    }
  })

  it('amend: the open version keeps every field not in the patch, in place', () => {
    const { running } = generatedSet()
    for (const patch of [
      { description: 'x' },
      { tags: ',t,' },
      { billable: 0 },
      { reference: 'r' }
    ]) {
      const before = readEntry(db, running.id)!
      const after = must(writeEntry(db, { op: 'amend', id: before.id, patch }, app))
      expect(after.version_id).toBe(before.version_id)
      expect(after.version_no).toBe(before.version_no)
      expect(after.state).toBe('open')
      expect(after.heartbeat_at).toBe(before.heartbeat_at)
      for (const f of CONTENT) if (!(f in patch)) expect(after[f]).toBe(before[f])
    }
  })

  it('seal: the content is untouched, only stopped_at and the segments are set', () => {
    const { running } = generatedSet()
    const before = readEntry(db, running.id)!
    const after = must(writeEntry(db, { op: 'seal', id: before.id, stopped_at: local(13, 9) }, app))
    expect(after.version_id).toBe(before.version_id)
    expect(after.state).toBe('sealed')
    expect(after.stopped_at).toBe(local(13, 9))
    expect(after.heartbeat_at).toBeNull()
    for (const f of CONTENT) if (f !== 'stopped_at') expect(after[f]).toBe(before[f])
  })

  it('delete and undelete carry the content unchanged across both versions', () => {
    const set = generatedSet()
    for (const key of ['single', 'pair', 'imported', 'running'] as const) {
      const before = readEntry(db, set[key].id)!
      const gone = must(writeEntry(db, { op: 'delete', id: before.id }, app))
      expect(gone.deleted).toBe(true)
      expect(gone.id).toBe(before.id)
      expect(gone.created_at).toBe(before.created_at)
      expect(gone.graph_event_id).toBe(before.graph_event_id)
      for (const f of CONTENT) {
        if (f === 'stopped_at' && before.state === 'open') continue
        expect(gone[f]).toBe(before[f])
      }
      // A running entry in the trash is sealed where it stood, never open.
      if (before.state === 'open') expect(gone.stopped_at).not.toBeNull()
      const back = must(writeEntry(db, { op: 'undelete', id: before.id }, app))
      expect(back.deleted).toBe(false)
      expect(back.version_no).toBe(before.version_no + 2)
      for (const f of CONTENT) expect(back[f]).toBe(gone[f])
      expect(back.segments.map((s) => [s.started_at, s.stopped_at])).toEqual(
        gone.segments.map((s) => [s.started_at, s.stopped_at])
      )
    }
  })

  it('a no-op patch writes no version', () => {
    const { single } = generatedSet()
    const again = must(
      writeEntry(db, { op: 'patch', id: single.id, patch: { description: 'Single' } }, app)
    )
    expect(again.version_no).toBe(single.version_no)
  })

  it('a patch of a split entry keeps both segments when the times do not change', () => {
    const { pair } = generatedSet()
    expect(pair.segments).toHaveLength(2)
    const after = must(writeEntry(db, { op: 'patch', id: pair.id, patch: { tags: ',x,' } }, app))
    expect(after.segments.map((s) => [s.started_at, s.stopped_at])).toEqual([
      [local(10, 22), local(11, 0)],
      [local(11, 0), local(11, 2)]
    ])
  })

  it('expected_version refuses a write against a version the caller did not see', () => {
    const { single } = generatedSet()
    must(writeEntry(db, { op: 'patch', id: single.id, patch: { tags: ',x,' } }, app))
    for (const op of [
      { op: 'patch', id: single.id, patch: { tags: ',y,' }, expected_version: single.version_no },
      { op: 'delete', id: single.id, expected_version: single.version_no }
    ] as WriteOp[]) {
      expect(writeEntry(db, op, app)).toEqual({ ok: false, error: STALE_EDIT_ERROR })
    }
  })
})

describe('11.7 per-operation validation', () => {
  it('sealing a timer that ran more than 24 hours succeeds', () => {
    const r = must(
      writeEntry(
        db,
        { op: 'start', fields: { client_id: 1, description: 'long', started_at: local(10, 8) } },
        app
      )
    )
    const sealed = must(writeEntry(db, { op: 'seal', id: r.id, stopped_at: local(11, 20) }, app))
    expect(sealed.state).toBe('sealed')
    expect(sealed.segments).toHaveLength(2)
    expect(Date.parse(sealed.stopped_at!) - Date.parse(sealed.started_at)).toBe(36 * 3_600_000)
  })

  it('a zero-length crash recovery succeeds with one segment', () => {
    const r = must(
      writeEntry(
        db,
        { op: 'start', fields: { client_id: 1, description: 'crash', started_at: local(10, 8) } },
        app
      )
    )
    const sealed = must(
      writeEntry(db, { op: 'seal', id: r.id, stopped_at: local(10, 8) }, { source: 'recovery' })
    )
    expect(sealed.stopped_at).toBe(sealed.started_at)
    expect(sealed.segments).toHaveLength(1)
    expect(sealed.source).toBe('recovery')
  })

  it('a switch never fails because of the seal: the running entry of 30 hours ends at the new start', () => {
    must(
      writeEntry(
        db,
        { op: 'start', fields: { client_id: 1, description: 'long', started_at: local(10, 8) } },
        app
      )
    )
    const r = must(
      writeEntry(
        db,
        { op: 'start', fields: { client_id: 2, description: 'next', started_at: local(11, 14) } },
        app
      )
    )
    expect(r.stopped?.stopped_at).toBe(local(11, 14))
    expect(r.stopped?.state).toBe('sealed')
    expect(r.started_at).toBe(local(11, 14))
  })

  it('a create over 24 hours is refused as today', () => {
    expect(
      writeEntry(
        db,
        {
          op: 'create',
          fields: {
            client_id: 1,
            description: 'x',
            started_at: local(10, 8),
            stopped_at: local(11, 9)
          }
        },
        app
      )
    ).toEqual({ ok: false, error: 'Dauer überschreitet 24 Stunden' })
  })

  it('a patch that stretches an entry over 24 hours is refused', () => {
    const { single } = generatedSet()
    expect(
      writeEntry(db, { op: 'patch', id: single.id, patch: { stopped_at: local(11, 10) } }, app)
    ).toEqual({ ok: false, error: 'Dauer überschreitet 24 Stunden' })
  })

  it('moving an entry to another client is refused when that client has an overlapping entry', () => {
    const { single } = generatedSet()
    must(
      writeEntry(
        db,
        {
          op: 'create',
          fields: {
            client_id: 2,
            description: 'Beta busy',
            started_at: local(10, 9, 30),
            stopped_at: local(10, 11)
          }
        },
        app
      )
    )
    expect(
      writeEntry(db, { op: 'patch', id: single.id, patch: { client_id: 2, project_id: null } }, app)
    ).toEqual({ ok: false, error: OVERLAP_ERROR })
    expect(readEntry(db, single.id)!.client_id).toBe(1)
  })

  it('a description edit on a migrated row that crosses midnight unsplit keeps one segment', () => {
    // What the migration writes for a 1.x timer row over midnight (section 10).
    const id = seedEntry(db, {
      client_id: 1,
      description: 'Nachtschicht',
      started_at: local(10, 23),
      stopped_at: local(11, 1),
      source: 'migration',
      created_source: 'migration'
    })
    const after = must(
      writeEntry(db, { op: 'patch', id, patch: { description: 'Nachtschicht (alt)' } }, app)
    )
    expect(after.segments).toEqual([
      { seq: 0, segment_date: '2026-06-10', started_at: local(10, 23), stopped_at: local(11, 1) }
    ])
  })

  it('a start before the running entry began is refused; one in the future too', () => {
    must(
      writeEntry(
        db,
        { op: 'start', fields: { client_id: 1, description: 'a', started_at: local(10, 8) } },
        app
      )
    )
    expect(
      writeEntry(
        db,
        { op: 'start', fields: { client_id: 1, description: 'b', started_at: local(10, 7) } },
        app
      )
    ).toEqual({ ok: false, error: 'Startzeit liegt vor dem Beginn des laufenden Eintrags' })
    const future = new Date(Date.now() + 10 * 60_000).toISOString()
    expect(
      writeEntry(
        db,
        { op: 'start', fields: { client_id: 1, description: 'c', started_at: future } },
        app
      )
    ).toEqual({ ok: false, error: 'Startzeit liegt in der Zukunft' })
  })

  it('seal refuses a stop before the start, amend refuses a sealed entry, patch a running one', () => {
    const { single, running } = generatedSet()
    expect(writeEntry(db, { op: 'seal', id: running.id, stopped_at: local(13, 7) }, app)).toEqual({
      ok: false,
      error: 'Endzeit liegt vor der Startzeit'
    })
    expect(
      writeEntry(db, { op: 'amend', id: single.id, patch: { description: 'x' } }, app).ok
    ).toBe(false)
    expect(
      writeEntry(db, { op: 'patch', id: running.id, patch: { description: 'x' } }, app).ok
    ).toBe(false)
  })
})

describe('#335 cases (11.4)', () => {
  it('an edit of a deleted entry is refused', () => {
    const { single } = generatedSet()
    must(writeEntry(db, { op: 'delete', id: single.id }, app))
    expect(updateManualEntry(db, { id: single.id, description: 'ghost' })).toEqual({
      ok: false,
      error: 'Eintrag existiert nicht'
    })
    expect(
      writeEntry(db, { op: 'patch', id: single.id, patch: { description: 'ghost' } }, app)
    ).toEqual({ ok: false, error: 'Eintrag existiert nicht' })
    expect(readEntry(db, single.id)!.version_no).toBe(2)
  })

  it('over MCP: an entry deleted between preview and confirmation is not edited', async () => {
    const { single } = generatedSet()
    const { ctx } = makeCtx(db)
    ctx.confirm = async () => {
      must(writeEntry(db, { op: 'delete', id: single.id }, app))
      return true
    }
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      args: { id: single.id, description: 'late' }
    })
    expect(res).toMatchObject({ ok: false })
    const now = readEntry(db, single.id)!
    expect(now.deleted).toBe(true)
    expect(now.description).toBe('Single')
    expect(now.version_no).toBe(2)
  })

  it('over MCP: an entry edited between preview and confirmation is refused as stale', async () => {
    const { single } = generatedSet()
    const { ctx } = makeCtx(db)
    ctx.confirm = async () => {
      must(writeEntry(db, { op: 'patch', id: single.id, patch: { tags: ',meanwhile,' } }, app))
      return true
    }
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      args: { id: single.id, description: 'late' }
    })
    expect(res).toMatchObject({ ok: false, error: STALE_EDIT_ERROR })
    expect(readEntry(db, single.id)!.description).toBe('Single')
  })

  it('an undelete that would overlap is refused', () => {
    const { single } = generatedSet()
    must(writeEntry(db, { op: 'delete', id: single.id }, app))
    must(
      writeEntry(
        db,
        {
          op: 'create',
          fields: {
            client_id: 1,
            description: 'took the slot',
            started_at: local(10, 9, 30),
            stopped_at: local(10, 9, 45)
          }
        },
        app
      )
    )
    expect(writeEntry(db, { op: 'undelete', id: single.id }, app)).toEqual({
      ok: false,
      error: OVERLAP_ERROR
    })
    expect(readEntry(db, single.id)!.deleted).toBe(true)
  })

  it('an undelete whose calendar anchor was imported again is refused', () => {
    const { imported } = generatedSet()
    must(writeEntry(db, { op: 'delete', id: imported.id }, app))
    must(
      writeEntry(
        db,
        {
          op: 'create',
          fields: {
            // Another client: the anchor belongs to the event, not the client.
            client_id: 1,
            description: 'Meeting again',
            started_at: local(20, 14),
            stopped_at: local(20, 15)
          },
          graph_event_id: 'evt-1'
        },
        { source: 'import' }
      )
    )
    expect(writeEntry(db, { op: 'undelete', id: imported.id }, app)).toEqual({
      ok: false,
      error: ANCHOR_REUSED_ERROR
    })
  })

  it('an edit of the second half returns the entry with both segments', () => {
    const { pair } = generatedSet()
    const second = db
      .prepare(
        `SELECT id, segment_seq, started_at, stopped_at FROM entries WHERE id = ? AND segment_seq = 1`
      )
      .get(pair.id) as { id: number; segment_seq: number; started_at: string; stopped_at: string }
    const res = must(
      updateManualEntry(db, {
        id: second.id,
        segment_seq: second.segment_seq,
        description: 'Pair (edited)',
        started_at: second.started_at,
        stopped_at: second.stopped_at
      })
    )
    expect(readEntry(db, res.id)!.segments).toHaveLength(2)
    expect([res.started_at, res.stopped_at]).toEqual([local(10, 22), local(11, 2)])
    expect(res.description).toBe('Pair (edited)')
  })

  it('a description-only save from the edit form keeps the seconds of the end', () => {
    const made = must(
      createManualEntry(db, {
        client_id: 1,
        description: 'Precise',
        started_at: local(15, 9, 0, 17),
        stopped_at: local(15, 10, 0, 42)
      })
    )
    // The form shows 09:00 and 10:00 and sends them back with the new text.
    const res = must(
      updateManualEntry(db, {
        id: made.id,
        client_id: 1,
        description: 'Precise (edited)',
        started_at: local(15, 9),
        stopped_at: local(15, 10),
        from_form: true,
        segment_seq: 0
      })
    )
    expect(res.started_at).toBe(local(15, 9, 0, 17))
    expect(res.stopped_at).toBe(local(15, 10, 0, 42))
    expect(res.description).toBe('Precise (edited)')
    // Without the flag (MCP sends exact instants) the minute is a change.
    const moved = must(
      updateManualEntry(db, { id: made.id, started_at: local(15, 9), stopped_at: local(15, 10) })
    )
    expect(moved.started_at).toBe(local(15, 9))
  })
})

describe('the view and the triggers (D5, 4.2)', () => {
  it('writing to the entries view throws', () => {
    const { single } = generatedSet()
    expect(() =>
      db.prepare(`UPDATE entries SET description = 'x' WHERE id = ?`).run(single.id)
    ).toThrow(ENTRIES_VIEW_READ_ONLY)
    expect(() => db.prepare(`DELETE FROM entries WHERE id = ?`).run(single.id)).toThrow(
      ENTRIES_VIEW_READ_ONLY
    )
    expect(() =>
      db
        .prepare(
          `INSERT INTO entries (client_id, description, started_at, stopped_at) VALUES (1, 'x', ?, ?)`
        )
        .run(local(1, 1), local(1, 2))
    ).toThrow(ENTRIES_VIEW_READ_ONLY)
  })

  it('a sealed version and its segments are immutable; versions and entries are never deleted', () => {
    const { single } = generatedSet()
    expect(() =>
      db.prepare(`UPDATE entry_version SET description = 'x' WHERE id = ?`).run(single.version_id)
    ).toThrow(/sealed version is immutable/)
    expect(() =>
      db.prepare(`DELETE FROM entry_version WHERE id = ?`).run(single.version_id)
    ).toThrow(/append-only/)
    expect(() =>
      db
        .prepare(`UPDATE entry_segment SET stopped_at = ? WHERE version_id = ?`)
        .run(local(10, 11), single.version_id)
    ).toThrow(/sealed/)
    expect(() =>
      db.prepare(`DELETE FROM entry_segment WHERE version_id = ?`).run(single.version_id)
    ).toThrow(/sealed/)
    expect(() => db.prepare(`DELETE FROM entry WHERE id = ?`).run(single.id)).toThrow(
      /never hard-deleted/
    )
  })

  it('id, created_at, created_source and graph_event_id of an entry are fixed', () => {
    const { imported } = generatedSet()
    for (const sql of [
      `UPDATE entry SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`,
      `UPDATE entry SET graph_event_id = NULL WHERE id = ?`,
      `UPDATE entry SET created_source = 'app' WHERE id = ?`,
      `UPDATE entry SET id = 99999 WHERE id = ?`
    ]) {
      expect(() => db.prepare(sql).run(imported.id)).toThrow(/never change/)
    }
  })

  it('entries_v1 is read-only after the switch', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO entries_v1 (client_id, description, started_at, stopped_at) VALUES (1, 'x', ?, ?)`
        )
        .run(local(1, 1), local(1, 2))
    ).toThrow(/read-only/)
  })

  it('the view shows one row per segment with the entry id, and heartbeat_at only while running', () => {
    const { pair, running } = generatedSet()
    const rows = db
      .prepare(
        `SELECT id, segment_seq, started_at, stopped_at, heartbeat_at, link_id, deleted_at, rounded_min
           FROM entries WHERE id = ? ORDER BY segment_seq`
      )
      .all(pair.id) as Array<Record<string, unknown>>
    expect(rows).toEqual([
      {
        id: pair.id,
        segment_seq: 0,
        started_at: local(10, 22),
        stopped_at: local(11, 0),
        heartbeat_at: local(11, 0),
        link_id: null,
        deleted_at: null,
        rounded_min: null
      },
      {
        id: pair.id,
        segment_seq: 1,
        started_at: local(11, 0),
        stopped_at: local(11, 2),
        heartbeat_at: local(11, 2),
        link_id: null,
        deleted_at: null,
        rounded_min: null
      }
    ])
    const run = db
      .prepare(`SELECT stopped_at, heartbeat_at FROM entries WHERE id = ?`)
      .get(running.id)
    expect(run).toEqual({ stopped_at: null, heartbeat_at: local(13, 8) })
    must(writeEntry(db, { op: 'delete', id: pair.id }, app))
    expect(db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE id = ?`).get(pair.id)).toEqual({
      n: 0
    })
  })
})
