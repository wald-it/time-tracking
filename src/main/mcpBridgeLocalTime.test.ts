/**
 * The bridge's confirmation text and preview in local time (owner review
 * 2026-10-22), pinned to Europe/Berlin.
 *
 * Its own file on purpose: `delete process.env.TZ` does not reset Node's time
 * zone (measured: after TZ=America/New_York and a delete, Date still reads
 * -04:00), while SQLite's 'localtime' never follows process.env.TZ on Windows.
 * Pinned in mcpBridgeCore.test.ts, JS kept computing in Berlin after this
 * block, SQLite in the runner's UTC, and the later get_summary test (JS
 * midnight against DATE('now','localtime')) found no entry for today — on the
 * Windows CI runner only. Vitest runs each test file in its own process, so
 * the pin cannot leak out of this file.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { handleRequest, type BridgeCtx, type BridgeRequest } from './mcpBridgeCore'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { makeCtx, seed } from '../test/bridgeKit'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

describe('handleRequest — confirmation and preview speak local time (Europe/Berlin)', () => {
  let db: Database.Database
  const previousTz = process.env.TZ
  beforeEach(() => {
    process.env.TZ = 'Europe/Berlin'
    db = new DatabaseImpl(':memory:')
    seed(db)
  })
  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  })

  /** A ctx that records what the owner is asked to confirm. */
  function recording(): { ctx: BridgeCtx; asked: string[] } {
    const { ctx } = makeCtx(db)
    const asked: string[] = []
    ctx.confirm = async (summary) => {
      asked.push(summary)
      return true
    }
    return { ctx, asked }
  }

  function create(started_at: string, stopped_at: string, preview = false): BridgeRequest {
    return {
      v: 1,
      token: 'secret',
      op: 'create_manual_entry',
      args: { client_id: 1, description: 'Workshop', started_at, stopped_at },
      preview
    }
  }

  const HINT =
    'Hinweis: +02:00 weicht von der Ortszeit am 28.10. ab (+01:00) — wird als 08:00 Ortszeit gespeichert.'

  it('create: the dialog shows the local span, no note when the offset fits', async () => {
    const { ctx, asked } = recording()
    await handleRequest(ctx, create('2025-10-28T09:00:00+01:00', '2025-10-28T12:00:00+01:00'))
    expect(asked).toEqual([
      'Eintrag nachtragen — Kunde 1, Di 28.10.2025 09:00–12:00 (180 min): "Workshop"'
    ])
  })

  it('create: a summer-time offset after the change gets a note in dialog and preview', async () => {
    const { ctx, asked } = recording()
    const prev = await handleRequest(
      ctx,
      create('2025-10-28T09:00:00+02:00', '2025-10-28T12:00:00+01:00', true)
    )
    expect(prev.ok).toBe(true)
    if (prev.ok) {
      expect(prev.data).toMatchObject({
        started_at: '2025-10-28T07:00:00.000Z',
        started_local: '2025-10-28T08:00:00+01:00',
        stopped_local: '2025-10-28T12:00:00+01:00',
        zeit_hinweise: { started_at: HINT }
      })
      expect(prev.data).not.toHaveProperty('zeit_hinweise.stopped_at')
    }
    await handleRequest(ctx, create('2025-10-28T09:00:00+02:00', '2025-10-28T12:00:00+01:00'))
    expect(asked[0]).toBe(
      `Eintrag nachtragen — Kunde 1, Di 28.10.2025 08:00–12:00 (240 min): "Workshop"\nStart: ${HINT}`
    )
  })

  it('create: Z gets no note', async () => {
    const { ctx } = recording()
    const prev = await handleRequest(
      ctx,
      create('2025-10-28T08:00:00Z', '2025-10-28T11:00:00Z', true)
    )
    expect(prev.ok).toBe(true)
    if (prev.ok) expect(prev.data).not.toHaveProperty('zeit_hinweise')
  })

  it('update: the dialog shows before and after in local time; the preview both sides', async () => {
    const { ctx, asked } = recording()
    await handleRequest(ctx, create('2025-10-28T09:00:00+01:00', '2025-10-28T12:00:00+01:00'))
    const { id } = db.prepare(`SELECT id FROM entries`).get() as { id: number }
    const upd = {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      args: { id, stopped_at: '2025-10-28T13:00:00+01:00' }
    }
    const prev = await handleRequest(ctx, { ...upd, preview: true })
    if (prev.ok) {
      expect(prev.data).toMatchObject({
        before: { stopped_local: '2025-10-28T12:00:00+01:00' },
        after: { stopped_local: '2025-10-28T13:00:00+01:00' }
      })
    }
    await handleRequest(ctx, upd)
    expect(asked[1]).toBe(
      `Eintrag #${id} ändern — vorher Di 28.10.2025 09:00–12:00, nachher Di 28.10.2025 09:00–13:00: "Workshop"`
    )
  })

  it('update in the repeated hour: before and after differ in the dialog', async () => {
    const { ctx, asked } = recording()
    await handleRequest(ctx, create('2025-10-26T02:15:00+02:00', '2025-10-26T03:15:00+01:00'))
    const { id } = db.prepare(`SELECT id FROM entries`).get() as { id: number }
    await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      args: { id, started_at: '2025-10-26T02:15:00+01:00' }
    })
    expect(asked[1]).toBe(
      `Eintrag #${id} ändern — vorher So 26.10.2025 02:15 (+02:00)–03:15 (+01:00), ` +
        `nachher So 26.10.2025 02:15 (+01:00)–03:15 (+01:00): "Workshop"`
    )
  })

  it('an executed write returns its offset notes too (no dialog in silent mode)', async () => {
    // makeCtx approves without asking — what confirm mode "silent" does
    const { ctx } = makeCtx(db)
    const started = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 1, started_at: '2026-10-28T09:00:00+02:00' }
    })
    expect(started.ok).toBe(true)
    if (started.ok) {
      expect(started.data).toMatchObject({
        started_at: '2026-10-28T07:00:00.000Z',
        zeit_hinweise: {
          started_at:
            'Hinweis: +02:00 weicht von der Ortszeit am 28.10. ab (+01:00) — wird als 08:00 Ortszeit gespeichert.'
        }
      })
    }
    const created = await handleRequest(
      ctx,
      create('2025-10-28T09:00:00+02:00', '2025-10-28T12:00:00+01:00')
    )
    if (created.ok) expect(created.data).toHaveProperty('zeit_hinweise.started_at')
    const plain = await handleRequest(
      ctx,
      create('2025-10-29T09:00:00+01:00', '2025-10-29T10:00:00+01:00')
    )
    if (plain.ok) expect(plain.data).not.toHaveProperty('zeit_hinweise')
  })

  it('start_timer: the dialog names a given start, else "ab jetzt"', async () => {
    const { ctx, asked } = recording()
    await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 1, description: 'Call', started_at: '2025-10-28T09:00:00+01:00' }
    })
    await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 1, description: 'Call' }
    })
    expect(asked).toEqual([
      'Timer starten — Kunde 1, ab Di 28.10.2025 09:00: "Call"',
      'Timer starten — Kunde 1, ab jetzt: "Call"'
    ])
  })
})
