import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import type { IpcResult } from '../shared/types'
import { registerIpcHandlers, type IpcHooks } from './ipc'

const { handlers, dbRef } = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: unknown, ...args: unknown[]) => IpcResult<unknown> | Promise<IpcResult<unknown>>
  >(),
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
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
beforeEach(() => {
  db = new Sqlite(':memory:')
  applyMigrations(db)
  dbRef.current = db
  handlers.clear()
  registerIpcHandlers({} as IpcHooks)
})
afterEach(() => db.close())

function contacts(): string[] {
  const client = db.prepare('INSERT INTO clients (name, contact_person, active) VALUES (?, ?, ?)')
  client.run('A', ' Zoe ', 1)
  client.run('B', 'anna', 0)
  client.run('C', '', 1)
  client.run('D', '   ', 1)
  db.prepare('INSERT INTO projects (client_id, name, contact_person) VALUES (1, ?, ?)').run(
    'P',
    'Anna'
  )
  db.prepare('INSERT INTO projects (client_id, name, contact_person) VALUES (1, ?, ?)').run(
    'Q',
    ' Bärbel '
  )
  db.prepare('INSERT INTO projects (client_id, name) VALUES (1, ?)').run('R')
  return ['Zoe', 'anna', 'Bärbel'].sort((a, b) => a.localeCompare(b))
}

describe('feedback rules storage and master names', () => {
  it('reads trimmed, non-empty, case-insensitively unique contact persons from both tables in locale order', async () => {
    const { readMasterNames } = await import('./feedbackRules')
    expect(readMasterNames(db)).toEqual([])
    const expected = contacts()
    expect(readMasterNames(db)).toEqual(expected)
  })

  it('exposes names through a read-only IPC result', async () => {
    const expected = contacts()
    const before = db.prepare('SELECT total_changes() AS n').get()
    expect(handlers.has('feedbackRules:names')).toBe(true)
    expect(await handlers.get('feedbackRules:names')!(null)).toEqual({ ok: true, data: expected })
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
  })

  it('round trips feedback_rules through settings:set and settings:getAll without migration', async () => {
    const value = JSON.stringify({ prefixes: ['IT'], separator: '|', forbidden: ['secret'] })
    expect(
      db.prepare("SELECT value FROM settings WHERE key = 'feedback_rules'").get()
    ).toBeUndefined()
    expect(await handlers.get('settings:set')!(null, 'feedback_rules', value)).toEqual({
      ok: true,
      data: undefined
    })
    expect(await handlers.get('settings:getAll')!(null)).toMatchObject({
      ok: true,
      data: { feedback_rules: value }
    })
  })
})
