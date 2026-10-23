/**
 * #272 (part A2) — the renderer may only hand back paths the main process
 * gave it: picked PDFs for the merge handlers, the app's own locations and
 * the merged files for the shell helpers.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join, sep } from 'path'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import {
  MAIN_ONLY_SETTING_KEYS,
  MALFORMED_PDF_REQUEST_MESSAGE,
  MAX_PICKED_PDFS,
  NOT_PICKED_MESSAGE,
  PICKED_PDFS_KEY,
  ShellTargets,
  isPickedPdf,
  pdfRequestPaths,
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

function storedPicks(): string[] {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(PICKED_PDFS_KEY) as
    | { value: string }
    | undefined
  return row ? (JSON.parse(row.value) as string[]) : []
}

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
    expect(storedPicks()).toEqual([INVOICE])
  })

  // A case-folded match would let a different file on a case-sensitive volume
  // pass as picked; the renderer hands back the exact string anyway.
  it('compares exactly, never case-folded', () => {
    rememberPickedPdf(db, INVOICE)
    expect(isPickedPdf(db, INVOICE.toUpperCase())).toBe(false)
    // Built by concatenation: join() would already drop the '.' segment, and
    // the test must exercise the resolve() in the check itself.
    expect(isPickedPdf(db, ROOT + sep + '.' + sep + 'Rechnung-2026-10.pdf')).toBe(true)
  })

  it('keeps the newest picks, once each, up to the cap', () => {
    for (let i = 0; i < MAX_PICKED_PDFS + 5; i++) rememberPickedPdf(db, join(ROOT, `f${i}.pdf`))
    rememberPickedPdf(db, join(ROOT, 'f10.pdf'))
    const list = storedPicks()
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

  it('cannot be written by the renderer, nor read through settings:getAll', () => {
    expect(RENDERER_WRITABLE_SETTINGS.has(PICKED_PDFS_KEY)).toBe(false)
    expect(MAIN_ONLY_SETTING_KEYS.has(PICKED_PDFS_KEY)).toBe(true)
  })
})

describe('pdfRequestPaths', () => {
  it('reads the paths the handlers read', () => {
    expect(pdfRequestPaths({ filePath: INVOICE })).toEqual([INVOICE])
    expect(pdfRequestPaths({ invoicePath: INVOICE, stundennachweisPaths: [SHEET] })).toEqual([
      INVOICE,
      SHEET
    ])
    expect(pdfRequestPaths({ invoicePath: INVOICE, stundennachweisPath: SHEET })).toEqual([
      INVOICE,
      SHEET
    ])
  })

  it('includes every path field, also one a handler would ignore', () => {
    expect(
      pdfRequestPaths({
        invoicePath: INVOICE,
        stundennachweisPaths: [SHEET],
        stundennachweisPath: OTHER
      })
    ).toEqual([INVOICE, OTHER, SHEET])
  })

  // The guard must never read a request differently from the handlers: any
  // shape they do not expect is refused before the file system is touched.
  it.each([
    ['no object', null],
    ['a path that is not a string', { filePath: 42 }],
    ['an invoice that is not a string', { invoicePath: { toString: () => INVOICE } }],
    ['a time sheet list that is not an array', { stundennachweisPaths: { length: 1, 0: OTHER } }],
    ['a time sheet that is not a string', { stundennachweisPaths: [SHEET, 7] }]
  ])('rejects %s as malformed', (_label, req) => {
    expect(pdfRequestPaths(req)).toBeNull()
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
    [
      'a stray legacy field next to the list',
      { invoicePath: INVOICE, stundennachweisPaths: [SHEET], stundennachweisPath: OTHER }
    ]
  ])('refuses %s that was not picked', (_label, req) => {
    expect(unpickedPdfError(db, req)).toBe(NOT_PICKED_MESSAGE)
  })

  // Round 2: a non-array list with a `length` used to slip past the guard and
  // reach existsSync in mergeOnlyHandler (a UNC path there leaks the NTLM hash).
  it('refuses a malformed request before any handler runs', () => {
    expect(
      unpickedPdfError(db, {
        invoicePath: INVOICE,
        stundennachweisPath: SHEET,
        stundennachweisPaths: { length: 1, 0: '\\\\evil\\share\\a.pdf' }
      })
    ).toBe(MALFORMED_PDF_REQUEST_MESSAGE)
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
    new ShellTargets(() => [app.db, app.logs, app.logFile, app.backups, ''])

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
    ['an allowed path in other case', app.db.toUpperCase()],
    ['an empty path', ''],
    ['a value that is not a string', { path: app.db }]
  ])('refuses %s', (_label, p) => {
    expect(targets().allows(p)).toBe(false)
  })
})

// The rules above only protect if the handlers call them. A unit test of
// ShellTargets stays green when a handler drops the check, so the wiring in
// ipc.ts is pinned here: the guard must be code (an `if` line, not a
// comment) and come before the call it protects.
describe('ipc.ts wiring', () => {
  const src = readFileSync(join(__dirname, 'ipc.ts'), 'utf8')
  const handler = (channel: string): string => {
    const start = src.indexOf(`'${channel}'`)
    expect(start, `${channel} is registered`).toBeGreaterThan(-1)
    return src.slice(start, src.indexOf('ipcMain.', start + channel.length))
  }
  const guardBefore = (body: string, guard: RegExp, call: string): void => {
    const g = body.search(guard)
    expect(g, `guard ${guard} present as code`).toBeGreaterThan(-1)
    expect(body.indexOf(call), `${call} present`).toBeGreaterThan(g)
  }

  it('shell:openPath checks ShellTargets before opening', () => {
    guardBefore(
      handler('shell:openPath'),
      /\n\s*if \(!shellTargets\.allows\(path\)\) return fail\(/,
      'shell.openPath('
    )
  })

  it('shell:showItemInFolder checks ShellTargets before revealing', () => {
    guardBefore(
      handler('shell:showItemInFolder'),
      /\n\s*if \(!shellTargets\.allows\(path\)\) return fail\(/,
      'shell.showItemInFolder('
    )
  })

  it.each([
    ['pdf:pdf-info', 'pdfInfoHandler('],
    ['pdf:merge-only', 'mergeOnlyHandler('],
    ['pdf:merge-export', 'mergeExportHandler(']
  ])('%s refuses unpicked PDFs before reading', (ch, call) => {
    const body = handler(ch)
    guardBefore(body, /\n\s*const refused = pdfRequestRefusal\(req\)/, call)
    guardBefore(body, /\n\s*if \(refused\) return fail\(refused\)/, call)
  })

  it.each(['pdf:merge-only', 'pdf:merge-export'])('%s hands its output to the shell', (ch) => {
    expect(handler(ch)).toMatch(
      /\n\s*if \(res\.ok\) shellTargets\.rememberWritten\(res\.data\.path\)/
    )
  })

  it('pdf:pdf-info refreshes only the file it read', () => {
    const body = handler('pdf:pdf-info')
    expect(body).toMatch(/\n\s*rememberPickedPdf\(db, filePath\)/)
    expect(body).not.toContain('pdfRequestPaths')
  })

  it('pdf:open-pdf-dialog remembers the pick', () => {
    expect(handler('pdf:open-pdf-dialog')).toMatch(
      /\n\s*rememberPickedPdf\(db, result\.filePaths\[0\]\)/
    )
  })

  it('settings:getAll leaves the main-only rows out', () => {
    expect(handler('settings:getAll')).toContain('!MAIN_ONLY_SETTING_KEYS.has(r.key)')
  })
})
