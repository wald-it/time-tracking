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
  it('#424 passes the trimmed reference to the CSV name and rejects overlong input before the dialog', async () => {
    const db = new DatabaseImpl(':memory:')
    try {
      applyMigrations(db)
      db.exec("INSERT INTO clients (id, name) VALUES (1, 'Acme')")
      const { dialog } = await import('electron')
      const { handleCsvExport } = await import('./csvExport')
      const req = { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }
      vi.mocked(dialog.showSaveDialog).mockClear()
      expect(await handleCsvExport(db, { ...req, invoiceRef: 'x'.repeat(65) })).toEqual({
        ok: false,
        error: 'Die Rechnungsnummer darf höchstens 64 Zeichen lang sein.'
      })
      expect(dialog.showSaveDialog).not.toHaveBeenCalled()
      for (const invoiceRef of ['  RE/123  ', '  ', ` ${'x'.repeat(64)} `]) {
        await handleCsvExport(db, { ...req, invoiceRef })
      }
      expect(
        vi
          .mocked(dialog.showSaveDialog)
          .mock.calls.map((c) => (c[0] as Electron.SaveDialogOptions).defaultPath)
      ).toEqual([
        'Zeiterfassung-Acme-2026-04-RE_123.csv',
        'Zeiterfassung-Acme-2026-04.csv',
        `Zeiterfassung-Acme-2026-04-${'x'.repeat(64)}.csv`
      ])
    } finally {
      const { dialog } = await import('electron')
      vi.mocked(dialog.showSaveDialog).mockClear()
      db.close()
    }
  })
  it('titles and names the save dialog in the app language; a cancel is a code', async () => {
    const db: Database.Database = new DatabaseImpl(':memory:')
    applyMigrations(db)
    db.prepare(
      `INSERT INTO clients (id, name, color, active, rate_cent) VALUES (1,'Acme','#111',1,0)`
    ).run()
    db.prepare(
      `INSERT INTO projects (id, client_id, name, status, active) VALUES (10, 1, 'Rollout', 'active', 1)`
    ).run()
    const { dialog } = await import('electron')
    const { handleCsvExport } = await import('./csvExport')
    const req = { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30', projectId: 10 }
    const de = await handleCsvExport(db, req)
    db.prepare(`UPDATE settings SET value = 'en' WHERE key = 'language'`).run()
    const en = await handleCsvExport(db, req)
    expect(de).toEqual({ ok: false, error: 'Export abgebrochen', code: 'cancelled' })
    expect(en).toEqual({ ok: false, error: 'Export cancelled', code: 'cancelled' })
    const opts = vi
      .mocked(dialog.showSaveDialog)
      .mock.calls.map((c) => c[0] as Electron.SaveDialogOptions)
    expect(opts.map((o) => o.title)).toEqual(['CSV speichern', 'Save CSV'])
    expect(opts.map((o) => o.defaultPath)).toEqual([
      'Zeiterfassung-Acme-Rollout-2026-04.csv',
      'Time-entries-Acme-Rollout-2026-04.csv'
    ])
    db.close()
  })
})
