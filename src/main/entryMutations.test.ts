/**
 * Tests for the extracted entry-mutation core. Same in-memory-DB approach as
 * ipc.test.ts / migrations.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import {
  createManualEntry,
  deleteEntry,
  updateManualEntry,
  startTimer,
  stopEntry,
  stopRunningTimer,
  switchTimer,
  switchTimerAndNotify,
  validateProjectForClient
} from './entryMutations'
import { importedEventIds } from './graphImport'
import { seedEntry } from '../test/entryFixtures'

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
    // 2.0: no reader since #285, the view leaves it NULL (money columns in P4).
    expect(r.data.rounded_min).toBeNull()
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

  it('createManualEntry splits across local midnight into two segments of one entry', () => {
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
    // The entry's own range; the view shows one row per segment, same id.
    expect([r.data.started_at, r.data.stopped_at]).toEqual([
      start.toISOString(),
      stop.toISOString()
    ])
    expect(r.data.link_id).toBeNull()
    const rows = db
      .prepare(
        `SELECT segment_seq, started_at, stopped_at FROM entries WHERE id = ? ORDER BY segment_seq`
      )
      .all(r.data.id)
    expect(rows).toEqual([
      {
        segment_seq: 0,
        started_at: start.toISOString(),
        stopped_at: new Date(2026, 5, 11).toISOString()
      },
      {
        segment_seq: 1,
        started_at: new Date(2026, 5, 11).toISOString(),
        stopped_at: stop.toISOString()
      }
    ])
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
    expect(upd.data.stopped_at).toBe('2026-06-10T11:00:00.000Z')
    expect(upd.data.tags).toBe(',x,')
    expect(upd.data.id).toBe(created.data.id) // 2.0: an edit is a new version, not a new row

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
    // 2.0: deleting a running entry seals it where it stands (as L5 does for
    // a 1.x row in that shape), so the trashed version is never open.
    const del = deleteEntry(db, ghost.data.id, { now: '2026-06-10T11:05:00.000Z' })
    if (!del.ok) throw new Error(del.error)
    const r = switchTimer(db, {
      client_id: 2,
      description: '',
      started_at: '2026-06-10T10:00:00.000Z'
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.stopped).toBeNull()
    // The ghost is closed, and never before its own start: an undelete must
    // not bring back a negative duration.
    const row = db
      .prepare(
        `SELECT v.state, v.started_at, v.stopped_at FROM entry e
           JOIN entry_version v ON v.id = e.current_version_id WHERE e.id = ?`
      )
      .get(ghost.data.id) as { state: string; started_at: string; stopped_at: string | null }
    expect(row).toEqual({
      state: 'sealed',
      started_at: '2026-06-10T11:00:00.000Z',
      stopped_at: '2026-06-10T11:05:00.000Z'
    })
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

  it('refuses a start more than a minute ahead, accepts one within the minute', () => {
    startTimer(db, { client_id: 1, description: '', started_at: '2026-06-10T09:00:00.000Z' })
    const far = switchTimer(db, {
      client_id: 2,
      description: '',
      started_at: new Date(Date.now() + 10 * 60_000).toISOString()
    })
    expect(far).toEqual({ ok: false, error: 'Startzeit liegt in der Zukunft' })
    const running = db.prepare(`SELECT client_id FROM entries WHERE stopped_at IS NULL`).all()
    expect(running).toEqual([{ client_id: 1 }])
    const near = switchTimer(db, {
      client_id: 2,
      description: '',
      started_at: new Date(Date.now() + 30_000).toISOString()
    })
    expect(near.ok).toBe(true)
  })
})

// Release 1.22 (owner decision): a running entry counts as open-ended for the
// overlap check. It compared against SQLite's datetime('now') as text, which
// has a space where the stored ISO values have a `T` — on the same day the
// running entry looked already ended, and a backfill inside it went through.
describe('overlap with a running entry', () => {
  let db: Database.Database
  const H = 3_600_000
  const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString()

  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
    // Acme runs since three hours ago.
    startTimer(db, { client_id: 1, description: 'läuft', started_at: at(-3 * H) })
  })

  const backfill = (
    client_id: number,
    from: number,
    to: number
  ): ReturnType<typeof createManualEntry> =>
    createManualEntry(db, {
      client_id,
      description: 'Nachtrag',
      started_at: at(from),
      stopped_at: at(to)
    })

  it('a backfill inside the running entry of the same client is refused', () => {
    expect(backfill(1, -2 * H, -1 * H)).toEqual({
      ok: false,
      error: 'Eintrag überlappt mit einem bestehenden Eintrag desselben Kunden'
    })
  })

  it('a backfill that reaches past now is refused too — the running entry will end later', () => {
    expect(backfill(1, -1 * H, 1 * H)).toMatchObject({ ok: false, error: /überlappt/ })
  })

  it('before the running start is fine, and so is another client', () => {
    expect(backfill(1, -5 * H, -4 * H).ok).toBe(true)
    expect(backfill(2, -2 * H, -1 * H).ok).toBe(true)
  })

  it('an edit that moves an entry into the running one is refused', () => {
    const made = backfill(1, -5 * H, -4 * H)
    if (!made.ok || !made.data) throw new Error('setup')
    const res = updateManualEntry(db, {
      id: made.data.id,
      client_id: 1,
      description: 'verschoben',
      started_at: at(-2 * H),
      stopped_at: at(-1 * H)
    })
    expect(res).toMatchObject({ ok: false, error: /überlappt/ })
  })
})

// #299: in 1.x an edit was saved as delete + reinsert (new id), and the
// reinsert used to drop the calendar import anchor — the next import preview
// offered the meeting again — and the original creation time. Since 2.0 an
// edit is a new version of the same entry; the anchor and created_at belong
// to the entry (design 4.1) and a trigger refuses to change them.
describe('updateManualEntry keeps the import anchor and created_at (#299)', () => {
  let db: Database.Database
  const CREATED = '2026-01-02 08:00:00'
  // Built from local parts: segments are cut at local midnight, so a single
  // entry stays single and the pair below has two segments in any zone.
  const local = (d: number, h: number, m = 0): string => new Date(2026, 5, d, h, m).toISOString()

  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
  })

  /** An entry imported from the calendar, written a while ago; cut at local midnight. */
  function imported(startedAt: string, stoppedAt: string): number {
    const stop = new Date(stoppedAt)
    const midnight = new Date(stop.getFullYear(), stop.getMonth(), stop.getDate())
    const segments =
      midnight.getTime() > Date.parse(startedAt)
        ? [
            { started_at: startedAt, stopped_at: midnight.toISOString() },
            { started_at: midnight.toISOString(), stopped_at: stoppedAt }
          ]
        : [{ started_at: startedAt, stopped_at: stoppedAt }]
    return seedEntry(db, {
      client_id: 1,
      description: 'Termin',
      segments,
      graph_event_id: 'EVT-1',
      created_at: CREATED,
      created_source: 'import',
      source: 'import'
    })
  }

  /** The drawer's save: the times of the segment it opened (`segment_seq`), or the entry's. */
  function edit(id: number, startedAt: string, stoppedAt: string, segment_seq?: number): number {
    const res = updateManualEntry(db, {
      id,
      client_id: 1,
      description: 'Termin (korrigiert)',
      started_at: startedAt,
      stopped_at: stoppedAt,
      segment_seq
    })
    if (!res.ok) throw new Error(res.error)
    return res.data.id
  }

  const rows = (): Array<{ id: number; graph_event_id: string | null; created_at: string }> =>
    db
      .prepare(`SELECT id, graph_event_id, created_at FROM entries ORDER BY started_at`)
      .all() as Array<{ id: number; graph_event_id: string | null; created_at: string }>

  it('an edited imported entry still counts as imported', () => {
    const id = imported(local(10, 9), local(10, 10))
    const sameId = edit(id, local(10, 9, 15), local(10, 10))
    expect(sameId).toBe(id)
    expect(rows()).toEqual([{ id, graph_event_id: 'EVT-1', created_at: CREATED }])
    // The dedupe input of the import preview — the meeting is not offered again.
    expect([...importedEventIds(db)]).toEqual(['EVT-1'])
  })

  it('a plain manual entry keeps its created_at and gains no anchor', () => {
    const id = seedEntry(db, {
      client_id: 1,
      description: 'Feature',
      started_at: local(10, 9),
      stopped_at: local(10, 10),
      created_at: CREATED
    })
    edit(id, local(10, 9), local(10, 11))
    expect(rows()).toEqual([{ id, graph_event_id: null, created_at: CREATED }])
  })

  const SPLIT: [string, string] = [local(10, 20), local(11, 4)]

  it('a midnight-split entry keeps created_at and the anchor on both segments', () => {
    const id = imported(...SPLIT)
    expect(rows()).toHaveLength(2)
    // The drawer on the first segment: its start is the entry's start, the
    // 0:00 edge stays (#311).
    edit(id, local(10, 20, 30), local(11, 0), 0)
    const after = rows()
    expect(after.map((r) => r.created_at)).toEqual([CREATED, CREATED])
    // The anchor belongs to the entry, so every segment row shows it (in
    // 1.x only the first half carried it).
    expect(after.map((r) => r.graph_event_id)).toEqual(['EVT-1', 'EVT-1'])
  })

  it('editing the second segment keeps the anchor too', () => {
    const id = imported(...SPLIT)
    edit(id, local(11, 0), local(11, 3), 1)
    expect(rows().map((r) => r.graph_event_id)).toEqual(['EVT-1', 'EVT-1'])
    expect([...importedEventIds(db)]).toEqual(['EVT-1'])
  })

  it('a single entry edited into a pair, and the pair edited again, keeps both fields', () => {
    const id = imported(local(10, 9), local(10, 10))
    expect(edit(id, ...SPLIT)).toBe(id)
    expect(rows().map((r) => [r.graph_event_id, r.created_at])).toEqual([
      ['EVT-1', CREATED],
      ['EVT-1', CREATED]
    ])
    edit(id, local(10, 21), local(11, 0), 0)
    expect(rows().map((r) => [r.graph_event_id, r.created_at])).toEqual([
      ['EVT-1', CREATED],
      ['EVT-1', CREATED]
    ])
  })
})

// In 1.x an edit wrote the entry anew (delete + reinsert), and every column it
// did not pass on was reset — that is how #299 lost graph_event_id and
// created_at. Since 2.0 an edit is a new version; the columns of the view
// `entries` come from the entry, the version or the segment. This guard turns
// red for the next column: each one must be classified here, and an edit must
// keep every value the entry owns.
describe('an edit keeps every column of the entry (guard)', () => {
  /** Where a row of the view gets each column's value from after an edit. */
  const COLUMNS: Record<string, 'input' | 'carried' | 'rebuilt'> = {
    client_id: 'input',
    description: 'input',
    started_at: 'input',
    stopped_at: 'input',
    tags: 'input',
    reference: 'input',
    billable: 'input',
    private_note: 'input',
    project_id: 'input',
    // The entry's own: never change (trigger trg_entry_fixed_columns).
    id: 'carried',
    graph_event_id: 'carried',
    created_at: 'carried',
    segment_seq: 'carried',
    // The new version: its id and number; heartbeat = stop once sealed;
    // link_id, rounded_min and deleted_at are NULL in every row of the view.
    version_id: 'rebuilt',
    version_no: 'rebuilt',
    link_id: 'rebuilt',
    heartbeat_at: 'rebuilt',
    rounded_min: 'rebuilt',
    deleted_at: 'rebuilt'
  }

  it('every column of entries is classified', () => {
    const db = new DatabaseImpl(':memory:')
    seed(db)
    const names = (db.prepare(`PRAGMA table_info(entries)`).all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort()
    expect(names, 'classify the new column in COLUMNS and carry it in updateManualEntry').toEqual(
      Object.keys(COLUMNS).sort()
    )
  })

  it('an edit of one field keeps every other value the entry owns', () => {
    const db = new DatabaseImpl(':memory:')
    seed(db)
    seedEntry(db, {
      client_id: 1,
      project_id: 10,
      description: 'Alles gesetzt',
      started_at: new Date(2026, 5, 10, 9).toISOString(),
      stopped_at: new Date(2026, 5, 10, 10, 30).toISOString(),
      tags: ',a,',
      reference: 'REF-1',
      billable: 0,
      private_note: 'intern',
      graph_event_id: 'EVT-G',
      created_at: '2026-01-02 08:00:00'
    })
    const before = db.prepare(`SELECT * FROM entries`).get() as Record<string, unknown>
    const res = updateManualEntry(db, {
      id: before.id as number,
      client_id: before.client_id as number,
      project_id: before.project_id as number,
      description: 'Eines geändert',
      started_at: before.started_at as string,
      stopped_at: before.stopped_at as string,
      tags: before.tags as string,
      reference: before.reference as string,
      billable: before.billable as number,
      private_note: before.private_note as string
    })
    if (!res.ok) throw new Error(res.error)
    const after = db.prepare(`SELECT * FROM entries`).get() as Record<string, unknown>
    const owned = Object.keys(COLUMNS).filter(
      (c) => COLUMNS[c] !== 'rebuilt' && c !== 'description'
    )
    expect(Object.fromEntries(owned.map((c) => [c, after[c]]))).toEqual(
      Object.fromEntries(owned.map((c) => [c, before[c]]))
    )
    expect(after.description).toBe('Eines geändert')
    expect(after.version_no).toBe((before.version_no as number) + 1)
  })
})
