import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import type { Entry, IpcResult } from '../shared/types'
import { registerIpcHandlers, type IpcHooks } from './ipc'
import { emitWebhooks } from './webhooks'
import { readEntry, updateManualEntry } from './entryMutations'
import { createRun } from './billingRuns'

const { handlers, state } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => IpcResult<Entry>>(),
  state: { db: undefined as Database.Database | undefined }
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: never) => handlers.set(channel, handler),
    on: vi.fn()
  },
  app: { getPath: () => '', getVersion: () => '2.0' },
  shell: {},
  dialog: {}
}))
vi.mock('./db', () => ({ getDb: () => state.db, getDbPath: () => 'test.sqlite' }))
vi.mock('./webhooks', () => ({ emitWebhooks: vi.fn() }))

let Sqlite: DatabaseCtor
let db: Database.Database
const startedAt = new Date(2026, 5, 10, 10).toISOString()
const idleSince = new Date(2026, 5, 10, 11).toISOString()
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
beforeEach(() => {
  db = new Sqlite(':memory:')
  applyMigrations(db)
  db.exec("INSERT INTO clients (id, name, short_code) VALUES (1, 'Client', 'ABC')")
  seedEntry(db, {
    id: 1,
    client_id: 1,
    started_at: startedAt,
    stopped_at: null
  })
  state.db = db
  handlers.clear()
  vi.clearAllMocks()
  registerIpcHandlers({} as IpcHooks)
})
afterEach(() => db.close())

const invoke = (channel: string, ...args: unknown[]): IpcResult<Entry> =>
  handlers.get(channel)!(null, ...args)

describe('idle stop webhooks (#330)', () => {
  it('emits timer.stopped exactly once with the running id and given stop time', () => {
    const result = invoke('entries:stopAt', 1, idleSince)
    expect(result).toMatchObject({ ok: true, data: { id: 1, stopped_at: idleSince } })
    expect(emitWebhooks).toHaveBeenCalledExactlyOnceWith(
      db,
      'timer.stopped',
      expect.objectContaining({ id: 1, stopped_at: idleSince }),
      expect.any(Object)
    )
  })

  it('an edit of a stopped entry still emits entry.updated once', () => {
    invoke('entries:stop', 1)
    vi.mocked(emitWebhooks).mockClear()
    expect(invoke('entries:update', { id: 1, description: 'Edited' }).ok).toBe(true)
    expect(emitWebhooks).toHaveBeenCalledExactlyOnceWith(
      db,
      'entry.updated',
      expect.objectContaining({ id: 1, description: 'Edited' }),
      expect.any(Object)
    )
  })

  it.each([new Date(2026, 5, 10, 9).toISOString(), 'invalid'])(
    'refuses stop time %s without a write or webhook',
    (stoppedAt) => {
      const before = readEntry(db, 1)
      expect(invoke('entries:stopAt', 1, stoppedAt).ok).toBe(false)
      expect(readEntry(db, 1)).toEqual(before)
      expect(emitWebhooks).not.toHaveBeenCalled()
    }
  )

  it('keeps every content field and the version when stopping across local midnight', () => {
    db.exec("INSERT INTO projects (id, client_id, name) VALUES (10, 1, 'Project')")
    expect(
      updateManualEntry(db, {
        id: 1,
        project_id: 10,
        description: 'Work',
        tags: ',ops,',
        reference: 'REF-1',
        private_note: 'Internal',
        billable: 0
      }).ok
    ).toBe(true)
    const before = readEntry(db, 1)!
    const midnight = new Date(2026, 5, 11, 0).toISOString()
    const stoppedAt = new Date(2026, 5, 11, 1).toISOString()
    const result = invoke('entries:stopAt', 1, stoppedAt)
    expect(result).toMatchObject({ ok: true, data: { id: 1, stopped_at: stoppedAt } })
    const after = readEntry(db, 1)!
    for (const key of [
      'id',
      'version_id',
      'version_no',
      'created_at',
      'created_source',
      'graph_event_id',
      'client_id',
      'project_id',
      'description',
      'started_at',
      'tags',
      'reference',
      'private_note',
      'billable'
    ] as const) {
      expect(after[key], key).toEqual(before[key])
    }
    expect(after.source).toBe('idle')
    expect(after.state).toBe('sealed')
    expect(after.segments).toEqual([
      { seq: 0, segment_date: '2026-06-10', started_at: startedAt, stopped_at: midnight },
      { seq: 1, segment_date: '2026-06-11', started_at: midnight, stopped_at: stoppedAt }
    ])
    expect(emitWebhooks).toHaveBeenCalledExactlyOnceWith(
      db,
      'timer.stopped',
      expect.objectContaining({ id: 1, stopped_at: stoppedAt }),
      expect.any(Object)
    )
  })

  it('refuses a second stop without another webhook', () => {
    expect(invoke('entries:stopAt', 1, idleSince).ok).toBe(true)
    vi.mocked(emitWebhooks).mockClear()
    const before = readEntry(db, 1)
    expect(invoke('entries:stopAt', 1, idleSince).ok).toBe(false)
    expect(readEntry(db, 1)).toEqual(before)
    expect(emitWebhooks).not.toHaveBeenCalled()
  })

  it('refuses a billed entry without a write or webhook', async () => {
    expect(invoke('entries:stopAt', 1, idleSince).ok).toBe(true)
    await createRun(db, { clientId: 1, fromIso: '2026-06-01', toIso: '2026-06-30' }, async () =>
      Buffer.from('pdf')
    )
    const before = readEntry(db, 1)!
    expect(before.billed).toBe(true)
    vi.mocked(emitWebhooks).mockClear()
    expect(invoke('entries:stopAt', 1, idleSince).ok).toBe(false)
    expect(readEntry(db, 1)).toEqual(before)
    expect(emitWebhooks).not.toHaveBeenCalled()
  })
})
