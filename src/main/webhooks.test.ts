/**
 * Tests for the outbound-webhook core. Same in-memory-DB approach as
 * entryMutations.test.ts; the network is always mocked — no test in this file
 * ever opens a real socket or hits a real endpoint.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { startTimer, createManualEntry } from './entryMutations'
import {
  buildWebhookPayload,
  signBody,
  deliverWebhook,
  emitWebhooks,
  eventForWriteOp
} from './webhooks'
import type { Entry } from '../shared/types'
import type { WebhookTarget } from '../shared/webhooks'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

function seed(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  // Client rate 120 €/h, project rate 90 €/h (project overrides client).
  db.prepare(
    `INSERT INTO clients (id, name, color, active, rate_cent) VALUES (1,'Acme','#111',1,12000)`
  ).run()
  db.prepare(
    `INSERT INTO projects (id, client_id, name, color, rate_cent, active) VALUES (1,1,'Website','#222',9000,1)`
  ).run()
}

/** A stopped 1h entry with tags/reference/private_note set, on project 1. */
function makeStoppedEntry(db: Database.Database): Entry {
  const r = createManualEntry(db, {
    client_id: 1,
    description: 'Feature',
    started_at: '2026-06-10T09:00:00.000Z',
    stopped_at: '2026-06-10T10:00:00.000Z',
    tags: ',bug,ux,',
    reference: 'JIRA-1',
    billable: 1,
    private_note: 'geheim',
    project_id: 1
  })
  if (!r.ok) throw new Error('seed entry failed')
  return r.data
}

function target(over: Partial<WebhookTarget> = {}): WebhookTarget {
  return {
    id: 't1',
    url: 'https://hook.test/in',
    secret: '',
    events: ['timer.started', 'timer.stopped', 'entry.created', 'entry.updated'],
    enabled: true,
    ...over
  }
}

/** Mock fetch: replays a list of statuses (or 'throw'); records every call. */
function mockFetch(script: Array<number | 'throw'>): {
  fn: typeof fetch
  calls: Array<{ url: string; body: string; headers: Record<string, string> }>
} {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = []
  let i = 0
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: String(init.body),
      headers: init.headers as Record<string, string>
    })
    const step = script[Math.min(i, script.length - 1)]
    i++
    if (step === 'throw') throw new Error('ECONNREFUSED')
    return { ok: step >= 200 && step < 300, status: step } as Response
  }) as unknown as typeof fetch
  return { fn, calls }
}

const NOOP_SLEEP = (): Promise<void> => Promise.resolve()

// ── Fake DB ────────────────────────────────────────────────────────────────
// A structural stand-in for the better-sqlite3 handle, so the payload/privacy/
// emit logic can be exercised without paying for a migrated DB per case. Rows
// use the REAL column shapes the queries read, so this can't go blind to a
// shape drift the way an invented shape would. The migrated-DB blocks below
// cover the same logic against real SQL.
interface FakeData {
  targetsRaw?: string
  client?: { id: number; name: string; rate_cent: number }
  project?: { id: number; name: string; rate_cent: number | null }
  exposeRates?: boolean
  exposePrivateNotes?: boolean
}
function fakeDb(data: FakeData): Database.Database {
  const db = {
    prepare(sql: string) {
      return {
        get: (...args: unknown[]): unknown => {
          if (sql.includes("key = 'webhook_targets'")) {
            return data.targetsRaw === undefined ? undefined : { value: data.targetsRaw }
          }
          if (sql.includes('FROM settings WHERE key = ?')) {
            const key = args[0]
            if (key === 'mcp_expose_rates') return { value: data.exposeRates ? '1' : '0' }
            if (key === 'mcp_expose_private_notes') {
              return { value: data.exposePrivateNotes ? '1' : '0' }
            }
            return undefined
          }
          if (sql.includes('FROM clients')) return data.client
          if (sql.includes('FROM projects')) return data.project
          return undefined
        },
        all: (): unknown[] => []
      }
    }
  }
  return db as unknown as Database.Database
}

function stoppedEntryObj(over: Partial<Entry> = {}): Entry {
  return {
    id: 7,
    client_id: 1,
    description: 'Feature',
    started_at: '2026-06-10T09:00:00.000Z',
    stopped_at: '2026-06-10T10:00:00.000Z',
    heartbeat_at: '2026-06-10T10:00:00.000Z',
    rounded_min: 60,
    deleted_at: null,
    created_at: '2026-06-10T10:00:00.000Z',
    link_id: null,
    tags: ',bug,ux,',
    reference: 'JIRA-1',
    billable: 1,
    private_note: 'geheim',
    project_id: 1,
    ...over
  }
}

describe('buildWebhookPayload (fake DB, runs everywhere)', () => {
  const client = { id: 1, name: 'Acme', rate_cent: 12000 }
  const project = { id: 1, name: 'Website', rate_cent: 9000 }

  it('hides rates + private notes by default and omits (not nulls) the fields', () => {
    const db = fakeDb({ client, project })
    const p = buildWebhookPayload(
      db,
      'entry.created',
      stoppedEntryObj(),
      { exposeRates: false, exposePrivateNotes: false },
      { deliveryId: 'd', now: Date.parse('2026-06-10T10:00:00.000Z') }
    )
    expect(p.entry.duration_seconds).toBe(3600)
    expect(p.entry.tags).toEqual(['bug', 'ux'])
    expect(p.entry.client).toEqual({ id: 1, name: 'Acme' })
    expect(p.entry.project).toEqual({ id: 1, name: 'Website' })
    expect('rate_cent' in p.entry).toBe(false)
    expect('revenue_cent' in p.entry).toBe(false)
    expect('private_note' in p.entry).toBe(false)
  })

  it('carries the entry version next to the stable id, and omits it when there is none', () => {
    const db = fakeDb({ client, project })
    const privacy = { exposeRates: false, exposePrivateNotes: false }
    const opts = { deliveryId: 'd', now: Date.now() }
    const withVersion = buildWebhookPayload(
      db,
      'entry.updated',
      stoppedEntryObj({ version_no: 3 }),
      privacy,
      opts
    )
    expect(withVersion.entry.id).toBe(stoppedEntryObj().id)
    expect(withVersion.entry.version).toBe(3)
    const without = buildWebhookPayload(db, 'entry.updated', stoppedEntryObj(), privacy, opts)
    expect('version' in without.entry).toBe(false)
  })

  it('inherits the client rate when the project rate is null', () => {
    const db = fakeDb({ client, project: { id: 1, name: 'Website', rate_cent: null } })
    const p = buildWebhookPayload(
      db,
      'entry.created',
      stoppedEntryObj(),
      { exposeRates: true, exposePrivateNotes: false },
      { deliveryId: 'd', now: Date.now() }
    )
    expect(p.entry.rate_cent).toBe(12000)
  })

  it('reports no revenue for non-billable time, but still the rate', () => {
    const db = fakeDb({ client, project })
    const p = buildWebhookPayload(
      db,
      'entry.created',
      stoppedEntryObj({ billable: 0 }),
      { exposeRates: true, exposePrivateNotes: false },
      { deliveryId: 'd', now: Date.now() }
    )
    expect(p.entry.rate_cent).toBe(9000)
    expect(p.entry.revenue_cent).toBe(0)
  })

  it('a goodwill project (rate 0) bills 0 €, not the client rate', () => {
    const db = fakeDb({ client, project: { id: 1, name: 'Website', rate_cent: 0 } })
    const p = buildWebhookPayload(
      db,
      'entry.created',
      stoppedEntryObj(),
      { exposeRates: true, exposePrivateNotes: false },
      { deliveryId: 'd', now: Date.now() }
    )
    expect(p.entry.rate_cent).toBe(0)
    expect(p.entry.revenue_cent).toBe(0)
  })

  it('null duration for a running timer, and no revenue even with rates on', () => {
    const db = fakeDb({ client, project: undefined })
    const p = buildWebhookPayload(
      db,
      'timer.started',
      stoppedEntryObj({ stopped_at: null, project_id: null }),
      { exposeRates: true, exposePrivateNotes: false },
      { deliveryId: 'd', now: Date.now() }
    )
    expect(p.entry.duration_seconds).toBeNull()
    expect(p.entry.project).toBeNull()
    expect(p.entry.rate_cent).toBe(12000)
    expect('revenue_cent' in p.entry).toBe(false)
  })
})

describe('emitWebhooks (fake DB, runs everywhere)', () => {
  const client = { id: 1, name: 'Acme', rate_cent: 12000 }

  it('delivers only to enabled + subscribed targets and never throws on failure', async () => {
    const db = fakeDb({
      client,
      targetsRaw: JSON.stringify([
        { id: 'off', url: 'https://a.test', secret: '', events: ['timer.started'], enabled: false },
        { id: 'no', url: 'https://b.test', secret: '', events: ['entry.created'], enabled: true },
        { id: 'yes', url: 'https://c.test', secret: 'k', events: ['timer.started'], enabled: true }
      ])
    })
    const { fn, calls } = mockFetch(['throw'])
    let logged: { target_id: string; ok: boolean; attempts: number } | null = null
    const done = new Promise<void>((resolve) => {
      expect(() =>
        emitWebhooks(db, 'timer.started', stoppedEntryObj({ stopped_at: null }), {
          fetchImpl: fn,
          sleep: NOOP_SLEEP,
          newDeliveryId: () => 'fixed',
          log: (rec) => {
            logged = rec as typeof logged
            resolve()
          }
        })
      ).not.toThrow()
    })
    await done
    // Only the one enabled+subscribed target fired (3 calls = its retries).
    expect(new Set(calls.map((c) => c.url))).toEqual(new Set(['https://c.test']))
    expect(calls).toHaveLength(3)
    expect(logged!.target_id).toBe('yes')
    expect(logged!.ok).toBe(false)
    expect(logged!.attempts).toBe(3)
  })

  it('keeps the emit order per target when the first delivery needs a retry', async () => {
    const db = fakeDb({
      client,
      targetsRaw: JSON.stringify([
        {
          id: 'one',
          url: 'https://a.test',
          secret: '',
          events: ['timer.stopped', 'timer.started'],
          enabled: true
        }
      ])
    })
    // The first request (timer.stopped) fails with a 503 and is retried; every
    // later request succeeds. Unchained, timer.started went out while the stop
    // waited for its retry and arrived first.
    const { fn, calls } = mockFetch([503, 200])
    let settled = 0
    const done = new Promise<void>((resolve) => {
      const log = (): void => {
        if (++settled === 2) resolve()
      }
      emitWebhooks(db, 'timer.stopped', stoppedEntryObj(), {
        fetchImpl: fn,
        sleep: NOOP_SLEEP,
        log
      })
      emitWebhooks(db, 'timer.started', stoppedEntryObj({ id: 8, stopped_at: null }), {
        fetchImpl: fn,
        sleep: NOOP_SLEEP,
        log
      })
    })
    await done
    const events = calls.map((c) => c.headers['X-TimeTrack-Event'])
    expect(events).toEqual(['timer.stopped', 'timer.stopped', 'timer.started'])
  })

  it('does nothing (and never throws) for a corrupt blob or a null entry', () => {
    const bad = fakeDb({ client, targetsRaw: '{not json' })
    const { fn, calls } = mockFetch([200])
    expect(() =>
      emitWebhooks(bad, 'entry.created', stoppedEntryObj(), { fetchImpl: fn })
    ).not.toThrow()
    expect(() => emitWebhooks(bad, 'timer.stopped', null, { fetchImpl: fn })).not.toThrow()
    expect(calls).toHaveLength(0)
  })
})

describe('buildWebhookPayload', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
  })

  it('builds the documented shape and hides rates + private notes by default', () => {
    const entry = makeStoppedEntry(db)
    const p = buildWebhookPayload(
      db,
      'entry.created',
      entry,
      { exposeRates: false, exposePrivateNotes: false },
      { deliveryId: 'd1', now: Date.parse('2026-06-10T10:00:00.000Z') }
    )
    expect(p.event).toBe('entry.created')
    expect(p.delivery_id).toBe('d1')
    expect(p.timestamp).toBe('2026-06-10T10:00:00.000Z')
    expect(p.entry.id).toBe(entry.id)
    expect(p.entry.duration_seconds).toBe(3600)
    expect(p.entry.billable).toBe(true)
    expect(p.entry.tags).toEqual(['bug', 'ux'])
    expect(p.entry.reference).toBe('JIRA-1')
    expect(p.entry.client).toEqual({ id: 1, name: 'Acme' })
    expect(p.entry.project).toEqual({ id: 1, name: 'Website' })
    // Privacy gates OFF ⇒ fields OMITTED (not null).
    expect('rate_cent' in p.entry).toBe(false)
    expect('revenue_cent' in p.entry).toBe(false)
    expect('private_note' in p.entry).toBe(false)
  })

  it('includes rate/revenue and private note when both gates are on', () => {
    const entry = makeStoppedEntry(db)
    const p = buildWebhookPayload(
      db,
      'entry.created',
      entry,
      { exposeRates: true, exposePrivateNotes: true },
      { deliveryId: 'd2', now: Date.now() }
    )
    // Project rate (9000) overrides client rate (12000); 1h ⇒ revenue = rate.
    expect(p.entry.rate_cent).toBe(9000)
    expect(p.entry.revenue_cent).toBe(9000)
    expect(p.entry.private_note).toBe('geheim')
  })

  it('bills revenue like the invoice: minutes rounded up to the step', () => {
    // 16 min at 90 €/h with a 15-min step bills 30 min = 45,00 €, not 24,00 €.
    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('pdf_round_minutes', '15')`
    ).run()
    const r = createManualEntry(db, {
      client_id: 1,
      project_id: 1,
      description: 'Kurz',
      started_at: '2026-06-10T09:00:00.000Z',
      stopped_at: '2026-06-10T09:16:00.000Z'
    })
    if (!r.ok) throw new Error('seed entry failed')
    const p = buildWebhookPayload(
      db,
      'entry.created',
      r.data,
      { exposeRates: true, exposePrivateNotes: false },
      { deliveryId: 'd', now: Date.now() }
    )
    expect(p.entry.revenue_cent).toBe(4500)
  })

  it.each([
    { projectId: null, projectRate: null, expected: 16000 },
    { projectId: 1, projectRate: 18000, expected: 18000 },
    { projectId: 1, projectRate: null, expected: 16000 },
    { projectId: 1, projectRate: 0, expected: 0 }
  ])(
    'timer.started reads due editor rates with stale columns ($projectId, $projectRate)',
    ({ projectId, projectRate, expected }) => {
      db.exec(`INSERT INTO rate (client_id, valid_from, rate_cent, source) VALUES
        (1, date('now', 'localtime'), 16000, 'editor'),
        (1, date('now', 'localtime', '+1 day'), 20000, 'editor')`)
      if (projectId !== null) {
        db.prepare(
          `INSERT INTO rate (project_id, valid_from, rate_cent, source)
          VALUES (1, date('now', 'localtime'), ?, 'editor')`
        ).run(projectRate)
        db.exec(`INSERT INTO rate (project_id, valid_from, rate_cent, source)
          VALUES (1, date('now', 'localtime', '+1 day'), 22000, 'editor')`)
      }
      const r = startTimer(db, {
        client_id: 1,
        project_id: projectId,
        description: 'Due rate',
        started_at: new Date().toISOString()
      })
      if (!r.ok) throw new Error('setup failed')
      expect(
        db
          .prepare('SELECT rate_cent, fee_cent FROM billing_lines WHERE entry_id = ?')
          .all(r.data.id)
      ).toEqual([{ rate_cent: null, fee_cent: null }])
      db.pragma('query_only = ON')

      const p = buildWebhookPayload(
        db,
        'timer.started',
        r.data,
        { exposeRates: true, exposePrivateNotes: false },
        { deliveryId: 'due-rate', now: Date.now() }
      )
      expect(p.entry.rate_cent).toBe(expected)
      expect(p.entry.stopped_at).toBeNull()
      expect(p.entry).not.toHaveProperty('revenue_cent')
      expect(db.prepare('SELECT rate_cent FROM clients WHERE id = 1').get()).toEqual({
        rate_cent: 12000
      })
      expect(db.prepare('SELECT rate_cent FROM projects WHERE id = 1').get()).toEqual({
        rate_cent: 9000
      })
    }
  )

  it('reports duration_seconds null for a running timer and omits revenue', () => {
    const r = startTimer(db, {
      client_id: 1,
      description: 'Läuft',
      started_at: '2026-06-10T09:00:00.000Z'
    })
    if (!r.ok) throw new Error('setup failed')
    const p = buildWebhookPayload(
      db,
      'timer.started',
      r.data,
      { exposeRates: true, exposePrivateNotes: false },
      { deliveryId: 'd3', now: Date.now() }
    )
    expect(p.entry.stopped_at).toBeNull()
    expect(p.entry.duration_seconds).toBeNull()
    // Rate is known even for a running timer, but revenue needs a duration.
    expect(p.entry.rate_cent).toBe(12000) // no project ⇒ client rate
    expect('revenue_cent' in p.entry).toBe(false)
  })
})

describe('signBody', () => {
  it('matches a fixed HMAC-SHA256 expectation over the raw string', () => {
    const body = '{"event":"timer.started","delivery_id":"abc"}'
    expect(signBody('s3cr3t', body)).toBe(
      'sha256=020de1340515edb1b1f0e68632bdb1af9e882ddd90a71115ef96679ff17ff85a'
    )
  })
})

describe('deliverWebhook', () => {
  it('signs the exact body that is sent, when a secret is set', async () => {
    const { fn, calls } = mockFetch([200])
    const body = '{"hello":"world"}'
    await deliverWebhook(target({ secret: 'k' }), 'timer.started', body, 'd1', {
      fetchImpl: fn,
      sleep: NOOP_SLEEP
    })
    expect(calls[0].body).toBe(body)
    expect(calls[0].headers['X-TimeTrack-Signature']).toBe(signBody('k', body))
    expect(calls[0].headers['X-TimeTrack-Event']).toBe('timer.started')
    expect(calls[0].headers['X-TimeTrack-Delivery']).toBe('d1')
  })

  it('omits the signature header when no secret is set', async () => {
    const { fn, calls } = mockFetch([200])
    await deliverWebhook(target({ secret: '' }), 'timer.started', '{}', 'd1', {
      fetchImpl: fn,
      sleep: NOOP_SLEEP
    })
    expect('X-TimeTrack-Signature' in calls[0].headers).toBe(false)
  })

  it('succeeds on the first 2xx without retrying', async () => {
    const { fn, calls } = mockFetch([200])
    const r = await deliverWebhook(target(), 'timer.started', '{}', 'd', {
      fetchImpl: fn,
      sleep: NOOP_SLEEP
    })
    expect(r).toEqual({ ok: true, status: 200, attempts: 1 })
    expect(calls).toHaveLength(1)
  })

  it('retries on 5xx up to 3 attempts, then gives up', async () => {
    const { fn, calls } = mockFetch([500, 503, 500])
    const r = await deliverWebhook(target(), 'timer.started', '{}', 'd', {
      fetchImpl: fn,
      sleep: NOOP_SLEEP
    })
    expect(calls).toHaveLength(3)
    expect(r.ok).toBe(false)
    expect(r.attempts).toBe(3)
  })

  it('retries on a network error, then succeeds', async () => {
    const { fn, calls } = mockFetch(['throw', 200])
    const r = await deliverWebhook(target(), 'timer.started', '{}', 'd', {
      fetchImpl: fn,
      sleep: NOOP_SLEEP
    })
    expect(calls).toHaveLength(2)
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(2)
  })

  it("does NOT retry a 4xx — it is the user's configuration error", async () => {
    const { fn, calls } = mockFetch([400, 200])
    const r = await deliverWebhook(target(), 'timer.started', '{}', 'd', {
      fetchImpl: fn,
      sleep: NOOP_SLEEP
    })
    expect(calls).toHaveLength(1)
    expect(r).toMatchObject({ ok: false, status: 400, attempts: 1 })
  })

  it('grows the backoff exponentially between attempts', async () => {
    const delays: number[] = []
    const sleepSpy = (ms: number): Promise<void> => {
      delays.push(ms)
      return Promise.resolve()
    }
    const { fn } = mockFetch([500, 500, 500])
    await deliverWebhook(target(), 'timer.started', '{}', 'd', {
      fetchImpl: fn,
      sleep: sleepSpy,
      baseDelayMs: 100
    })
    // 3 attempts ⇒ 2 sleeps: 100, 200.
    expect(delays).toEqual([100, 200])
  })
})

describe('eventForWriteOp', () => {
  it('maps every MCP write op to its event', () => {
    expect(eventForWriteOp('create_manual_entry')).toBe('entry.created')
    expect(eventForWriteOp('update_entry_fields')).toBe('entry.updated')
    expect(eventForWriteOp('start_timer')).toBe('timer.started')
    expect(eventForWriteOp('stop_running_timer')).toBe('timer.stopped')
  })
})

describe('emitWebhooks (fire-and-forget)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
  })

  function setTargets(targets: WebhookTarget[]): void {
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('webhook_targets', ?)`).run(
      JSON.stringify(targets)
    )
  }

  it('delivers to enabled targets subscribed to the event', async () => {
    setTargets([target({ id: 'a', events: ['timer.started'] })])
    const entry = makeStoppedEntry(db)
    const { fn, calls } = mockFetch([200])
    const done = new Promise<void>((resolve) => {
      emitWebhooks(db, 'timer.started', entry, {
        fetchImpl: fn,
        sleep: NOOP_SLEEP,
        newDeliveryId: () => 'fixed',
        log: () => resolve()
      })
    })
    await done
    expect(calls).toHaveLength(1)
    expect(calls[0].headers['X-TimeTrack-Delivery']).toBe('fixed')
  })

  it('skips targets that are disabled or not subscribed', async () => {
    setTargets([
      target({ id: 'off', enabled: false, events: ['timer.started'] }),
      target({ id: 'other', events: ['entry.created'] })
    ])
    const entry = makeStoppedEntry(db)
    const { fn, calls } = mockFetch([200])
    emitWebhooks(db, 'timer.started', entry, { fetchImpl: fn, sleep: NOOP_SLEEP })
    // No matching target ⇒ nothing scheduled. Flush microtasks to be sure.
    await Promise.resolve()
    expect(calls).toHaveLength(0)
  })

  it('does nothing for a null entry', () => {
    setTargets([target({ events: ['timer.stopped'] })])
    const { fn, calls } = mockFetch([200])
    expect(() => emitWebhooks(db, 'timer.stopped', null, { fetchImpl: fn })).not.toThrow()
    expect(calls).toHaveLength(0)
  })

  // The most important guarantee: a failing webhook must never take the timer
  // down. We start a real timer, then emit against a fetch that always throws.
  it('a failing delivery never throws and leaves the started timer intact', async () => {
    setTargets([target({ id: 'boom', events: ['timer.started'] })])
    const started = startTimer(db, {
      client_id: 1,
      description: 'wichtig',
      started_at: '2026-06-10T09:00:00.000Z'
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return

    const { fn } = mockFetch(['throw'])
    let logged: { ok: boolean; attempts: number } | null = null
    const done = new Promise<void>((resolve) => {
      // emitWebhooks itself must return void synchronously without throwing.
      expect(() =>
        emitWebhooks(db, 'timer.started', started.data, {
          fetchImpl: fn,
          sleep: NOOP_SLEEP,
          log: (rec) => {
            logged = rec
            resolve()
          }
        })
      ).not.toThrow()
    })
    await done

    // The timer row is untouched and still running despite the delivery failure.
    const row = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(started.data.id) as Entry
    expect(row.stopped_at).toBeNull()
    expect(logged).not.toBeNull()
    expect(logged!.ok).toBe(false)
    expect(logged!.attempts).toBe(3)
  })

  it('never throws even when the stored blob is corrupt', () => {
    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('webhook_targets', '{not json')`
    ).run()
    const entry = makeStoppedEntry(db)
    expect(() =>
      emitWebhooks(db, 'entry.created', entry, { fetchImpl: mockFetch([200]).fn })
    ).not.toThrow()
  })
})
