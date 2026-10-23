/**
 * #272 (part A2) — the renderer may only hand back paths the main process
 * gave it: picked PDFs for the merge handlers, the app's own locations and
 * the merged files for the shell helpers.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import {
  MAX_PICKED_PDFS,
  NOT_PICKED_MESSAGE,
  PICKED_PDFS_KEY,
  ShellTargets,
  isPickedPdf,
  pathKey,
  rememberPickedPdf,
  unpickedPdfError
} from './handedOutPaths'
import { RENDERER_WRITABLE_SETTINGS } from './settingsWrite'

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

let db: Database.Database
beforeEach(() => {
  db = new DatabaseImpl(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
})
afterEach(() => {
  db.close()
})

const ROOT = join(__dirname, 'fixture-root')
const INVOICE = join(ROOT, 'Rechnung-2026-10.pdf')
const SHEET = join(ROOT, 'Stundennachweis-2026-10.pdf')
const OTHER = join(ROOT, 'elsewhere', 'other.pdf')

describe('picked PDFs', () => {
  it('knows a picked PDF and nothing else', () => {
    rememberPickedPdf(db, INVOICE)
    expect(isPickedPdf(db, INVOICE)).toBe(true)
    expect(isPickedPdf(db, OTHER)).toBe(false)
    expect(isPickedPdf(db, '')).toBe(false)
    expect(isPickedPdf(db, { path: INVOICE })).toBe(false)
  })

  it('survives a restart: the list lives in the settings table', () => {
    rememberPickedPdf(db, INVOICE)
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(PICKED_PDFS_KEY) as {
      value: string
    }
    expect(JSON.parse(row.value)).toEqual([INVOICE])
  })

  it('compares a path the way the file system does', () => {
    expect(pathKey('C:\\Daten\\A.pdf', 'win32')).toBe(pathKey('c:\\daten\\a.pdf', 'win32'))
    expect(pathKey('/data/A.pdf', 'linux')).not.toBe(pathKey('/data/a.pdf', 'linux'))
  })

  it('keeps the newest picks, once each, up to the cap', () => {
    for (let i = 0; i < MAX_PICKED_PDFS + 5; i++) rememberPickedPdf(db, join(ROOT, `f${i}.pdf`))
    rememberPickedPdf(db, join(ROOT, 'f10.pdf'))
    const list = JSON.parse(
      (
        db.prepare('SELECT value FROM settings WHERE key = ?').get(PICKED_PDFS_KEY) as {
          value: string
        }
      ).value
    ) as string[]
    expect(list).toHaveLength(MAX_PICKED_PDFS)
    expect(list[0]).toBe(join(ROOT, 'f10.pdf'))
    expect(new Set(list).size).toBe(list.length)
    expect(isPickedPdf(db, join(ROOT, 'f0.pdf'))).toBe(false) // dropped out
  })

  it('treats an unreadable list as empty', () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(PICKED_PDFS_KEY, '{oops')
    expect(isPickedPdf(db, INVOICE)).toBe(false)
    rememberPickedPdf(db, INVOICE)
    expect(isPickedPdf(db, INVOICE)).toBe(true)
  })

  it('cannot be written by the renderer', () => {
    expect(RENDERER_WRITABLE_SETTINGS.has(PICKED_PDFS_KEY)).toBe(false)
  })
})

describe('unpickedPdfError', () => {
  beforeEach(() => {
    rememberPickedPdf(db, INVOICE)
    rememberPickedPdf(db, SHEET)
  })

  it('accepts requests that name only picked PDFs', () => {
    expect(unpickedPdfError(db, { filePath: INVOICE })).toBeNull()
    expect(unpickedPdfError(db, { invoicePath: INVOICE, stundennachweisPaths: [SHEET] })).toBeNull()
    expect(unpickedPdfError(db, { invoicePath: INVOICE, stundennachweisPath: SHEET })).toBeNull()
    expect(
      unpickedPdfError(db, { clientId: 1, fromIso: 'a', toIso: 'b', invoicePath: INVOICE })
    ).toBeNull()
  })

  it.each([
    ['pdf-info', { filePath: OTHER }],
    ['an invoice', { invoicePath: OTHER, stundennachweisPaths: [SHEET] }],
    [
      'one time sheet among several',
      { invoicePath: INVOICE, stundennachweisPaths: [SHEET, OTHER] }
    ],
    ['the legacy single time sheet', { invoicePath: INVOICE, stundennachweisPath: OTHER }],
    ['a path that is not a string', { filePath: 42 }],
    ['a time sheet that is not a string', { invoicePath: INVOICE, stundennachweisPaths: [7] }]
  ])('refuses %s that was not picked', (_label, req) => {
    expect(unpickedPdfError(db, req)).toBe(NOT_PICKED_MESSAGE)
  })
})

describe('ShellTargets', () => {
  const app = {
    db: join(ROOT, 'userData', 'timetrack.db'),
    logs: join(ROOT, 'userData', 'logs'),
    logFile: join(ROOT, 'userData', 'logs', 'main.log'),
    backups: join(ROOT, 'Backups')
  }
  const targets = (): ShellTargets =>
    new ShellTargets(() => [app.db, app.logs, app.logFile, app.backups])

  it('opens the app’s own locations', () => {
    const t = targets()
    for (const p of Object.values(app)) expect(t.allows(p)).toBe(true)
  })

  it('opens a file the main process wrote, and only after it did', () => {
    const t = targets()
    const merged = join(ROOT, 'Rechnung-2026-10_inkl_Stundennachweis.pdf')
    expect(t.allows(merged)).toBe(false)
    t.rememberWritten(merged)
    expect(t.allows(merged)).toBe(true)
  })

  it.each([
    ['another file', join(ROOT, 'Downloads', 'payload.exe')],
    ['a file inside an allowed folder', join(app.logs, 'other.exe')],
    ['the parent of an allowed folder', join(ROOT, 'userData')],
    ['an empty path', ''],
    ['a value that is not a string', { path: app.db }]
  ])('refuses %s', (_label, p) => {
    expect(targets().allows(p)).toBe(false)
  })
})

// The rules above only protect if the handlers call them. A unit test of
// ShellTargets stays green when a handler drops the check, so the wiring in
// ipc.ts is pinned here as well.
describe('ipc.ts wiring', () => {
  const src = readFileSync(join(__dirname, 'ipc.ts'), 'utf8')
  const handler = (channel: string): string => {
    const start = src.indexOf(`'${channel}'`)
    expect(start, `${channel} is registered`).toBeGreaterThan(-1)
    return src.slice(start, src.indexOf('ipcMain.', start + channel.length))
  }

  it.each(['shell:openPath', 'shell:showItemInFolder'])('%s checks ShellTargets', (ch) => {
    expect(handler(ch)).toContain('shellTargets.allows(path)')
  })

  it.each(['pdf:pdf-info', 'pdf:merge-only', 'pdf:merge-export'])(
    '%s refuses unpicked PDFs',
    (ch) => {
      expect(handler(ch)).toContain('unpickedPdfError(db, req)')
    }
  )

  it.each(['pdf:merge-only', 'pdf:merge-export'])('%s hands its output to the shell', (ch) => {
    expect(handler(ch)).toContain('shellTargets.rememberWritten(res.data.path)')
  })

  it('pdf:open-pdf-dialog remembers the pick', () => {
    expect(handler('pdf:open-pdf-dialog')).toContain('rememberPickedPdf(db, result.filePaths[0])')
  })
})
