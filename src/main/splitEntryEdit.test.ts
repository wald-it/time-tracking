/**
 * #311: editing one half of an entry split at midnight must not lose the
 * other half.
 *
 * Since 2.0 an entry across midnight is one entry with two segments; the view
 * `entries` shows one row per segment, both with the entry's id and their
 * `segment_seq`. The calendar drawer (EntryEditForm) opens one segment and
 * sends that segment's times with its `segment_seq`; the write maps them onto
 * the whole entry: the edge at 0:00 may not move, the outer edges may. MCP
 * `update_entry_fields` fills unchanged times from the entry's whole range
 * and sends no segment, so its times apply to the entry as given.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { makeCtx, seed } from '../test/bridgeKit'
import { handleRequest } from './mcpBridgeCore'
import {
  createManualEntry,
  deleteEntry,
  SPLIT_EDGE_ERROR,
  STALE_EDIT_ERROR,
  updateManualEntry
} from './entryMutations'
import type { UpdateEntryInput } from '../shared/types'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

/** Local wall-clock time on June 2026 — segments are cut at local midnight. */
const local = (d: number, h: number, m = 0): string => new Date(2026, 5, d, h, m).toISOString()

interface Row {
  id: number
  segment_seq: number
  version_no: number
  description: string
  started_at: string
  stopped_at: string
}

describe('editing one half of a split entry (#311)', () => {
  let db: Database.Database
  let id: number

  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
    // 20:00 on the 10th to 04:00 on the 11th: eight hours, two segments.
    const made = createManualEntry(db, {
      client_id: 1,
      description: 'Nachtschicht',
      started_at: local(10, 20),
      stopped_at: local(11, 4)
    })
    if (!made.ok) throw new Error(made.error)
    id = made.data.id
  })

  const rows = (): Row[] =>
    db
      .prepare(
        `SELECT id, segment_seq, version_no, description, started_at, stopped_at FROM entries
          WHERE deleted_at IS NULL ORDER BY started_at`
      )
      .all() as Row[]
  const totalHours = (): number =>
    rows().reduce((s, r) => s + Date.parse(r.stopped_at) - Date.parse(r.started_at), 0) / 3_600_000

  /** What EntryEditForm sends for the segment it opened. */
  const fromDrawer = (half: Row, changes: Partial<UpdateEntryInput>): UpdateEntryInput => ({
    id: half.id,
    client_id: 1,
    description: half.description,
    started_at: half.started_at,
    stopped_at: half.stopped_at,
    from_form: true,
    segment_seq: half.segment_seq,
    expected_version: half.version_no,
    ...changes
  })

  it('the setup is one entry with two segments of eight hours', () => {
    expect(rows().map((r) => [r.id, r.segment_seq])).toEqual([
      [id, 0],
      [id, 1]
    ])
    expect(totalHours()).toBe(8)
  })

  it('MCP update_entry_fields with only a description keeps both segments', async () => {
    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      args: { id, description: 'Nachtschicht (Wartung)' }
    })
    expect(res.ok).toBe(true)
    expect(rows().map((r) => r.description)).toEqual([
      'Nachtschicht (Wartung)',
      'Nachtschicht (Wartung)'
    ])
    expect(totalHours()).toBe(8)
  })

  it('the drawer saving the second half unchanged keeps the first', () => {
    const second = rows()[1]
    const res = updateManualEntry(db, fromDrawer(second, { description: 'Nachtschicht (Wartung)' }))
    expect(res.ok).toBe(true)
    expect(totalHours()).toBe(8)
    expect(rows().map((r) => r.started_at)).toEqual([local(10, 20), local(11, 0)])
  })

  it('the drawer moving the end of the second half moves the end of the entry', () => {
    const second = rows()[1]
    const res = updateManualEntry(db, fromDrawer(second, { stopped_at: local(11, 5) }))
    expect(res.ok).toBe(true)
    expect(rows().map((r) => [r.started_at, r.stopped_at])).toEqual([
      [local(10, 20), local(11, 0)],
      [local(11, 0), local(11, 5)]
    ])
  })

  it('the drawer moving the start of the first half moves the start of the entry', () => {
    const first = rows()[0]
    const res = updateManualEntry(db, fromDrawer(first, { started_at: local(10, 19) }))
    expect(res.ok).toBe(true)
    expect(rows().map((r) => [r.started_at, r.stopped_at])).toEqual([
      [local(10, 19), local(11, 0)],
      [local(11, 0), local(11, 4)]
    ])
  })

  it('MCP moving the start moves the start of the entry', async () => {
    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      args: { id, started_at: local(10, 19) }
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
    expect(updateManualEntry(db, fromDrawer(before[1], { started_at: local(10, 23) }))).toEqual({
      ok: false,
      error: SPLIT_EDGE_ERROR
    })
    expect(rows()).toEqual(before)
  })

  it('moving the edge at midnight on one half is refused, nothing changes', () => {
    const before = rows()
    expect(updateManualEntry(db, fromDrawer(before[1], { started_at: local(11, 0, 30) }))).toEqual({
      ok: false,
      error: SPLIT_EDGE_ERROR
    })
    expect(updateManualEntry(db, fromDrawer(before[0], { stopped_at: local(10, 23) }))).toEqual({
      ok: false,
      error: SPLIT_EDGE_ERROR
    })
    expect(rows()).toEqual(before)
  })

  it('new start and end for one half that stay within its day are refused, nothing is lost', () => {
    const before = rows()
    expect(
      updateManualEntry(
        db,
        fromDrawer(before[1], { started_at: local(11, 0, 30), stopped_at: local(11, 5) })
      )
    ).toEqual({ ok: false, error: SPLIT_EDGE_ERROR })
    expect(rows()).toEqual(before)
  })

  it('an unusable range on one half gets the usual validation message', () => {
    const second = rows()[1]
    expect(
      updateManualEntry(
        db,
        fromDrawer(second, { started_at: local(11, 3), stopped_at: local(11, 2) })
      )
    ).toEqual({ ok: false, error: 'Endzeit muss nach der Startzeit liegen' })
  })

  it('the MCP preview shows the change to the whole entry', async () => {
    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      preview: true,
      args: { id, stopped_at: local(11, 5) }
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

  // 2.0 P2: MCP sends no segment, so a time it sends is the entry's time. An
  // MCP client that read the view's second row (0:00 to 4:00, the entry's id)
  // and sends "started_at 1:00" shortens the whole entry to 1:00 to 4:00; the
  // owner sees 20:00 to 4:00 → 1:00 to 4:00 in the dialog and the preview.
  // In 1.x the halves had their own ids and this was refused. P3 (OQ7) gives
  // `list_entries` one item per entry, so a client sees the whole range.
  it('MCP times apply to the whole entry: a start inside the second half shortens the entry (P2)', async () => {
    const { ctx, spies } = makeCtx(db)
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      args: { id, started_at: local(11, 1) }
    })
    expect(res.ok).toBe(true)
    expect(spies.confirmCalls).toBe(1)
    expect(rows().map((r) => [r.started_at, r.stopped_at])).toEqual([[local(11, 1), local(11, 4)]])
  })

  it('an MCP edit whose entry was trashed while the owner was asked is refused, not applied', async () => {
    const { ctx } = makeCtx(db)
    // The entry goes to the trash while the dialog is open.
    ctx.confirm = async () => {
      const del = deleteEntry(db, id)
      if (!del.ok) throw new Error(del.error)
      return true
    }
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      args: { id, stopped_at: local(11, 5) }
    })
    expect(res).toMatchObject({ ok: false })
    // Nothing the owner did not see was written: the entry stays in the trash
    // with the content it had.
    expect(rows()).toEqual([])
    const trashed = db
      .prepare(
        `SELECT v.deleted, v.stopped_at FROM entry e JOIN entry_version v ON v.id = e.current_version_id
          WHERE e.id = ?`
      )
      .get(id)
    expect(trashed).toEqual({ deleted: 1, stopped_at: local(11, 4) })
  })

  it('an MCP edit whose entry was edited in the app while the owner was asked is refused (#335)', async () => {
    const { ctx } = makeCtx(db)
    ctx.confirm = async () => {
      const first = rows()[0]
      const r = updateManualEntry(db, fromDrawer(first, { description: 'In der App geändert' }))
      if (!r.ok) throw new Error(r.error)
      return true
    }
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      args: { id, description: 'Per MCP geändert' }
    })
    expect(res).toMatchObject({ ok: false, error: STALE_EDIT_ERROR })
    expect(rows().map((r) => r.description)).toEqual(['In der App geändert', 'In der App geändert'])
  })

  it('a drawer save from a stale view is refused (#335 case 1)', () => {
    const second = rows()[1]
    const first = updateManualEntry(db, fromDrawer(rows()[0], { description: 'Zuerst' }))
    expect(first.ok).toBe(true)
    // The drawer still shows version 1 and sends it as expected_version.
    expect(updateManualEntry(db, fromDrawer(second, { description: 'Zu spät' }))).toEqual({
      ok: false,
      error: STALE_EDIT_ERROR
    })
    expect(rows().map((r) => r.description)).toEqual(['Zuerst', 'Zuerst'])
  })
})
