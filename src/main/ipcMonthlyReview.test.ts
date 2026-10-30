import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import type { Entry, IpcResult } from '../shared/types'
import { registerIpcHandlers, type IpcHooks } from './ipc'
import { createRun } from './billingRuns'

const { handlers, state } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => IpcResult<unknown>>(),
  state: { db: undefined as Database.Database | undefined }
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: never) => handlers.set(channel, handler),
    on: vi.fn()
  },
  app: {},
  shell: {},
  dialog: {}
}))
vi.mock('./db', () => ({ getDb: () => state.db, getDbPath: () => 'test.sqlite' }))

let Ctor: DatabaseCtor
let db: Database.Database
const request = { clientId: 1, fromIso: '2026-06-01', toIso: '2026-06-30' }
const at = (day: number, hour: number): string => new Date(2026, 5, day, hour).toISOString()
beforeAll(async () => {
  Ctor = await loadSqlite()
})
beforeEach(() => {
  db = new Ctor(':memory:')
  applyMigrations(db)
  db.exec(`INSERT INTO clients (id, name, rate_cent, short_code) VALUES
    (1, 'First', 6000, 'ONE'), (2, 'Second', 6000, 'TWO');
    INSERT INTO projects (id, client_id, name) VALUES (1, 1, 'Project')`)
  state.db = db
  handlers.clear()
  registerIpcHandlers({} as IpcHooks)
})
afterEach(() => db.close())
function invoke(channel: string, input: unknown = request): IpcResult<unknown> {
  expect(handlers.has(channel)).toBe(true)
  return handlers.get(channel)!(null, input)
}

describe('monthly review IPC', () => {
  it('returns ordered findings for the selected client, project and inclusive stored dates without writing', () => {
    const first = seedEntry(db, {
      client_id: 1,
      project_id: 1,
      started_at: at(1, 8),
      stopped_at: at(1, 9)
    })
    const last = seedEntry(db, {
      client_id: 1,
      project_id: 1,
      started_at: at(30, 8),
      stopped_at: at(30, 9)
    })
    seedEntry(db, { client_id: 2, started_at: at(2, 8), stopped_at: at(2, 9) })
    seedEntry(db, { client_id: 1, started_at: at(3, 8), stopped_at: at(3, 9) })
    seedEntry(db, { client_id: 1, project_id: 1, started_at: at(31, 8), stopped_at: at(31, 9) })
    const before = db.prepare('SELECT total_changes() AS n').get()
    expect(invoke('ruleCheck:period', { ...request, projectId: 1 })).toEqual({
      ok: true,
      data: [
        { entryId: first, rule: 'missing_description', params: {} },
        { entryId: last, rule: 'missing_description', params: {} }
      ]
    })
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
  })

  it('returns one editable row per logical entry, including non-billable, excluding running and deleted entries', async () => {
    const split = seedEntry(db, {
      client_id: 1,
      project_id: 1,
      description: '',
      segments: [
        { started_at: at(0, 23), stopped_at: at(1, 0), segment_date: '2026-05-31' },
        { started_at: at(1, 0), stopped_at: at(1, 2), segment_date: '2026-06-01' }
      ]
    })
    const within = seedEntry(db, {
      client_id: 1,
      project_id: 1,
      segments: [
        { started_at: at(28, 23), stopped_at: at(29, 0) },
        { started_at: at(29, 0), stopped_at: at(29, 2) }
      ]
    })
    const plain = seedEntry(db, {
      client_id: 1,
      project_id: 1,
      started_at: at(30, 8),
      stopped_at: at(30, 9)
    })
    const nonbillable = seedEntry(db, {
      client_id: 1,
      billable: 0,
      started_at: at(30, 10),
      stopped_at: at(30, 11)
    })
    seedEntry(db, {
      client_id: 1,
      segments: [
        { started_at: at(2, 23), stopped_at: at(3, 0) },
        { started_at: at(3, 0), stopped_at: null }
      ]
    })
    seedEntry(db, {
      client_id: 1,
      started_at: at(4, 8),
      stopped_at: at(4, 9),
      deleted_at: at(5, 8)
    })
    seedEntry(db, { client_id: 2, started_at: at(6, 8), stopped_at: at(6, 9) })
    seedEntry(db, { client_id: 1, started_at: at(31, 8), stopped_at: at(31, 9) })
    await createRun(db, { ...request, projectId: 1 }, async () => Buffer.from('pdf'))
    const before = db.prepare('SELECT total_changes() AS n').get()
    const result = invoke('entries:getForReview')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    const rows = result.data as Entry[]
    expect(rows.map((e) => e.id)).toEqual([split, within, plain, nonbillable])
    expect(rows[0]).toMatchObject({
      segment_seq: 1,
      version_no: 1,
      billed: 1,
      started_at: at(1, 0),
      entry_start: at(0, 23),
      entry_stop: at(1, 2),
      duration_seconds: 10800
    })
    expect(rows[1]).toMatchObject({ segment_seq: 0, duration_seconds: 10800 })
    expect(rows[3]).toMatchObject({ billable: 0, billed: 0 })
    const filtered = invoke('entries:getForReview', { ...request, projectId: 1 })
    expect(filtered).toMatchObject({
      ok: true,
      data: [{ id: split }, { id: within }, { id: plain }]
    })
    const findings = invoke('ruleCheck:period')
    expect(findings.ok).toBe(true)
    if (findings.ok)
      expect(new Set((findings.data as { entryId: number }[]).map((f) => f.entryId))).toEqual(
        new Set(rows.map((e) => e.id))
      )
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
  })

  for (const channel of ['ruleCheck:period', 'entries:getForReview']) {
    it(`${channel} rejects malformed IDs, calendar dates and reversed ranges`, () => {
      for (const input of [
        null,
        {},
        { ...request, clientId: 0 },
        { ...request, clientId: '1' },
        { ...request, projectId: -1 },
        { ...request, projectId: 1.5 },
        { ...request, fromIso: '2026-02-30' },
        { ...request, toIso: '2026-6-30' },
        { ...request, fromIso: '2026-07-01' },
        { ...request, toIso: 42 }
      ]) {
        expect(invoke(channel, input)).toMatchObject({ ok: false, error: expect.any(String) })
      }
    })
  }
})
