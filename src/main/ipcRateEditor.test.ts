import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import type { IpcResult } from '../shared/types'
import { RATE_EDITOR_CONFLICT_ERROR, type RateEditorData } from '../shared/rateEditor'
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
  app: {},
  shell: {},
  dialog: {}
}))
vi.mock('./db', () => ({ getDb: () => state.db, getDbPath: () => 'test.sqlite' }))
let Sqlite: DatabaseCtor
let db: Database.Database
const refreshTrayClients = vi.fn()
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
beforeEach(() => {
  db = new Sqlite(':memory:')
  applyMigrations(db)
  db.exec(
    "INSERT INTO clients (id, name, rate_cent) VALUES (1, 'A', 6000); INSERT INTO projects (id, client_id, name, rate_cent) VALUES (10, 1, 'P', 7000)"
  )
  state.db = db
  handlers.clear()
  refreshTrayClients.mockClear()
  registerIpcHandlers({ refreshTrayClients } as unknown as IpcHooks)
})
afterEach(() => db.close())
const invoke = (channel: string, ...args: unknown[]): IpcResult<unknown> =>
  handlers.get(channel)!(null, ...args)
describe('rate and profile IPC', () => {
  it('lists, saves and deletes owned rate rows and returns the current rate', () => {
    const target = { kind: 'client', id: 1 }
    expect(invoke('rates:list', target)).toMatchObject({
      ok: true,
      data: { current_rate_cent: 6000, rows: [{ valid_from: '0001-01-01', rate_cent: 6000 }] }
    })
    const result = invoke('rates:save', target, {
      valid_from: '2020-01-01',
      rate_cent: 9000
    }) as IpcResult<RateEditorData>
    expect(result).toMatchObject({ ok: true, data: { current_rate_cent: 9000 } })
    if (!result.ok) throw new Error(result.error)
    expect(invoke('rates:delete', target, result.data.rows[1].id)).toMatchObject({
      ok: true,
      data: { current_rate_cent: 6000 }
    })
    expect(refreshTrayClients).toHaveBeenCalledTimes(2)
  })
  it('reports a legacy conflict and allows a name change without adding rows', () => {
    const today = (db.prepare("SELECT date('now', 'localtime') AS day").get() as { day: string })
      .day
    invoke('rates:save', { kind: 'client', id: 1 }, { valid_from: today, rate_cent: 9000 })
    const input = { id: 1, name: 'Renamed', color: '#123456', active: 1, rate_cent: 10000 }
    expect(invoke('clients:update', input)).toEqual({
      ok: false,
      error: 'SqliteError: ' + RATE_EDITOR_CONFLICT_ERROR
    })
    expect(invoke('clients:update', { ...input, rate_cent: 9000 })).toMatchObject({
      ok: true,
      data: { name: 'Renamed' }
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM rate WHERE client_id = 1').get()).toEqual({ n: 2 })
  })
  it('validates IPC arguments and reads inheritance for the profile', () => {
    const client = { kind: 'client', id: 1 },
      project = { kind: 'project', id: 10 }
    expect(
      invoke('billing-profile:save', client, { interval_min: 15, min_unit_min: 30 })
    ).toMatchObject({ ok: true })
    expect(
      invoke('billing-profile:save', project, { interval_min: null, min_unit_min: 0 })
    ).toMatchObject({ ok: true, data: { interval_min: null, min_unit_min: 0 } })
    expect(invoke('billing-profile:get', project)).toMatchObject({
      ok: true,
      data: { inherited: { interval_min: 15, min_unit_min: 30 } }
    })
    for (const [channel, args] of [
      ['rates:list', [null]],
      ['rates:list', [{ kind: 'default', id: 1 }]],
      ['rates:save', [client, { valid_from: '2026-02-30', rate_cent: 1 }]],
      ['rates:delete', [project, 1]],
      ['billing-profile:save', [client, { interval_min: 61, min_unit_min: 0 }]],
      ['billing-profile:save', [project, { interval_min: 0, min_unit_min: -1 }]],
      ['billing-profile:save', [null, { interval_min: 0, min_unit_min: 0 }]]
    ] as const)
      expect(invoke(channel, ...args)).toMatchObject({ ok: false })
  })
})
