/**
 * Every main-process path that switches a running timer, held to one
 * contract (B1):
 *
 * - the old entry ends exactly where the new one begins — no gap, no overlap;
 * - a start before the running entry's own start is refused, nothing written;
 * - a SOFT-DELETED row left running never blocks a start, is never ended
 *   before its own start, and stays soft-deleted.
 *
 * Paths: the app's `switchTimerAndNotify` (behind `entries:switch` — quick
 * start keys and project list — and `entries:start`, which the start dialog
 * calls), the Stream Deck controller `toggle_timer`, and MCP `start_timer`.
 * The tray and the hotkey stop a timer, they do not switch; they are not
 * covered here.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { makeCtx, seed } from '../test/bridgeKit'
import { seedEntry } from '../test/entryFixtures'
import { handleRequest, type BridgeRequest } from './mcpBridgeCore'
import { switchTimerAndNotify } from './entryMutations'
import type { IpcResult, SwitchTimerResult } from '../shared/types'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

interface Row {
  id: number
  client_id: number
  started_at: string
  stopped_at: string | null
  heartbeat_at: string | null
  deleted_at: string | null
}

const iso = (ms: number): string => new Date(ms).toISOString()
const MIN = 60_000

describe('timer switch paths (main process)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
  })

  function insertRunning(
    id: number,
    clientId: number,
    startedAt: string,
    deletedAt: string | null = null
  ): void {
    // 2.0 P2: `entries` is a read-only view. A live running row is seeded
    // with its fixed id; a trashed one is a deleted entry, which the model seals
    // where it stood (heartbeat = start), so it is no longer "running".
    seedEntry(db, {
      id,
      client_id: clientId,
      started_at: startedAt,
      stopped_at: null,
      heartbeat_at: startedAt,
      deleted_at: deletedAt
    })
  }
  const row = (id: number): Row =>
    db
      .prepare(
        `SELECT id, client_id, started_at, stopped_at, heartbeat_at, deleted_at FROM entries WHERE id = ?`
      )
      .get(id) as Row
  // 2.0 P2: a trashed entry is not in the `entries` view; read it from the
  // entry tables (deleted_at = when the deleting version was written, heartbeat
  // = the sealed stop, as the view reports it for ended entries).
  const ghostRow = (id: number): Row =>
    db
      .prepare(
        `SELECT e.id AS id, v.client_id AS client_id, v.started_at AS started_at,
                v.stopped_at AS stopped_at, v.stopped_at AS heartbeat_at,
                CASE WHEN v.deleted = 1 THEN v.written_at END AS deleted_at
           FROM entry e JOIN entry_version v ON v.id = e.current_version_id WHERE e.id = ?`
      )
      .get(id) as Row
  const all = (): Row[] =>
    db
      .prepare(
        `SELECT id, client_id, started_at, stopped_at, heartbeat_at, deleted_at FROM entries ORDER BY id`
      )
      .all() as Row[]
  const liveRunning = (): Row[] =>
    db
      .prepare(`SELECT * FROM entries WHERE stopped_at IS NULL AND deleted_at IS NULL`)
      .all() as Row[]

  /** Assert the ghost was closed no earlier than its own start and is still deleted. */
  function expectGhostIntact(id: number, startedAt: string, deletedAt: string): void {
    const g = ghostRow(id)
    expect(g.deleted_at).toBe(deletedAt)
    expect(g.started_at).toBe(startedAt)
    expect(g.stopped_at).not.toBeNull()
    expect(Date.parse(g.stopped_at!)).toBeGreaterThanOrEqual(Date.parse(g.started_at))
    expect(Date.parse(g.heartbeat_at!)).toBeGreaterThanOrEqual(Date.parse(g.started_at))
  }

  // ── app: entries:switch / entries:start ─────────────────────────────────
  describe('app (switchTimerAndNotify — quick start, project list, start dialog)', () => {
    const switchVia = (
      clientId: number,
      startedAt: string,
      events: string[] = []
    ): IpcResult<SwitchTimerResult> =>
      switchTimerAndNotify(
        db,
        { client_id: clientId, description: '', started_at: startedAt },
        (event) => events.push(event)
      )

    it('ends the running entry at the new start: no gap, no overlap', () => {
      const t = Date.now()
      insertRunning(1, 1, iso(t - 60 * MIN))
      const events: string[] = []
      const r = switchVia(2, iso(t - 5 * MIN), events)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.data.stopped?.id).toBe(1)
      expect(row(1).stopped_at).toBe(r.data.entry.started_at)
      expect(row(1).heartbeat_at).toBe(r.data.entry.started_at)
      expect(liveRunning().map((e) => e.id)).toEqual([r.data.entry.id])
      expect(events).toEqual(['timer.stopped', 'timer.started'])
    })

    it('refuses a start before the running entry began and writes nothing', () => {
      const t = Date.now()
      insertRunning(1, 1, iso(t - 10 * MIN))
      const before = all()
      const events: string[] = []
      const r = switchVia(2, iso(t - 20 * MIN), events)
      expect(r).toEqual({
        ok: false,
        error: 'Startzeit liegt vor dem Beginn des laufenden Eintrags'
      })
      expect(all()).toEqual(before)
      expect(events).toEqual([])
    })

    it('a soft-deleted running row does not block and is never ended before its own start', () => {
      const t = Date.now()
      const ghostStart = iso(t - 10 * MIN)
      const deletedAt = iso(t - 9 * MIN)
      insertRunning(9, 1, ghostStart, deletedAt)
      const r = switchVia(2, iso(t - 30 * MIN))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data.stopped).toBeNull()
      expectGhostIntact(9, ghostStart, deletedAt)
    })
  })

  // ── Stream Deck controller: toggle_timer ────────────────────────────────
  describe('controller toggle_timer', () => {
    const ctl = (args: Record<string, unknown>): BridgeRequest => ({
      v: 1,
      token: 'ctl',
      op: 'toggle_timer',
      args
    })

    it('a switch ends the running entry at the new start: no gap, no overlap', async () => {
      insertRunning(1, 1, iso(Date.now() - 60 * MIN))
      const { ctx } = makeCtx(db)
      const res = await handleRequest(ctx, ctl({ client_id: 2 }))
      expect(res).toMatchObject({ ok: true, data: { action: 'switched' } })
      const running = liveRunning()
      expect(running).toHaveLength(1)
      expect(row(1).stopped_at).toBe(running[0].started_at)
      expect(row(1).heartbeat_at).toBe(running[0].started_at)
    })

    it('refuses while the running entry began after now (key press is "now"), writes nothing', async () => {
      // Within MCP start_timer's future tolerance, so a real database can hold it.
      insertRunning(1, 1, iso(Date.now() + 30_000))
      const before = all()
      const { ctx, spies } = makeCtx(db)
      const res = await handleRequest(ctx, ctl({ client_id: 2 }))
      expect(res).toMatchObject({
        ok: false,
        code: 'invalid',
        error: 'Startzeit liegt vor dem Beginn des laufenden Eintrags'
      })
      expect(all()).toEqual(before)
      expect(spies.webhooks).toEqual([])
      expect(spies.changeCalls).toBe(0)
    })

    it('a soft-deleted running row does not block and is never ended before its own start', async () => {
      // The ghost started after the key press: closing it "at now" would give
      // it a negative duration that an undelete would bring back.
      const ghostStart = iso(Date.now() + 30_000)
      const deletedAt = iso(Date.now())
      insertRunning(9, 1, ghostStart, deletedAt)
      const { ctx, spies } = makeCtx(db)
      const res = await handleRequest(ctx, ctl({ client_id: 2 }))
      expect(res).toMatchObject({ ok: true, data: { action: 'started' } })
      expectGhostIntact(9, ghostStart, deletedAt)
      expect(liveRunning().map((e) => e.client_id)).toEqual([2])
      // The ghost is not reported as the stopped entry.
      expect(spies.webhooks).toEqual(['start_timer'])
    })

    it('with a live entry AND a ghost running, only the live one is the stopped entry', async () => {
      const ghostStart = iso(Date.now() + 30_000)
      const deletedAt = iso(Date.now())
      insertRunning(1, 1, iso(Date.now() - 60 * MIN))
      insertRunning(9, 1, ghostStart, deletedAt)
      const { ctx } = makeCtx(db)
      const res = await handleRequest(ctx, ctl({ client_id: 2 }))
      expect(res).toMatchObject({ ok: true, data: { action: 'switched' } })
      const running = liveRunning()
      expect(running).toHaveLength(1)
      expect(row(1).stopped_at).toBe(running[0].started_at)
      expectGhostIntact(9, ghostStart, deletedAt)
    })
  })

  // ── MCP: start_timer ────────────────────────────────────────────────────
  describe('MCP start_timer', () => {
    const start = (startedAt: string): BridgeRequest => ({
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 2, description: 'mcp', started_at: startedAt }
    })

    it('a switch ends the running entry at the new start: no gap, no overlap', async () => {
      const t = Date.now()
      insertRunning(1, 1, iso(t - 60 * MIN))
      const { ctx } = makeCtx(db)
      const res = await handleRequest(ctx, start(iso(t - 30 * MIN)))
      expect(res.ok).toBe(true)
      const running = liveRunning()
      expect(running).toHaveLength(1)
      expect(running[0].started_at).toBe(iso(t - 30 * MIN))
      expect(row(1).stopped_at).toBe(running[0].started_at)
      expect(row(1).heartbeat_at).toBe(running[0].started_at)
    })

    it('refuses a start before the running entry began, without asking and without writing', async () => {
      const t = Date.now()
      insertRunning(1, 1, iso(t - 10 * MIN))
      const before = all()
      const { ctx, spies } = makeCtx(db)
      const res = await handleRequest(ctx, start(iso(t - 20 * MIN)))
      expect(res.ok).toBe(false)
      if (!res.ok)
        expect(res.error).toContain('Startzeit liegt vor dem Beginn des laufenden Eintrags')
      expect(all()).toEqual(before)
      expect(spies.confirmCalls).toBe(0)
      expect(spies.webhooks).toEqual([])
    })

    it('a soft-deleted running row does not block and is never ended before its own start', async () => {
      const t = Date.now()
      const ghostStart = iso(t - 10 * MIN)
      const deletedAt = iso(t - 9 * MIN)
      insertRunning(9, 1, ghostStart, deletedAt)
      const { ctx, spies } = makeCtx(db)
      const res = await handleRequest(ctx, start(iso(t - 30 * MIN)))
      expect(res.ok).toBe(true)
      expectGhostIntact(9, ghostStart, deletedAt)
      expect(liveRunning().map((e) => e.started_at)).toEqual([iso(t - 30 * MIN)])
      // Nothing live ran, so nothing is reported as stopped.
      expect(spies.webhooks).toEqual(['start_timer'])
      // 2.0 P2: the trashed ghost is not in the `entries` view; count the entry table.
      expect((db.prepare(`SELECT COUNT(*) AS n FROM entry`).get() as { n: number }).n).toBe(2)
    })
  })
})
