import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import type { Client, CreateClientInput, IpcResult, UpdateClientInput } from '../shared/types'
import { registerIpcHandlers, type IpcHooks } from './ipc'
import { writeEntry } from './entryMutations'

const { handlers, dbRef } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => IpcResult<Client>>(),
  dbRef: { current: undefined as Database.Database | undefined }
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
vi.mock('./db', () => ({ getDb: () => dbRef.current, getDbPath: () => 'test.sqlite' }))

let Sqlite: DatabaseCtor
let db: Database.Database
const refreshTrayClients = vi.fn()
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
beforeEach(() => {
  db = new Sqlite(':memory:')
  applyMigrations(db)
  dbRef.current = db
  handlers.clear()
  refreshTrayClients.mockClear()
  registerIpcHandlers({ refreshTrayClients } as unknown as IpcHooks)
})
afterEach(() => db.close())

const create = (short_code?: unknown): IpcResult<Client> =>
  handlers.get('clients:create')!(null, { name: 'Client', color: '#123456', short_code })
const update = (id: number, patch: object = {}): IpcResult<Client> =>
  handlers.get('clients:update')!(null, {
    id,
    name: 'Renamed',
    color: '#654321',
    active: 1,
    ...patch
  } satisfies UpdateClientInput)
function saved(result: IpcResult<Client>): Client {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error)
  return result.data
}

describe('client short codes through the registered IPC handlers', () => {
  it.each(['a', 'ab12cd34', '  acme7  '])('normalises and persists %j', (value) => {
    const client = saved(create(value))
    expect(client.short_code).toBe(value.trim().toUpperCase())
    expect(db.prepare('SELECT short_code FROM clients WHERE id = ?').get(client.id)).toEqual({
      short_code: value.trim().toUpperCase()
    })
  })

  it.each(['123456789', 'AC-ME', 'A B', 'Ä', 'AB\nCD', 123])(
    'rejects invalid code %j before writing',
    (value) => {
      const result = create(value)
      expect(result).toEqual({
        ok: false,
        error: expect.stringMatching(/Kurzcode.*1.*8.*A.Z.*0.9/)
      })
      expect(db.prepare('SELECT count(*) AS n FROM clients').get()).toEqual({ n: 0 })
      expect(refreshTrayClients).not.toHaveBeenCalled()
    }
  )

  it('rejects duplicates on create and update, including archived clients', () => {
    const owner = saved(create('ABC'))
    update(owner.id, { active: 0 })
    const other = saved(create('XYZ'))
    for (const result of [create(' abc '), update(other.id, { short_code: 'abc' })]) {
      expect(result).toEqual({
        ok: false,
        error: expect.stringMatching(/Kurzcode.*anderen Kunden/)
      })
    }
    expect(db.prepare('SELECT name, short_code FROM clients WHERE id = ?').get(other.id)).toEqual({
      name: 'Client',
      short_code: 'XYZ'
    })
  })

  it('changes codes, accepts the same code and preserves an omitted field', () => {
    const client = saved(create('ABC'))
    expect(saved(update(client.id, { short_code: ' abc ' })).short_code).toBe('ABC')
    expect(saved(update(client.id, { short_code: ' xyz ' })).short_code).toBe('XYZ')
    expect(saved(update(client.id)).short_code).toBe('XYZ')
    expect(update(client.id, { short_code: 'A-B' }).ok).toBe(false)
    expect(saved(update(client.id)).short_code).toBe('XYZ')
  })

  it.each([null, '', '   '])('clears with %j and makes the code available again', (value) => {
    const client = saved(create('ABC'))
    expect(saved(update(client.id, { short_code: value })).short_code).toBeNull()
    expect(saved(create('ABC')).short_code).toBe('ABC')
    expect(saved(create(value)).short_code).toBeNull()
  })

  it('allows creating clients without a code', () => {
    const input: CreateClientInput = { name: 'Without code', color: '#123456' }
    expect(saved(handlers.get('clients:create')!(null, input)).short_code).toBeNull()
  })
})

describe('client and project lists flag a refused delete (#452)', () => {
  it('marks the records an entry version points at, a deleted entry included', () => {
    const used = saved(create('USED'))
    const free = saved(create('FREE'))
    const project = (client_id: number, name: string): number =>
      Number(
        db
          .prepare(`INSERT INTO projects (client_id, name, status, active) VALUES (?, ?, 'active', 1)`)
          .run(client_id, name).lastInsertRowid
      )
    const usedProject = project(used.id, 'Used')
    const freeProject = project(used.id, 'Free')
    const r = writeEntry(
      db,
      {
        op: 'create',
        fields: {
          client_id: used.id,
          project_id: usedProject,
          description: 'x',
          started_at: '2026-06-10T08:00:00.000Z',
          stopped_at: '2026-06-10T09:00:00.000Z'
        }
      },
      { source: 'app' }
    )
    if (!r.ok) throw new Error(r.error)
    writeEntry(db, { op: 'delete', id: r.data.id }, { source: 'app' })

    const list = <T extends { id: number; has_entry_versions?: number }>(
      channel: string,
      arg?: unknown
    ): Record<number, number | undefined> => {
      const res = handlers.get(channel)!(null, arg) as unknown as IpcResult<T[]>
      if (!res.ok) throw new Error(res.error)
      return Object.fromEntries(res.data.map((x) => [x.id, x.has_entry_versions]))
    }
    expect(list('clients:getAll')).toEqual({ [used.id]: 1, [free.id]: 0 })
    expect(list('projects:getAll', { clientId: used.id })).toEqual({
      [usedProject]: 1,
      [freeProject]: 0
    })
  })
})
