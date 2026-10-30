import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { writeFileSync } from 'node:fs'
import { dialog } from 'electron'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import { handleCsvExport } from './csvExport'

vi.mock('electron', () => ({
  app: { getPreferredSystemLanguages: () => ['de'] },
  dialog: { showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: 'export.csv' })) }
}))
vi.mock('fs', async (original) => ({
  ...(await original<typeof import('fs')>()),
  writeFileSync: vi.fn()
}))

let Sqlite: DatabaseCtor
let db: Database.Database
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
beforeEach(() => {
  vi.clearAllMocks()
  db = new Sqlite(':memory:')
  applyMigrations(db)
  db.exec(`INSERT INTO clients (id, name, rate_cent) VALUES (1, 'Acme', 6000);
    INSERT INTO projects (id, client_id, name) VALUES (1, 1, 'Project');
    INSERT INTO billing_profile (client_id, language) VALUES (1, 'de');
    INSERT INTO billing_profile (project_id, language) VALUES (1, NULL)`)
  for (const id of [1, 2])
    seedEntry(db, {
      id,
      client_id: 1,
      project_id: 1,
      description: 'Work',
      tags: id === 1 ? ',tag,' : '',
      started_at: `2026-10-${19 + id}T09:00:00.000Z`,
      stopped_at: `2026-10-${19 + id}T10:00:00.000Z`
    })
})
afterEach(() => db.close())
const req = { clientId: 1, fromIso: '2026-10-01', toIso: '2026-10-31', groupByTag: true }
async function exported(request = req): Promise<string> {
  expect(await handleCsvExport(db, request)).toEqual({ ok: true, data: { path: 'export.csv' } })
  return vi.mocked(writeFileSync).mock.lastCall![1] as string
}

it.each(['de', 'us'] as const)(
  'translates CSV headers and group labels independently of %s data format and file name',
  async (format) => {
    const request = { ...req, format }
    const german = await exported(request)
    db.exec(`UPDATE billing_profile SET language = 'en' WHERE client_id = 1`)
    const english = await exported(request)
    const sep = format === 'de' ? ';' : ','
    expect(german.split('\r\n')[0]).toBe(
      '\uFEFF' +
        [
          'Datum',
          'Start',
          'Ende',
          'Dauer',
          'Kunde',
          'Beschreibung',
          'Tags',
          'Referenz',
          'Stundensatz',
          'Betrag'
        ].join(sep)
    )
    expect(english.split('\r\n')[0]).toBe(
      '\uFEFF' +
        [
          'Date',
          'Start',
          'End',
          'Duration',
          'Client',
          'Description',
          'Tags',
          'Reference',
          'Hourly rate',
          'Amount'
        ].join(sep)
    )
    expect(english).toContain('[No tag]')
    expect(english).toContain('No tag Σ')
    expect(english).toContain('Σ Total')
    expect(english.slice(english.indexOf('\r\n'))).toBe(
      german
        .slice(german.indexOf('\r\n'))
        .replaceAll('Ohne Tag', 'No tag')
        .replaceAll('Σ Gesamt', 'Σ Total')
    )
    expect(english).toContain(format === 'de' ? '60,00' : '60.00')
    expect(
      vi
        .mocked(dialog.showSaveDialog)
        .mock.calls.map((c) => (c[0] as Electron.SaveDialogOptions).defaultPath)
    ).toEqual(['Zeiterfassung-Acme-2026-10.csv', 'Zeiterfassung-Acme-2026-10.csv'])
  }
)

it('uses the project language only with a project filter and inherits the client otherwise', async () => {
  db.exec(`UPDATE billing_profile SET language = 'en' WHERE project_id = 1`)
  expect(await exported()).toContain('Datum;Start;Ende')
  expect(await exported({ ...req, ...{ projectId: 1 } })).toContain('Date;Start;End')
  db.exec(`UPDATE billing_profile SET language = 'en' WHERE client_id = 1;
    UPDATE billing_profile SET language = NULL WHERE project_id = 1`)
  expect(await exported({ ...req, ...{ projectId: 1 } })).toContain('Date;Start;End')
  db.exec(`UPDATE billing_profile SET language = 'de' WHERE project_id = 1`)
  expect(await exported({ ...req, ...{ projectId: 1 } })).toContain('Datum;Start;Ende')
})
