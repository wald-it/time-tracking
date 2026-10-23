/**
 * handleCsvExport's save dialog follows the app language (#270). The
 * formatter itself is covered in shared/csv.test.ts.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'

// Cancelled save dialog: the handler stops right after it, nothing is written.
vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: '' })) }
}))

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

describe('handleCsvExport', () => {
  it('titles the save dialog in the app language', async () => {
    const db: Database.Database = new DatabaseImpl(':memory:')
    applyMigrations(db)
    db.prepare(
      `INSERT INTO clients (id, name, color, active, rate_cent) VALUES (1,'Acme','#111',1,0)`
    ).run()
    const { dialog } = await import('electron')
    const { handleCsvExport } = await import('./csvExport')
    const req = { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }
    await handleCsvExport(db, req)
    db.prepare(`UPDATE settings SET value = 'en' WHERE key = 'language'`).run()
    const res = await handleCsvExport(db, req)
    expect(res).toEqual({ ok: false, error: 'Export abgebrochen' })
    const titles = vi
      .mocked(dialog.showSaveDialog)
      .mock.calls.map((c) => (c[0] as Electron.SaveDialogOptions).title)
    expect(titles).toEqual(['CSV speichern', 'Save CSV'])
    db.close()
  })
})
