/**
 * Tests for the extracted entry-mutation core. Same in-memory-DB approach as
 * ipc.test.ts / migrations.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import {
  createManualEntry,
  updateManualEntry,
  startTimer,
  stopEntry,
  stopRunningTimer,
  switchTimer,
  switchTimerAndNotify,
  validateProjectForClient
} from './entryMutations'

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
}

describe('entryMutations', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
  })

  it('createManualEntry inserts a single-day entry', () => {
    const r = createManualEntry(db, {
      client_id: 1,
      description: 'Feature',
      started_at: '2026-06-10T09:00:00.000Z',
      stopped_at: '2026-06-10T10:00:00.000Z',
      tags: ',bug,',
      reference: 'JIRA-1',
      billable: 1
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.description).toBe('Feature')
    expect(r.data.link_id).toBeNull()
    expect(r.data.rounded_min).toBe(60)
    expect(r.data.tags).toBe(',bug,')
  })

  it('validateProjectForClient rejects foreign and unknown projects', () => {
    expect(validateProjectForClient(db, 10, 1)).toBeNull()
    expect(validateProjectForClient(db, 10, 2)).toBe('Projekt gehört nicht zu diesem Kunden')
    expect(validateProjectForClient(db, 999, 1)).toBe('Projekt gehört nicht zu diesem Kunden')
  })

  it('createManualEntry rejects a project of another client (#133)', () => {
    const r = createManualEntry(db, {
      client_id: 2,
      description: 'wrong project',
      started_at: '2026-06-10T09:00:00.000Z',
      stopped_at: '2026-06-10T10:00:00.000Z',
      project_id: 10
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('Projekt gehört nicht zu diesem Kunden')
  })

  it('createManualEntry accepts a project of the same client', () => {
    const r = createManualEntry(db, {
      client_id: 1,
      description: 'right project',
      started_at: '2026-06-10T09:00:00.000Z',
      stopped_at: '2026-06-10T10:00:00.000Z',
      project_id: 10
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.project_id).toBe(10)
  })

  it('createManualEntry splits across local midnight into linked halves', () => {
    // Build local 23:00 → 01:00 next day so it crosses LOCAL midnight in any
    // timezone while staying under the 24h cap.
    const start = new Date(2026, 5, 10, 23, 0, 0)
    const stop = new Date(2026, 5, 11, 1, 0, 0)
    const r = createManualEntry(db, {
      client_id: 1,
      description: 'Nacht',
      started_at: start.toISOString(),
      stopped_at: stop.toISOString()
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.link_id).not.toBeNull()
    const rows = db
      .prepare(`SELECT * FROM entries WHERE link_id = ?`)
      .all(r.data.link_id) as Array<{ id: number }>
    expect(rows.length).toBe(2)
  })

  it('createManualEntry rejects overlap, bad times, unknown client', () => {
    createManualEntry(db, {
      client_id: 1,
      description: 'A',
      started_at: '2026-06-10T09:00:00.000Z',
      stopped_at: '2026-06-10T10:00:00.000Z'
    })
    const overlap = createManualEntry(db, {
      client_id: 1,
      description: 'B',
      started_at: '2026-06-10T09:30:00.000Z',
      stopped_at: '2026-06-10T10:30:00.000Z'
    })
    expect(overlap.ok).toBe(false)

    const reversed = createManualEntry(db, {
      client_id: 1,
      description: 'C',
      started_at: '2026-06-12T10:00:00.000Z',
      stopped_at: '2026-06-12T09:00:00.000Z'
    })
    expect(reversed.ok).toBe(false)

    const noClient = createManualEntry(db, {
      client_id: 999,
      description: 'D',
      started_at: '2026-06-13T09:00:00.000Z',
      stopped_at: '2026-06-13T10:00:00.000Z'
    })
    expect(noClient.ok).toBe(false)
  })

  it('updateManualEntry changes fields and rejects unknown id', () => {
    const created = createManualEntry(db, {
      client_id: 1,
      description: 'Old',
      started_at: '2026-06-10T09:00:00.000Z',
      stopped_at: '2026-06-10T10:00:00.000Z'
    })
    if (!created.ok) throw new Error('setup failed')
    const upd = updateManualEntry(db, {
      id: created.data.id,
      client_id: 1,
      description: 'New',
      started_at: '2026-06-10T09:00:00.000Z',
      stopped_at: '2026-06-10T11:00:00.000Z',
      tags: ',x,'
    })
    expect(upd.ok).toBe(true)
    if (!upd.ok) return
    expect(upd.data.description).toBe('New')
    expect(upd.data.rounded_min).toBe(120)
    expect(upd.data.tags).toBe(',x,')

    const bad = updateManualEntry(db, {
      id: 99999,
      client_id: 1,
      description: 'X',
      started_at: '2026-06-10T09:00:00.000Z',
      stopped_at: '2026-06-10T10:00:00.000Z'
    })
    expect(bad.ok).toBe(false)
  })

  it('startTimer creates a running entry and stops the previous one', () => {
    const first = startTimer(db, {
      client_id: 1,
      description: 'One',
      started_at: '2026-06-10T09:00:00.000Z'
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.data.stopped_at).toBeNull()

    const second = startTimer(db, {
      client_id: 1,
      description: 'Two',
      started_at: '2026-06-10T10:00:00.000Z'
    })
    expect(second.ok).toBe(true)
    // The first entry must now be stopped.
    const firstRow = db
      .prepare(`SELECT stopped_at FROM entries WHERE id = ?`)
      .get(first.data.id) as {
      stopped_at: string | null
    }
    expect(firstRow.stopped_at).not.toBeNull()

    // Exactly one running entry remains.
    const running = db
      .prepare(`SELECT COUNT(*) AS n FROM entries WHERE stopped_at IS NULL`)
      .get() as {
      n: number
    }
    expect(running.n).toBe(1)
  })

  it('startTimer stores the start as UTC with milliseconds, whatever form it came in', () => {
    // An MCP client may send an offset. Range queries compare started_at as a
    // string, so `2026-10-01T00:30:00+02:00` kept as is would count for
    // October although it is 30 Sep, 22:30 UTC.
    const r = startTimer(db, {
      client_id: 1,
      description: 'offset',
      started_at: '2026-10-01T00:30:00+02:00'
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.started_at).toBe('2026-09-30T22:30:00.000Z')
    expect(r.data.heartbeat_at).toBe('2026-09-30T22:30:00.000Z')
  })

  it('startTimer rejects a start time it cannot read', () => {
    const r = startTimer(db, { client_id: 1, description: 'x', started_at: 'gestern früh' })
    expect(r).toEqual({ ok: false, error: 'Startzeit ist ungültig' })
    const n = db.prepare(`SELECT COUNT(*) AS n FROM entries`).get() as { n: number }
    expect(n.n).toBe(0)
  })

  it('startTimer rejects unknown client', () => {
    const r = startTimer(db, {
      client_id: 42,
      description: 'x',
      started_at: '2026-06-10T09:00:00.000Z'
    })
    expect(r.ok).toBe(false)
  })

  // Codex on #242: the renderer could start client B with client A's project
  // (stale selection), and startTimer stored the pair. createManualEntry
  // already refuses a project of another client; starting must as well — it
  // also guards the MCP and Stream Deck start paths.
  it('startTimer rejects a project that belongs to another client', () => {
    const r = startTimer(db, {
      client_id: 2,
      project_id: 10, // belongs to client 1
      description: 'x',
      started_at: '2026-06-10T09:00:00.000Z'
    })
    expect(r.ok).toBe(false)
    const running = db
      .prepare(`SELECT COUNT(*) AS n FROM entries WHERE stopped_at IS NULL`)
      .get() as { n: number }
    expect(running.n).toBe(0)
  })

  it('stopRunningTimer stops the open entry and returns null when none run', () => {
    expect(stopRunningTimer(db)).toEqual({ ok: true, data: null })
    startTimer(db, { client_id: 1, description: 'run', started_at: '2026-06-10T09:00:00.000Z' })
    const stopped = stopRunningTimer(db)
    expect(stopped.ok).toBe(true)
    if (!stopped.ok) return
    expect(stopped.data?.stopped_at).not.toBeNull()
    // Now nothing runs.
    expect(stopRunningTimer(db)).toEqual({ ok: true, data: null })
  })

  it('stopEntry stops a specific entry by id', () => {
    const started = startTimer(db, {
      client_id: 1,
      description: 'run',
      started_at: '2026-06-10T09:00:00.000Z'
    })
    if (!started.ok) throw new Error('setup failed')
    const r = stopEntry(db, started.data.id)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.stopped_at).not.toBeNull()
    expect(stopEntry(db, 99999).ok).toBe(false)
  })
})

describe('switchTimer (B1)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
  })

  it('ends the running entry at the instant the new one begins and returns both', () => {
    const first = startTimer(db, {
      client_id: 1,
      description: '',
      started_at: '2026-06-10T09:00:00.000Z'
    })
    if (!first.ok) throw new Error('setup failed')
    const r = switchTimer(db, {
      client_id: 2,
      description: '',
      started_at: '2026-06-10T10:15:00.000Z'
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.entry.client_id).toBe(2)
    expect(r.data.entry.stopped_at).toBeNull()
    expect(r.data.stopped?.id).toBe(first.data.id)
    // One instant: no gap, no overlap.
    expect(r.data.stopped?.stopped_at).toBe(r.data.entry.started_at)
    expect(r.data.stopped?.heartbeat_at).toBe(r.data.entry.started_at)
  })

  it('a soft-deleted running row does not block an earlier start', () => {
    const ghost = startTimer(db, {
      client_id: 1,
      description: '',
      started_at: '2026-06-10T11:00:00.000Z'
    })
    if (!ghost.ok) throw new Error('setup failed')
    db.prepare(`UPDATE entries SET deleted_at = ? WHERE id = ?`).run(
      '2026-06-10T11:05:00.000Z',
      ghost.data.id
    )
    const r = switchTimer(db, {
      client_id: 2,
      description: '',
      started_at: '2026-06-10T10:00:00.000Z'
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.stopped).toBeNull()
    // The ghost is closed, but never before its own start: an undelete must
    // not bring back a negative duration.
    const row = db
      .prepare(`SELECT started_at, stopped_at FROM entries WHERE id = ?`)
      .get(ghost.data.id) as { started_at: string; stopped_at: string | null }
    expect(row.stopped_at).not.toBeNull()
    expect(Date.parse(row.stopped_at!)).toBeGreaterThanOrEqual(Date.parse(row.started_at))
  })

  it('returns stopped: null when nothing ran', () => {
    const r = switchTimer(db, {
      client_id: 1,
      description: '',
      started_at: '2026-06-10T09:00:00.000Z'
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.stopped).toBeNull()
  })

  it('a failing start leaves the old entry running (one transaction)', () => {
    const first = startTimer(db, {
      client_id: 1,
      description: '',
      started_at: '2026-06-10T09:00:00.000Z'
    })
    if (!first.ok) throw new Error('setup failed')
    // The insert itself fails (NOT NULL on description) after the UPDATE ran;
    // the IPC handler turns the throw into { ok: false }.
    expect(() =>
      switchTimer(db, {
        client_id: 2,
        description: null as unknown as string,
        started_at: '2026-06-10T10:00:00.000Z'
      })
    ).toThrow()
    const row = db.prepare(`SELECT stopped_at FROM entries WHERE id = ?`).get(first.data.id) as {
      stopped_at: string | null
    }
    expect(row.stopped_at).toBeNull()
  })

  it('notifies timer.stopped for the ended entry before timer.started', () => {
    const first = startTimer(db, {
      client_id: 1,
      description: '',
      started_at: '2026-06-10T09:00:00.000Z'
    })
    if (!first.ok) throw new Error('setup failed')
    const events: Array<[string, number]> = []
    const r = switchTimerAndNotify(
      db,
      { client_id: 2, description: '', started_at: '2026-06-10T10:00:00.000Z' },
      (event, entry) => events.push([event, entry.id])
    )
    if (!r.ok) throw new Error('switch failed')
    expect(events).toEqual([
      ['timer.stopped', first.data.id],
      ['timer.started', r.data.entry.id]
    ])
  })

  it('notifies only timer.started when nothing ran, and nothing on failure', () => {
    const events: string[] = []
    switchTimerAndNotify(
      db,
      { client_id: 1, description: '', started_at: '2026-06-10T09:00:00.000Z' },
      (event) => events.push(event)
    )
    switchTimerAndNotify(
      db,
      { client_id: 42, description: '', started_at: '2026-06-10T10:00:00.000Z' },
      (event) => events.push(event)
    )
    expect(events).toEqual(['timer.started'])
  })

  it('refuses a start before the running entry began', () => {
    startTimer(db, { client_id: 1, description: '', started_at: '2026-06-10T09:00:00.000Z' })
    const r = switchTimer(db, {
      client_id: 2,
      description: '',
      started_at: '2026-06-10T08:00:00.000Z'
    })
    expect(r.ok).toBe(false)
    const n = db.prepare(`SELECT COUNT(*) AS n FROM entries`).get() as { n: number }
    expect(n.n).toBe(1)
  })
})
