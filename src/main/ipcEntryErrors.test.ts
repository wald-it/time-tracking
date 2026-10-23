/**
 * #296 part B: the IPC boundary words a refused entry write in the app
 * language. The domain (entryMutations) only returns a code; the MCP side of
 * the same rule is pinned in mcpBridgeLocalTime.test.ts (always German).
 *
 * Drives the real `entries:*` handlers: registerIpcHandlers with Electron and
 * the database module replaced, the handlers captured from ipcMain.handle.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, Handler>())
const state = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    on: () => undefined
  },
  app: {
    getPreferredSystemLanguages: () => ['de-DE'],
    getPath: () => '',
    getAppPath: () => '',
    getVersion: () => '0.0.0'
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./db', () => ({
  getDb: () => state.db,
  getDbPath: () => ':memory:'
}))

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

let db: Database.Database
beforeEach(async () => {
  db = new DatabaseImpl(':memory:')
  applyMigrations(db)
  db.prepare(
    `INSERT INTO clients (id, name, color, active, rate_cent) VALUES (1,'Acme','#111',1,0)`
  ).run()
  state.db = db
  handlers.clear()
  vi.resetModules()
  const { registerIpcHandlers } = await import('./ipc')
  const noop = (): undefined => undefined
  registerIpcHandlers({
    refreshTrayClients: noop,
    refreshTrayLanguage: noop,
    setHotkey: () => ({ ok: true }),
    setAutoStart: noop,
    setIdleThreshold: noop,
    setMiniEnabled: noop,
    setMiniHotkey: () => ({ ok: true }),
    setMcpWriteEnabled: noop,
    setControllerEnabled: noop,
    pokePresence: noop,
    setIcalFeedEnabled: noop,
    restartIcalFeed: noop,
    confirmSensitiveSetting: async () => true,
    forgetMcpApproval: noop
  })
})

function create(client_id: number): unknown {
  return handlers.get('entries:create')!(null, {
    client_id,
    description: '',
    started_at: '2025-10-28T08:00:00.000Z',
    stopped_at: '2025-10-28T09:00:00.000Z'
  })
}

describe('a thrown refusal reaches the renderer as its message (#296)', () => {
  // clients:create throws for a negative rate; the handler used to send
  // `Error: Stundensatz …`, which the onboarding showed as it was.
  const negative = (): unknown =>
    handlers.get('clients:create')!(null, { name: 'X', color: '#000', rate_cent: -1 })

  it('without the Error: prefix, in the app language', () => {
    expect(negative()).toEqual({ ok: false, error: 'Stundensatz darf nicht negativ sein' })
    db.prepare(`UPDATE settings SET value = 'en' WHERE key = 'language'`).run()
    expect(negative()).toEqual({ ok: false, error: 'The hourly rate cannot be negative' })
  })
})

describe('entries:* words a refused write in the app language (#296)', () => {
  it('German by default, as before', () => {
    expect(create(999)).toEqual({ ok: false, error: 'Kunde existiert nicht' })
  })

  it('English with the app set to English', () => {
    db.prepare(`UPDATE settings SET value = 'en' WHERE key = 'language'`).run()
    expect(create(999)).toEqual({ ok: false, error: 'The client does not exist' })
    create(1)
    expect(create(1)).toEqual({
      ok: false,
      error: 'The entry overlaps an existing entry of the same client'
    })
  })
})
