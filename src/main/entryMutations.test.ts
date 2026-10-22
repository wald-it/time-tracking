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
