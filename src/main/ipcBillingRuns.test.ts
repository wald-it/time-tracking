import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import type { IpcResult } from '../shared/types'
import { createRun, releaseRun } from './billingRuns'
import { registerIpcHandlers, type IpcHooks } from './ipc'

const { handlers, state, openPath } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<IpcResult<unknown>>>(),
  state: { db: undefined as Database.Database | undefined, tempDir: '' },
  openPath: vi.fn<(path: string) => Promise<string>>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: never) => handlers.set(channel, handler),
    on: vi.fn()
  },
  app: { getPath: () => state.tempDir, getVersion: () => '2.0' },
  shell: { openPath },
  dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: join(state.tempDir, 'export.pdf') })
  }
}))
vi.mock('./db', () => ({ getDb: () => state.db, getDbPath: () => 'test.sqlite' }))
vi.mock('./pdfWindow', () => ({ renderPdfBuffer: async () => Buffer.from('archived-pdf') }))

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
    started_at: '2026-10-27T10:00:00.000Z',
    stopped_at: '2026-10-27T10:04:00.000Z'
  })
  state.db = db
  state.tempDir = mkdtempSync(join(tmpdir(), 'timetrack-ipc-runs-test-'))
  openPath.mockReset().mockResolvedValue('')
  handlers.clear()
  registerIpcHandlers({} as IpcHooks)
})
afterEach(() => {
  db.close()
  rmSync(state.tempDir, { recursive: true, force: true })
})
const req = { clientId: 1, fromIso: '2026-10-01', toIso: '2026-10-31', markAsBilled: true }
const run = (): ReturnType<typeof createRun> =>
  createRun(db, req, async () => Buffer.from('archived-pdf'))
const invoke = (channel: string, ...args: unknown[]): Promise<IpcResult<unknown>> =>
  handlers.get(channel)!(null, ...args)

describe('P6b billing run IPC', () => {
  it.each(['invalid', '', null, 1, false, {}])(
    'rejects invalid PDF columns %j',
    async (columns) => {
      expect(await invoke('pdf:export', { ...req, columns })).toEqual({
        ok: false,
        error: 'Ungültige PDF-Spaltenauswahl'
      })
      expect(db.prepare('SELECT id FROM billing_run').all()).toEqual([])
    }
  )

  it('exports the run number together with its id and exclusion count', async () => {
    expect(await invoke('pdf:export', req)).toEqual({
      ok: true,
      data: {
        path: join(state.tempDir, 'export.pdf'),
        runId: 1,
        runNumber: 'SN-2026-10-ABC-01',
        excludedCount: 0
      }
    })
  })

  it.each(['de', 'en'])(
    'returns a localised pointer to Clients for a missing code (%s)',
    async (language) => {
      db.exec('UPDATE clients SET short_code = NULL WHERE id = 1')
      db.prepare(
        "INSERT INTO settings (key, value) VALUES ('language', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(language)
      expect(await invoke('pdf:export', req)).toEqual({
        ok: false,
        error:
          language === 'en'
            ? 'This client has no short code yet. Add one under Clients, then the run works.'
            : 'Dieser Kunde hat noch keinen Kurzcode. Trage ihn unter Kunden ein, dann geht der Lauf.'
      })
    }
  )

  it('opens exact archive bytes in the system viewer, including after release', async () => {
    const created = await run()
    for (const status of ['active', 'released']) {
      if (status === 'released') releaseRun(db, created.id, 'Correction')
      expect(await invoke('billing-runs:open', created.id)).toEqual({ ok: true, data: undefined })
      const path = openPath.mock.lastCall![0]
      expect(path.startsWith(state.tempDir)).toBe(true)
      expect(readFileSync(path)).toEqual(Buffer.from('archived-pdf'))
    }
    expect(openPath).toHaveBeenCalledTimes(2)
  })

  it('refuses a damaged archive before opening a viewer', async () => {
    const created = await run()
    db.exec(
      "DROP TRIGGER trg_billing_run_document_update; UPDATE billing_run_document SET bytes = X'00'"
    )
    expect(await invoke('billing-runs:open', created.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining('SHA-256')
    })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('reports a viewer failure', async () => {
    const created = await run()
    openPath.mockResolvedValueOnce('No PDF viewer')
    expect(await invoke('billing-runs:open', created.id)).toEqual({
      ok: false,
      error: 'No PDF viewer'
    })
    expect(existsSync(openPath.mock.lastCall![0])).toBe(false)
  })

  it('keeps viewer copies in one folder and prunes copies older than a day', async () => {
    const created = await run()
    const dir = join(state.tempDir, 'timetrack-runs')
    mkdirSync(dir, { recursive: true })
    const stale = join(dir, 'run-0-stale.pdf')
    const fresh = join(dir, 'run-0-fresh.pdf')
    writeFileSync(stale, 'old')
    writeFileSync(fresh, 'new')
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(stale, twoDaysAgo, twoDaysAgo)

    await invoke('billing-runs:open', created.id)
    await invoke('billing-runs:open', created.id)

    const [first, second] = openPath.mock.calls.map(([path]) => path)
    expect(first).not.toBe(second)
    expect(readdirSync(dir).sort()).toEqual(
      ['run-0-fresh.pdf', basename(first), basename(second)].sort()
    )
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })
})
