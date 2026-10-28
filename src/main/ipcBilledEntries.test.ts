import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { localDateOf, seedEntry } from '../test/entryFixtures'
import type { DashboardSummary, Entry, IpcResult } from '../shared/types'
import { createRun, releaseRun } from './billingRuns'
import { BILLED_ENTRY_ERROR, updateManualEntry } from './entryMutations'
import { registerIpcHandlers, type IpcHooks } from './ipc'

const { handlers, state } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => IpcResult<unknown>>(),
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

let Sqlite: DatabaseCtor
let db: Database.Database
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
beforeEach(() => {
  db = new Sqlite(':memory:')
  applyMigrations(db)
  db.exec("INSERT INTO clients (id, name, rate_cent, short_code) VALUES (1, 'Client', 6000, 'ABC')")
  seedEntry(db, {
    id: 1,
    client_id: 1,
    started_at: '2026-06-10T10:00:00.000Z',
    stopped_at: '2026-06-10T11:00:00.000Z'
  })
  state.db = db
  handlers.clear()
  registerIpcHandlers({} as IpcHooks)
})
afterEach(() => {
  db.close()
})
const invoke = (channel: string, ...args: unknown[]): IpcResult<unknown> =>
  handlers.get(channel)!(null, ...args)
const run = (): ReturnType<typeof createRun> =>
  createRun(db, { clientId: 1, fromIso: '2026-06-01', toIso: '2026-06-30' }, async () =>
    Buffer.from('pdf')
  )

describe('P6c billed entries through IPC', () => {
  it('requires separate reasons for delete and restore and records both in the versions', async () => {
    const billed = await run()
    for (const reason of [undefined, '', '   ']) {
      expect(invoke('entries:delete', 1, reason)).toEqual({
        ok: false,
        error: BILLED_ENTRY_ERROR + billed.number
      })
    }
    expect(invoke('entries:delete', 1, 'Correction')).toMatchObject({ ok: true })
    for (const reason of [undefined, '', '   ']) {
      expect(invoke('entries:undelete', 1, reason)).toEqual({
        ok: false,
        error: BILLED_ENTRY_ERROR + billed.number
      })
    }
    expect(invoke('entries:undelete', 1, 'Keep the work')).toMatchObject({ ok: true })
    expect(
      db.prepare('SELECT reason FROM entry_version WHERE entry_id = 1 ORDER BY version_no').all()
    ).toEqual([{ reason: null }, { reason: 'Correction' }, { reason: 'Keep the work' }])
  })

  it('exposes entry-wide billed state after correction, and clears it on release', async () => {
    seedEntry(db, {
      id: 2,
      client_id: 1,
      segments: [
        {
          started_at: '2026-06-30T21:00:00.000Z',
          stopped_at: '2026-06-30T22:00:00.000Z',
          segment_date: '2026-06-30'
        },
        {
          started_at: '2026-06-30T22:00:00.000Z',
          stopped_at: '2026-07-01T01:00:00.000Z',
          segment_date: '2026-07-01'
        }
      ]
    })
    const billed = await run()
    expect(
      updateManualEntry(db, { id: 2, description: 'Corrected', reason: 'Correction' }).ok
    ).toBe(true)
    const rows = (): Entry[] => {
      const result = invoke('entries:getByMonth', { year: 2026, month: 7 })
      if (!result.ok) throw new Error(result.error)
      return result.data as Entry[]
    }
    expect(rows().filter((e) => e.id === 2)).toEqual([expect.objectContaining({ billed: 1 })])
    releaseRun(db, billed.id, 'Release')
    expect(rows().filter((e) => e.id === 2)).toEqual([expect.objectContaining({ billed: 0 })])
    expect(invoke('entries:delete', 1).ok).toBe(true)
    expect(invoke('entries:undelete', 1).ok).toBe(true)
  })

  it('supplies the billed flag to Today and permits note-only updates without a reason', async () => {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const stop = new Date(start.getTime() + 60_000)
    seedEntry(db, {
      id: 3,
      client_id: 1,
      started_at: start.toISOString(),
      stopped_at: stop.toISOString()
    })
    const day = localDateOf(start.toISOString())
    const billed = await createRun(db, { clientId: 1, fromIso: day, toIso: day }, async () =>
      Buffer.from('pdf')
    )
    const todayRows = (): Entry[] => {
      const summary = invoke('dashboard:summary')
      if (!summary.ok) throw new Error(summary.error)
      return (summary.data as DashboardSummary).todayEntries
    }
    expect(todayRows().find((e) => e.id === 3)).toMatchObject({ billed: 1 })
    expect(invoke('entries:update', { id: 3, private_note: 'Internal' }).ok).toBe(true)
    expect(invoke('entries:update', { id: 3, description: 'Changed' })).toEqual({
      ok: false,
      error: BILLED_ENTRY_ERROR + billed.number
    })
    expect(
      invoke('entries:update', { id: 3, description: 'Changed', reason: 'Correct description' }).ok
    ).toBe(true)
    expect(todayRows().find((e) => e.id === 3)).toMatchObject({
      billed: 1,
      private_note: 'Internal'
    })
    releaseRun(db, billed.id, 'Release')
    expect(todayRows().find((e) => e.id === 3)).toMatchObject({ billed: 0 })
  })
})
