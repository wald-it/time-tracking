/**
 * #269 — save dialogs start in the folder last used for the same export type.
 *
 * Since Electron 43 the dialog itself opens in Downloads every time, so this
 * module is the only thing that keeps a monthly export landing where the user
 * filed the last one.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import log from 'electron-log/main'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { EXPORT_FOLDERS_SETTING, exportDefaultPath, rememberExportFolder } from './exportFolders'
import { RENDERER_WRITABLE_SETTINGS } from './settingsWrite'
import { buildJsonExportPayload } from './jsonExport'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

describe('export folders', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-export-folders-'))
    db = new DatabaseImpl(join(tmpDir, 'test.sqlite'))
    applyMigrations(db)
  })

  afterEach(() => {
    db?.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('suggests the bare file name when no folder is remembered', async () => {
    expect(await exportDefaultPath(db, 'pdf', 'Stundennachweis.pdf')).toBe('Stundennachweis.pdf')
  })

  it('suggests the file inside the folder of the last export of the same type', async () => {
    const invoices = join(tmpDir, 'Rechnungen')
    mkdirSync(invoices)
    rememberExportFolder(db, 'pdf', join(invoices, 'Stundennachweis-Acme-2026-09.pdf'))
    expect(await exportDefaultPath(db, 'pdf', 'Stundennachweis-Acme-2026-10.pdf')).toBe(
      join(invoices, 'Stundennachweis-Acme-2026-10.pdf')
    )
  })

  it('keeps one folder per export type', async () => {
    const pdfDir = join(tmpDir, 'pdf')
    const csvDir = join(tmpDir, 'csv')
    mkdirSync(pdfDir)
    mkdirSync(csvDir)
    rememberExportFolder(db, 'pdf', join(pdfDir, 'a.pdf'))
    rememberExportFolder(db, 'csv', join(csvDir, 'a.csv'))
    expect(await exportDefaultPath(db, 'pdf', 'b.pdf')).toBe(join(pdfDir, 'b.pdf'))
    expect(await exportDefaultPath(db, 'csv', 'b.csv')).toBe(join(csvDir, 'b.csv'))
    expect(await exportDefaultPath(db, 'ical', 'b.ics')).toBe('b.ics')
    expect(await exportDefaultPath(db, 'json', 'b.json')).toBe('b.json')
  })

  it('survives a restart: the folder lives in the database', async () => {
    const dir = join(tmpDir, 'exports')
    mkdirSync(dir)
    rememberExportFolder(db, 'json', join(dir, 'export.json'))
    db.close()
    db = new DatabaseImpl(join(tmpDir, 'test.sqlite'))
    expect(await exportDefaultPath(db, 'json', 'next.json')).toBe(join(dir, 'next.json'))
  })

  it('falls back to the bare file name when the remembered folder is gone', async () => {
    const usb = join(tmpDir, 'usb-stick')
    mkdirSync(usb)
    rememberExportFolder(db, 'csv', join(usb, 'a.csv'))
    rmSync(usb, { recursive: true })
    expect(await exportDefaultPath(db, 'csv', 'b.csv')).toBe('b.csv')
  })

  it('ignores a damaged or foreign setting value', async () => {
    const set = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    for (const value of ['not json', '[]', 'null', JSON.stringify({ pdf: 'relative/dir' })]) {
      set.run(EXPORT_FOLDERS_SETTING, value)
      expect(await exportDefaultPath(db, 'pdf', 'a.pdf')).toBe('a.pdf')
    }
    // A damaged value does not block remembering the next folder either.
    set.run(EXPORT_FOLDERS_SETTING, 'not json')
    rememberExportFolder(db, 'pdf', join(tmpDir, 'a.pdf'))
    expect(await exportDefaultPath(db, 'pdf', 'b.pdf')).toBe(join(tmpDir, 'b.pdf'))
  })

  it('is written by the main process only, not through settings:set', () => {
    expect(RENDERER_WRITABLE_SETTINGS.has(EXPORT_FOLDERS_SETTING)).toBe(false)
  })

  it('stays out of the JSON data export (local paths that name clients)', () => {
    const dir = join(tmpDir, 'Kunden', 'Acme')
    mkdirSync(dir, { recursive: true })
    rememberExportFolder(db, 'pdf', join(dir, 'a.pdf'))
    const keys = buildJsonExportPayload(db, '0.0.0').settings.map((s) => s.key)
    expect(keys).not.toContain(EXPORT_FOLDERS_SETTING)
  })

  it('a failed settings write does not fail the export it follows, and is logged', () => {
    // The export file is already written when the folder is remembered; a
    // database that refuses the write must not turn that into an error.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      db.exec(`CREATE TRIGGER no_settings_writes BEFORE INSERT ON settings
               BEGIN SELECT RAISE(ABORT, 'read-only for this test'); END`)
      expect(() => rememberExportFolder(db, 'csv', join(tmpDir, 'a.csv'))).not.toThrow()
      expect(warn).toHaveBeenCalledWith(
        '[export] could not remember the csv export folder:',
        expect.anything()
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('an unreadable setting gives the bare file name instead of failing the export', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      db.close()
      expect(await exportDefaultPath(db, 'csv', 'a.csv')).toBe('a.csv')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      db = new DatabaseImpl(join(tmpDir, 'test.sqlite'))
    }
  })
})

describe('export save dialogs use the remembered folder', () => {
  // Checked as text: the dialogs need Electron. The merged-PDF dialog in
  // pdfMergeHandlers.ts is left out on purpose — it only appears when the
  // invoice's own folder is read-only, so the last folder is the wrong start.
  const kinds = (source: string, call: string): string[] =>
    [...source.matchAll(new RegExp(`${call}\\(\\s*db,\\s*'([a-z]+)'`, 'g'))].map((m) => m[1]).sort()

  it.each([
    ['csvExport.ts', ['csv']],
    ['icalExport.ts', ['ical']],
    ['ipc.ts', ['json', 'pdf']]
  ])('%s', (file, expected) => {
    const source = readFileSync(join(__dirname, file), 'utf8')
    expect(source.split('dialog.showSaveDialog(').length - 1).toBe(expected.length)
    expect(source.split('defaultPath: await exportDefaultPath(').length - 1).toBe(expected.length)
    // Each dialog reads and remembers the folder of its own export type.
    expect(kinds(source, 'exportDefaultPath')).toEqual(expected)
    expect(kinds(source, 'rememberExportFolder')).toEqual(expected)
  })
})
