/**
 * #269 — save dialogs start in the folder last used for the same export type.
 *
 * Since Electron 43 the dialog itself opens in Downloads every time, so this
 * module is the only thing that keeps a monthly export landing where the user
 * filed the last one.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { EXPORT_FOLDERS_SETTING, exportDefaultPath, rememberExportFolder } from './exportFolders'
import { RENDERER_WRITABLE_SETTINGS } from './settingsWrite'
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

  it('suggests the bare file name when no folder is remembered', () => {
    expect(exportDefaultPath(db, 'pdf', 'Stundennachweis.pdf')).toBe('Stundennachweis.pdf')
  })

  it('suggests the file inside the folder of the last export of the same type', () => {
    const invoices = join(tmpDir, 'Rechnungen')
    mkdirSync(invoices)
    rememberExportFolder(db, 'pdf', join(invoices, 'Stundennachweis-Acme-2026-09.pdf'))
    expect(exportDefaultPath(db, 'pdf', 'Stundennachweis-Acme-2026-10.pdf')).toBe(
      join(invoices, 'Stundennachweis-Acme-2026-10.pdf')
    )
  })

  it('keeps one folder per export type', () => {
    const pdfDir = join(tmpDir, 'pdf')
    const csvDir = join(tmpDir, 'csv')
    mkdirSync(pdfDir)
    mkdirSync(csvDir)
    rememberExportFolder(db, 'pdf', join(pdfDir, 'a.pdf'))
    rememberExportFolder(db, 'csv', join(csvDir, 'a.csv'))
    expect(exportDefaultPath(db, 'pdf', 'b.pdf')).toBe(join(pdfDir, 'b.pdf'))
    expect(exportDefaultPath(db, 'csv', 'b.csv')).toBe(join(csvDir, 'b.csv'))
    expect(exportDefaultPath(db, 'ical', 'b.ics')).toBe('b.ics')
    expect(exportDefaultPath(db, 'json', 'b.json')).toBe('b.json')
  })

  it('survives a restart: the folder lives in the database', () => {
    const dir = join(tmpDir, 'exports')
    mkdirSync(dir)
    rememberExportFolder(db, 'json', join(dir, 'export.json'))
    db.close()
    db = new DatabaseImpl(join(tmpDir, 'test.sqlite'))
    expect(exportDefaultPath(db, 'json', 'next.json')).toBe(join(dir, 'next.json'))
  })

  it('falls back to the bare file name when the remembered folder is gone', () => {
    const usb = join(tmpDir, 'usb-stick')
    mkdirSync(usb)
    rememberExportFolder(db, 'csv', join(usb, 'a.csv'))
    rmSync(usb, { recursive: true })
    expect(exportDefaultPath(db, 'csv', 'b.csv')).toBe('b.csv')
  })

  it('ignores a damaged or foreign setting value', () => {
    const set = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    for (const value of ['not json', '[]', 'null', JSON.stringify({ pdf: 'relative/dir' })]) {
      set.run(EXPORT_FOLDERS_SETTING, value)
      expect(exportDefaultPath(db, 'pdf', 'a.pdf')).toBe('a.pdf')
    }
    // A damaged value does not block remembering the next folder either.
    set.run(EXPORT_FOLDERS_SETTING, 'not json')
    rememberExportFolder(db, 'pdf', join(tmpDir, 'a.pdf'))
    expect(exportDefaultPath(db, 'pdf', 'b.pdf')).toBe(join(tmpDir, 'b.pdf'))
  })

  it('is written by the main process only, not through settings:set', () => {
    expect(RENDERER_WRITABLE_SETTINGS.has(EXPORT_FOLDERS_SETTING)).toBe(false)
  })
})

describe('export save dialogs use the remembered folder', () => {
  // Checked as text: the dialogs need Electron. The merged-PDF dialog in
  // pdfMergeHandlers.ts is left out on purpose — it only appears when the
  // invoice's own folder is read-only, so the last folder is the wrong start.
  it.each(['csvExport.ts', 'icalExport.ts', 'ipc.ts'])('%s', (file) => {
    const source = readFileSync(join(__dirname, file), 'utf8')
    const dialogs = source.split('dialog.showSaveDialog(').length - 1
    expect(dialogs).toBeGreaterThan(0)
    expect(source.split('defaultPath: exportDefaultPath(').length - 1).toBe(dialogs)
    expect(source.split('rememberExportFolder(db, ').length - 1).toBe(dialogs)
  })
})
