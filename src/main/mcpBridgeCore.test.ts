/**
 * Tests for the guarded MCP write-bridge core. In-memory migrated DB; stubs
 * for confirm/backup/audit/onChange.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { handleRequest, type BridgeCtx, type BridgeRequest } from './mcpBridgeCore'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

function seed(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  db.prepare(
    `INSERT INTO clients (id, name, color, active, rate_cent) VALUES (1,'Acme','#111',1,0)`
  ).run()
  db.prepare(
    `INSERT INTO clients (id, name, color, active, rate_cent) VALUES (2,'Beta','#222',1,0)`
  ).run()
  db.prepare(
    `INSERT INTO projects (id, client_id, name, status, active) VALUES (10, 1, 'Rollout', 'active', 1)`
  ).run()
  db.prepare(
    `INSERT INTO projects (id, client_id, name, status, active) VALUES (20, 2, 'Audit', 'active', 1)`
  ).run()
  db.prepare(
    `INSERT INTO projects (id, client_id, name, status, active) VALUES (30, 1, 'Altlast', 'archived', 0)`
  ).run()
}

interface Spies {
  confirmCalls: number
  backupCalls: number
  auditCalls: number
  changeCalls: number
  webhooks: string[]
}

function makeCtx(
  db: Database.Database,
  o: Partial<{
    token: string | null
    incomingWriteEnabled: boolean
    approve: boolean
    controllerToken: string | null
    controllerEnabled: boolean
  }> = {}
): { ctx: BridgeCtx; spies: Spies } {
  const spies: Spies = {
    confirmCalls: 0,
    backupCalls: 0,
    auditCalls: 0,
    changeCalls: 0,
    webhooks: []
  }
  const ctx: BridgeCtx = {
    db,
    token: o.token === undefined ? 'secret' : o.token,
    isWriteEnabled: () => o.incomingWriteEnabled !== false,
    controllerToken: o.controllerToken === undefined ? 'ctl' : o.controllerToken,
    isControllerEnabled: () => o.controllerEnabled !== false,
    confirm: async () => {
      spies.confirmCalls++
      return o.approve !== false
    },
    ensureBackup: async () => {
      spies.backupCalls++
    },
    audit: () => {
      spies.auditCalls++
    },
    onChange: () => {
      spies.changeCalls++
    },
    emitWebhook: (op) => {
      spies.webhooks.push(op)
    }
  }
  return { ctx, spies }
}

const CREATE: BridgeRequest = {
  v: 1,
  token: 'secret',
  op: 'create_manual_entry',
  args: {
    client_id: 1,
    description: 'Feature',
    started_at: '2026-06-10T09:00:00.000Z',
    stopped_at: '2026-06-10T10:00:00.000Z'
  }
}

function countEntries(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM entries`).get() as { n: number }).n
}

describe('handleRequest', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
  })

  it('rejects a bad token', async () => {
    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, { ...CREATE, token: 'wrong' })
    expect(res).toMatchObject({ ok: false, code: 'bad_token' })
    expect(countEntries(db)).toBe(0)
  })

  it('rejects when write is disabled', async () => {
    const { ctx } = makeCtx(db, { incomingWriteEnabled: false })
    const res = await handleRequest(ctx, CREATE)
    expect(res).toMatchObject({ ok: false, code: 'write_disabled' })
  })

  it('rejects an op outside the allowlist', async () => {
    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'delete_client',
      args: { id: 1 }
    })
    expect(res).toMatchObject({ ok: false, code: 'not_allowed' })
  })

  it('rejects a malformed request', async () => {
    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, {
      token: 'secret',
      op: 'create_manual_entry'
    } as BridgeRequest)
    expect(res).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('preview does not mutate, confirm, back up, or audit', async () => {
    const { ctx, spies } = makeCtx(db)
    const res = await handleRequest(ctx, { ...CREATE, preview: true })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toMatchObject({ preview: true, action: 'create_manual_entry' })
    expect(countEntries(db)).toBe(0)
    expect(spies).toMatchObject({ confirmCalls: 0, backupCalls: 0, auditCalls: 0, changeCalls: 0 })
  })

  it('commits a create: confirm + backup + change + audit fire once', async () => {
    const { ctx, spies } = makeCtx(db)
    const res = await handleRequest(ctx, CREATE)
    expect(res.ok).toBe(true)
    expect(countEntries(db)).toBe(1)
    expect(spies).toEqual({
      confirmCalls: 1,
      backupCalls: 1,
      auditCalls: 1,
      changeCalls: 1,
      webhooks: ['create_manual_entry']
    })
  })

  it('declined confirm blocks the mutation', async () => {
    const { ctx, spies } = makeCtx(db, { approve: false })
    const res = await handleRequest(ctx, CREATE)
    expect(res).toMatchObject({ ok: false, code: 'confirm_declined' })
    expect(countEntries(db)).toBe(0)
    expect(spies).toMatchObject({ backupCalls: 0, auditCalls: 0, changeCalls: 0 })
  })

  it('surfaces a validation error as invalid without mutating', async () => {
    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, {
      ...CREATE,
      args: { ...CREATE.args, client_id: 999 }
    })
    expect(res).toMatchObject({ ok: false, code: 'invalid' })
    expect(countEntries(db)).toBe(0)
  })

  it('update_entry_fields patches only provided fields', async () => {
    const { ctx } = makeCtx(db)
    await handleRequest(ctx, CREATE)
    const id = (db.prepare(`SELECT id FROM entries LIMIT 1`).get() as { id: number }).id
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      args: { id, description: 'Renamed', tags: ',x,' }
    })
    expect(res.ok).toBe(true)
    // update deletes + reinserts, yielding a new row id — read it back from the result.
    const newId = res.ok ? (res.data as { id: number }).id : id
    const row = db
      .prepare(`SELECT description, tags, started_at FROM entries WHERE id = ?`)
      .get(newId) as {
      description: string
      tags: string
      started_at: string
    }
    expect(row.description).toBe('Renamed')
    expect(row.tags).toBe(',x,')
    expect(row.started_at).toBe('2026-06-10T09:00:00.000Z') // untouched
  })

  it('update_entry_fields refuses a running entry even if stopped_at is supplied', async () => {
    const { ctx } = makeCtx(db)
    await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 1, description: 'run', started_at: '2026-06-10T09:00:00.000Z' }
    })
    const id = (
      db.prepare(`SELECT id FROM entries WHERE stopped_at IS NULL`).get() as { id: number }
    ).id
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      args: { id, stopped_at: '2026-06-10T10:00:00.000Z', description: 'x' }
    })
    expect(res).toMatchObject({ ok: false, code: 'invalid' })
    // Still running — untouched.
    const row = db.prepare(`SELECT stopped_at FROM entries WHERE id = ?`).get(id) as {
      stopped_at: string | null
    }
    expect(row.stopped_at).toBeNull()
  })

  it('start_timer rejects a project of another client', async () => {
    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 1, description: 'run', project_id: 20 }
    })
    expect(res).toMatchObject({ ok: false, code: 'invalid' })
    expect(countEntries(db)).toBe(0)
  })

  it('start_timer then stop_running_timer', async () => {
    const { ctx } = makeCtx(db)
    const start = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 1, description: 'run', started_at: '2026-06-10T09:00:00.000Z' }
    })
    expect(start.ok).toBe(true)
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE stopped_at IS NULL`).get() as {
          n: number
        }
      ).n
    ).toBe(1)
    const stop = await handleRequest(ctx, { v: 1, token: 'secret', op: 'stop_running_timer' })
    expect(stop.ok).toBe(true)
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE stopped_at IS NULL`).get() as {
          n: number
        }
      ).n
    ).toBe(0)
  })
})

// ── controller scope (#133) ─────────────────────────────────────────────────

function ctl(op: string, args: Record<string, unknown> = {}, preview = false): BridgeRequest {
  return { v: 1, token: 'ctl', op, args, preview }
}

function runningRow(
  db: Database.Database
): { client_id: number; project_id: number | null } | null {
  return (
    (db
      .prepare(
        `SELECT client_id, project_id FROM entries WHERE stopped_at IS NULL AND deleted_at IS NULL`
      )
      .get() as { client_id: number; project_id: number | null } | undefined) ?? null
  )
}

describe('handleRequest — controller scope', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
  })

  it('the two token scopes never unlock each other', async () => {
    const { ctx } = makeCtx(db)
    // Controller token on an MCP write op:
    const asMcp = await handleRequest(ctx, { ...CREATE, token: 'ctl' })
    expect(asMcp).toMatchObject({ ok: false, code: 'not_allowed' })
    // MCP token on a controller op:
    const asCtl = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'toggle_timer',
      args: { client_id: 1 }
    })
    expect(asCtl).toMatchObject({ ok: false, code: 'not_allowed' })
    expect(countEntries(db)).toBe(0)
  })

  it('rejects when the controller scope is disabled', async () => {
    const { ctx } = makeCtx(db, { controllerEnabled: false })
    const res = await handleRequest(ctx, ctl('get_timer_status'))
    expect(res).toMatchObject({ ok: false, code: 'write_disabled' })
  })

  it('rejects with no controller token configured', async () => {
    const { ctx } = makeCtx(db, { controllerToken: null })
    const res = await handleRequest(ctx, ctl('get_timer_status'))
    expect(res).toMatchObject({ ok: false, code: 'bad_token' })
  })

  it('get_timer_status: null when idle, names when running', async () => {
    const { ctx } = makeCtx(db)
    const idle = await handleRequest(ctx, ctl('get_timer_status'))
    expect(idle.ok).toBe(true)
    if (idle.ok) expect(idle.data).toEqual({ running: null })

    await handleRequest(ctx, ctl('toggle_timer', { client_id: 1, project_id: 10 }))
    const busy = await handleRequest(ctx, ctl('get_timer_status'))
    expect(busy.ok).toBe(true)
    if (busy.ok) {
      expect(busy.data).toMatchObject({
        running: { client_id: 1, project_id: 10, client_name: 'Acme', project_name: 'Rollout' }
      })
    }
  })

  it('get_summary: running timer plus today/week totals in one answer (#186)', async () => {
    const { ctx } = makeCtx(db)
    const idle = await handleRequest(ctx, ctl('get_summary'))
    expect(idle.ok).toBe(true)
    if (idle.ok) {
      expect(idle.data).toEqual({
        running: null,
        today_seconds: 0,
        week_seconds: 0,
        round_minutes: 0,
        today_rounded_seconds: 0,
        week_rounded_seconds: 0,
        today_display_seconds: 0,
        week_display_seconds: 0
      })
    }

    // One closed 30-minute entry today, then a running one.
    const now = Date.now()
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, billable)
       VALUES (1, 'closed', ?, ?, 1)`
    ).run(new Date(now - 3_600_000).toISOString(), new Date(now - 1_800_000).toISOString())
    await handleRequest(ctx, ctl('toggle_timer', { client_id: 1, project_id: 10 }))

    const busy = await handleRequest(ctx, ctl('get_summary'))
    expect(busy.ok).toBe(true)
    if (busy.ok) {
      const data = busy.data as {
        running: { client_id: number } | null
        today_seconds: number
        week_seconds: number
      }
      expect(data.running).toMatchObject({ client_id: 1, project_id: 10 })
      // 30 min closed; the running entry adds ~0 s so far.
      expect(data.today_seconds).toBeGreaterThanOrEqual(1800)
      expect(data.today_seconds).toBeLessThan(1830)
      expect(data.week_seconds).toBeGreaterThanOrEqual(data.today_seconds)
    }
  })

  it('get_summary rounds the display seconds exactly like the app page', async () => {
    // 6:24 of work at a 15-minute step is 6:30 on screen — the mismatch the
    // dial showed on its first hardware run.
    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('pdf_round_minutes','15')`
    ).run()
    // Built forwards from local midnight, not backwards from now (#213).
    // `now - 6h24m` lands on *yesterday* before 06:24 local, and the
    // DATE(started_at,'localtime') = DATE('now','localtime') filter then drops
    // the entry entirely — today_seconds came out 0 and CI went red whenever
    // it ran early in the UTC morning. The entry is closed, so its duration is
    // stopped_at - started_at and never consults SQLite's clock; only the day
    // it falls on matters, and both ends are inside today by construction.
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const started = midnight.toISOString()
    const stopped = new Date(midnight.getTime() + (6 * 3600 + 24 * 60) * 1000).toISOString()
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, billable)
       VALUES (1, 'x', ?, ?, 1)`
    ).run(started, stopped)

    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, ctl('get_summary'))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const data = res.data as {
      today_seconds: number
      today_display_seconds: number
      week_display_seconds: number
      round_minutes: number
    }
    expect(data.round_minutes).toBe(15)
    // Exact now that the fixture is exact — the old range only existed to
    // absorb the drift of measuring against `now` (#213).
    expect(data.today_seconds).toBe(6 * 3600 + 24 * 60)
    expect(data.today_display_seconds).toBe(6 * 3600 + 30 * 60)
    expect(data.week_display_seconds).toBe(6 * 3600 + 30 * 60)
    // The rounded pair under names that say what it is; *_display_seconds
    // keeps its meaning for plugins that already read it.
    const named = res.data as { today_rounded_seconds: number; week_rounded_seconds: number }
    expect(named.today_rounded_seconds).toBe(6 * 3600 + 30 * 60)
    expect(named.week_rounded_seconds).toBe(6 * 3600 + 30 * 60)
  })

  it('get_summary passes the raw seconds through when rounding is off', async () => {
    const started = new Date(Date.now() - 3_600_000).toISOString()
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, billable)
       VALUES (1, 'x', ?, ?, 1)`
    ).run(started, new Date().toISOString())

    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, ctl('get_summary'))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const data = res.data as { today_seconds: number; today_display_seconds: number }
    expect(data.today_display_seconds).toBe(data.today_seconds)
  })

  it('get_summary is read-only — no backup, no audit, no broadcast', async () => {
    const { ctx, spies } = makeCtx(db)
    await handleRequest(ctx, ctl('get_summary'))
    expect(spies.backupCalls).toBe(0)
    expect(spies.auditCalls).toBe(0)
    expect(spies.changeCalls).toBe(0)
    expect(countEntries(db)).toBe(0)
  })

  it('toggle: start → stop on the same target', async () => {
    const { ctx, spies } = makeCtx(db)
    const start = await handleRequest(ctx, ctl('toggle_timer', { client_id: 1, project_id: 10 }))
    expect(start.ok).toBe(true)
    if (start.ok) expect(start.data).toMatchObject({ action: 'started' })
    expect(runningRow(db)).toEqual({ client_id: 1, project_id: 10 })

    const stop = await handleRequest(ctx, ctl('toggle_timer', { client_id: 1, project_id: 10 }))
    expect(stop.ok).toBe(true)
    if (stop.ok) expect(stop.data).toMatchObject({ action: 'stopped' })
    expect(runningRow(db)).toBeNull()
    // No confirm dialog for physical keys; audit/backup/change/webhook fire.
    expect(spies.confirmCalls).toBe(0)
    expect(spies.auditCalls).toBe(2)
    expect(spies.changeCalls).toBe(2)
    expect(spies.backupCalls).toBe(2)
    expect(spies.webhooks).toEqual(['start_timer', 'stop_running_timer'])
  })

  it('toggle on a different target switches — exactly one timer runs', async () => {
    const { ctx } = makeCtx(db)
    await handleRequest(ctx, ctl('toggle_timer', { client_id: 1, project_id: 10 }))
    const res = await handleRequest(ctx, ctl('toggle_timer', { client_id: 2 }))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toMatchObject({ action: 'switched' })
    expect(runningRow(db)).toEqual({ client_id: 2, project_id: null })
  })

  it('same client, different project is a switch, not a stop', async () => {
    const { ctx } = makeCtx(db)
    await handleRequest(ctx, ctl('toggle_timer', { client_id: 1 }))
    const res = await handleRequest(ctx, ctl('toggle_timer', { client_id: 1, project_id: 10 }))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toMatchObject({ action: 'switched' })
    expect(runningRow(db)).toEqual({ client_id: 1, project_id: 10 })
  })

  it('toggle rejects a project of another client without mutating', async () => {
    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, ctl('toggle_timer', { client_id: 1, project_id: 20 }))
    expect(res).toMatchObject({ ok: false, code: 'invalid' })
    expect(countEntries(db)).toBe(0)
  })

  it('toggle rejects an unknown client', async () => {
    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, ctl('toggle_timer', { client_id: 999 }))
    expect(res).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('preview reports the pending action without mutating', async () => {
    const { ctx, spies } = makeCtx(db)
    const start = await handleRequest(ctx, ctl('toggle_timer', { client_id: 1 }, true))
    expect(start.ok).toBe(true)
    if (start.ok) expect(start.data).toMatchObject({ preview: true, action: 'start' })
    expect(countEntries(db)).toBe(0)
    expect(spies).toMatchObject({ backupCalls: 0, auditCalls: 0, changeCalls: 0 })
  })

  it('status reads do not back up, audit, broadcast, or confirm', async () => {
    const { ctx, spies } = makeCtx(db)
    await handleRequest(ctx, ctl('get_timer_status'))
    await handleRequest(ctx, ctl('list_targets'))
    expect(spies).toMatchObject({
      confirmCalls: 0,
      backupCalls: 0,
      auditCalls: 0,
      changeCalls: 0,
      webhooks: []
    })
  })

  it('list_targets: active clients with their active projects only', async () => {
    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, ctl('list_targets'))
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data).toEqual({
        clients: [
          {
            id: 1,
            name: 'Acme',
            color: '#111',
            projects: [{ id: 10, name: 'Rollout' }] // archived project 30 excluded
          },
          { id: 2, name: 'Beta', color: '#222', projects: [{ id: 20, name: 'Audit' }] }
        ]
      })
    }
  })
})
