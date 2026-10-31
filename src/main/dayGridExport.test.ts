import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import { createRun } from './billingRuns'
import { handleDayGridExport } from './csvExport'

const mocks = vi.hoisted(() => ({ save: vi.fn(), write: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPreferredSystemLanguages: () => ['de-DE'] },
  dialog: { showSaveDialog: mocks.save }
}))
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  writeFileSync: mocks.write
}))
let Ctor: DatabaseCtor
let db: Database.Database
const req = { clientId: 1, projectId: 1, fromIso: '2026-10-01', toIso: '2026-10-31' }
const at = (day: number, hour: number): string => new Date(2026, 9, day, hour).toISOString()
beforeAll(async () => {
  Ctor = await loadSqlite()
})
beforeEach(() => {
  vi.resetAllMocks()
  mocks.save.mockResolvedValue({ canceled: false, filePath: 'C:\\exports\\days.csv' })
  db = new Ctor(':memory:')
  applyMigrations(db)
  db.exec(`INSERT INTO clients (id, name, rate_cent, short_code) VALUES (1, 'Client', 6000, 'ABC');
    INSERT INTO projects (id, client_id, name) VALUES (1, 1, 'Project')`)
  seedEntry(db, {
    client_id: 1,
    project_id: 1,
    description: '=SUM("x");\nquoted',
    started_at: at(1, 8),
    stopped_at: new Date(2026, 9, 1, 8, 30).toISOString()
  })
  seedEntry(db, {
    client_id: 1,
    project_id: 1,
    description: 'Other, work',
    started_at: at(1, 9),
    stopped_at: at(1, 10)
  })
  seedEntry(db, {
    client_id: 1,
    project_id: 1,
    description: 'Hidden',
    billable: 0,
    started_at: at(2, 9),
    stopped_at: at(2, 10)
  })
})
afterEach(() => db.close())

describe('day grid CSV export', () => {
  it.each(['de', 'en'])(
    'saves %s CSV with the shared escaping and includes billed time',
    async (locale) => {
      db.prepare("UPDATE settings SET value = ? WHERE key = 'language'").run(locale)
      await createRun(db, req, async () => Buffer.from('pdf'))
      expect(await handleDayGridExport(db, req)).toEqual({
        ok: true,
        data: { path: 'C:\\exports\\days.csv' }
      })
      const csv =
        locale === 'de'
          ? '\uFEFFDatum;Stunden;Tätigkeit\r\n2026-10-01;1,50;"\'=SUM(""x"");\nquoted; Other, work"\r\n'
          : '\uFEFFDate,Hours,Activity\r\n2026-10-01,1.50,"\'=SUM(""x"");\nquoted; Other, work"\r\n'
      expect(mocks.write).toHaveBeenCalledExactlyOnceWith('C:\\exports\\days.csv', csv, 'utf8')
      expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
        title: locale === 'de' ? 'Tagesraster speichern' : 'Save day grid',
        defaultPath:
          locale === 'de'
            ? 'Tagesraster-Client-Project-2026-10.csv'
            : 'Day-grid-Client-Project-2026-10.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      })
      const setting = db
        .prepare("SELECT value FROM settings WHERE key = 'export_folders'")
        .get() as { value: string }
      expect(JSON.parse(setting.value)).toEqual({ csv: 'C:\\exports' })
    }
  )
  it('returns cancellation without writing or remembering a folder', async () => {
    mocks.save.mockResolvedValue({ canceled: true })
    const before = db.prepare('SELECT total_changes() AS n').get()
    expect(await handleDayGridExport(db, req)).toMatchObject({ ok: false, code: 'cancelled' })
    expect(mocks.write).not.toHaveBeenCalled()
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
  })
  it('validates the selection before opening a dialog', async () => {
    for (const input of [
      null,
      {},
      { ...req, clientId: 0 },
      { ...req, projectId: -1 },
      { ...req, fromIso: '2026-02-30' },
      { ...req, fromIso: '2026-11-01' },
      { ...req, clientId: 999 },
      { ...req, projectId: 999 }
    ]) {
      expect(await handleDayGridExport(db, input as typeof req)).toMatchObject({
        ok: false,
        error: expect.any(String)
      })
    }
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('reports write failures without remembering a successful export', async () => {
    mocks.write.mockImplementation(() => {
      throw new Error('Disk full')
    })
    const before = db.prepare('SELECT total_changes() AS n').get()
    expect(await handleDayGridExport(db, req)).toEqual({ ok: false, error: 'Disk full' })
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
  })
})
