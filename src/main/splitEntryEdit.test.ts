/**
 * #311: editing one half of an entry split at midnight must not delete the
 * other half.
 *
 * An entry across midnight is stored as two rows sharing a `link_id`. An edit
 * is saved by deleting the entry's rows and inserting them anew — and it used
 * to delete the WHOLE group while reinserting only the range it was given.
 * Both callers hand over the range of one half: MCP `update_entry_fields`
 * fills unchanged times from the row it was called on, and the calendar
 * drawer (EntryEditForm) sends the date and times of the half it opened. The
 * other half was hard-deleted.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { makeCtx, seed } from '../test/bridgeKit'
import { handleRequest } from './mcpBridgeCore'
import { createManualEntry, SPLIT_EDGE_ERROR, updateManualEntry } from './entryMutations'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

/** Local wall-clock time on June 2026 — splitAtMidnight cuts at local midnight. */
const local = (d: number, h: number, m = 0): string => new Date(2026, 5, d, h, m).toISOString()

interface Row {
  id: number
  description: string
  started_at: string
  stopped_at: string
  link_id: string | null
}

describe('editing one half of a split entry (#311)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
    // 20:00 on the 10th to 04:00 on the 11th: eight hours, two halves.
    const made = createManualEntry(db, {
      client_id: 1,
      description: 'Nachtschicht',
      started_at: local(10, 20),
      stopped_at: local(11, 4)
    })
    if (!made.ok) throw new Error(made.error)
  })

  const rows = (): Row[] =>
    db
      .prepare(
        `SELECT id, description, started_at, stopped_at, link_id FROM entries
          WHERE deleted_at IS NULL ORDER BY started_at`
      )
      .all() as Row[]
  const totalHours = (): number =>
    rows().reduce((s, r) => s + Date.parse(r.stopped_at) - Date.parse(r.started_at), 0) / 3_600_000

  it('the setup is a pair of eight hours', () => {
    expect(rows()).toHaveLength(2)
    expect(totalHours()).toBe(8)
  })

  for (const half of [0, 1] as const) {
    it(`MCP update_entry_fields on half ${half + 1} with only a description keeps both halves`, async () => {
      const { ctx } = makeCtx(db)
      const res = await handleRequest(ctx, {
        v: 1,
        token: 'secret',
        op: 'update_entry_fields',
        args: { id: rows()[half].id, description: 'Nachtschicht (Wartung)' }
      })
      expect(res.ok).toBe(true)
      expect(rows().map((r) => r.description)).toEqual([
        'Nachtschicht (Wartung)',
        'Nachtschicht (Wartung)'
      ])
      expect(totalHours()).toBe(8)
    })
  }

  it('the drawer saving the second half unchanged keeps the first', () => {
    // What EntryEditForm sends for the half from 00:00 to 04:00.
    const second = rows()[1]
    const res = updateManualEntry(db, {
      id: second.id,
      client_id: 1,
      description: 'Nachtschicht (Wartung)',
      started_at: second.started_at,
      stopped_at: second.stopped_at
    })
    expect(res.ok).toBe(true)
    expect(totalHours()).toBe(8)
    expect(rows().map((r) => r.started_at)).toEqual([local(10, 20), local(11, 0)])
  })

  it('the drawer moving the end of the second half moves the end of the entry', () => {
    const second = rows()[1]
    const res = updateManualEntry(db, {
      id: second.id,
      client_id: 1,
      description: 'Nachtschicht',
      started_at: second.started_at,
      stopped_at: local(11, 5)
    })
    expect(res.ok).toBe(true)
    expect(rows().map((r) => [r.started_at, r.stopped_at])).toEqual([
      [local(10, 20), local(11, 0)],
      [local(11, 0), local(11, 5)]
    ])
  })

  it('MCP moving the start on the first half moves the start of the entry', async () => {
    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      args: { id: rows()[0].id, started_at: local(10, 19) }
    })
    expect(res.ok).toBe(true)
    expect(rows().map((r) => [r.started_at, r.stopped_at])).toEqual([
      [local(10, 19), local(11, 0)],
      [local(11, 0), local(11, 4)]
    ])
  })

  it('a new range across midnight given for one half is refused, nothing changes', () => {
    // It would have to guess what happens to the other half (#311).
    const before = rows()
    expect(
      updateManualEntry(db, {
        id: before[1].id,
        client_id: 1,
        description: 'Nachtschicht',
        started_at: local(10, 23),
        stopped_at: local(11, 4)
      })
    ).toEqual({ ok: false, error: SPLIT_EDGE_ERROR })
    expect(rows()).toEqual(before)
  })

  it('moving the edge at midnight on one half is refused, nothing changes', async () => {
    const before = rows()
    const second = before[1]
    expect(
      updateManualEntry(db, {
        id: second.id,
        client_id: 1,
        description: 'Nachtschicht',
        started_at: local(11, 0, 30),
        stopped_at: second.stopped_at
      })
    ).toEqual({ ok: false, error: SPLIT_EDGE_ERROR })
    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      args: { id: before[0].id, stopped_at: local(10, 23) }
    })
    expect(res.ok).toBe(false)
    expect(rows()).toEqual(before)
  })

  it('a half in the trash stays there, restorable, when the other half is edited', () => {
    const [first, second] = rows()
    db.prepare(`UPDATE entries SET deleted_at = ? WHERE id = ?`).run(local(12, 9), first.id)
    const res = updateManualEntry(db, {
      id: second.id,
      client_id: 1,
      description: 'nur die zweite Hälfte',
      started_at: second.started_at,
      stopped_at: second.stopped_at
    })
    expect(res.ok).toBe(true)
    // The trashed row is untouched — same id, still in the trash.
    expect(
      db
        .prepare(`SELECT id, deleted_at IS NOT NULL AS trashed FROM entries WHERE id = ?`)
        .get(first.id)
    ).toEqual({ id: first.id, trashed: 1 })
    expect(rows().map((r) => [r.description, r.started_at, r.stopped_at])).toEqual([
      ['nur die zweite Hälfte', local(11, 0), local(11, 4)]
    ])
  })
  it('new start and end for one half that stay within its day are refused, nothing is lost', () => {
    const before = rows()
    expect(
      updateManualEntry(db, {
        id: before[1].id,
        client_id: 1,
        description: 'Nachtschicht',
        started_at: local(11, 0, 30),
        stopped_at: local(11, 5)
      })
    ).toEqual({ ok: false, error: SPLIT_EDGE_ERROR })
    expect(rows()).toEqual(before)
  })

  it('an unusable range on one half gets the usual validation message', () => {
    const second = rows()[1]
    expect(
      updateManualEntry(db, {
        id: second.id,
        client_id: 1,
        description: 'Nachtschicht',
        started_at: local(11, 3),
        stopped_at: local(11, 2)
      })
    ).toEqual({ ok: false, error: 'Endzeit muss nach der Startzeit liegen' })
  })

  it('the MCP preview shows the change to the whole entry', async () => {
    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      preview: true,
      args: { id: rows()[1].id, stopped_at: local(11, 5) }
    })
    expect(res.ok).toBe(true)
    const data = (res.ok ? res.data : {}) as {
      before: { started_at: string; stopped_at: string }
      after: { started_at: string; stopped_at: string }
      changes: Record<string, unknown>
    }
    expect([data.before.started_at, data.before.stopped_at]).toEqual([local(10, 20), local(11, 4)])
    expect([data.after.started_at, data.after.stopped_at]).toEqual([local(10, 20), local(11, 5)])
    expect(Object.keys(data.changes)).toEqual(['stopped_at'])
  })

  it('MCP refuses a move of the 0:00 edge before asking the owner', async () => {
    const { ctx, spies } = makeCtx(db)
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      args: { id: rows()[1].id, started_at: local(11, 1) }
    })
    expect(res).toMatchObject({ ok: false })
    expect(spies.confirmCalls).toBe(0)
    expect(totalHours()).toBe(8)
  })
  it('with the other half in the trash, the 0:00 edge of the live half still may not move', () => {
    const [first, second] = rows()
    db.prepare(`UPDATE entries SET deleted_at = ? WHERE id = ?`).run(local(12, 9), first.id)
    expect(
      updateManualEntry(db, {
        id: second.id,
        client_id: 1,
        description: 'Nachtschicht',
        started_at: local(11, 0, 30),
        stopped_at: second.stopped_at
      })
    ).toEqual({ ok: false, error: SPLIT_EDGE_ERROR })
    // Its outer edge may, and the trashed half's time does not come back.
    const res = updateManualEntry(db, {
      id: second.id,
      client_id: 1,
      description: 'Nachtschicht',
      started_at: second.started_at,
      stopped_at: local(11, 5)
    })
    expect(res.ok).toBe(true)
    expect(rows().map((r) => [r.started_at, r.stopped_at])).toEqual([[local(11, 0), local(11, 5)]])
  })

  it('an MCP edit whose entry changed while the owner was asked is refused, not applied', async () => {
    const { ctx } = makeCtx(db)
    const [first, second] = rows()
    // The first half goes to the trash while the dialog is open.
    ctx.confirm = async () => {
      db.prepare(`UPDATE entries SET deleted_at = ? WHERE id = ?`).run(local(12, 9), first.id)
      return true
    }
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      args: { id: second.id, stopped_at: local(11, 5) }
    })
    expect(res).toMatchObject({ ok: false })
    // The live half is as it was; nothing the owner did not see was written.
    expect(rows().map((r) => [r.started_at, r.stopped_at])).toEqual([[local(11, 0), local(11, 4)]])
  })
})
