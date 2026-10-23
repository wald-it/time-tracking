import type Database from 'better-sqlite3'
import { resolve } from 'path'

/**
 * #272 (part A2) — paths the renderer may hand back to the main process.
 *
 * The renderer only ever names files and folders the main process gave it:
 * the paths from `paths:get`, the PDFs picked in `pdf:open-pdf-dialog`, and
 * the merged PDFs the merge handlers wrote. Anything else is refused, so a
 * compromised renderer cannot have the main process read, open or reveal an
 * arbitrary path.
 *
 * Paths are compared exactly (after `resolve`), never case-folded: the
 * renderer hands back the very string it was given, and folding would let a
 * differently-cased file on a case-sensitive volume pass as picked.
 *
 * Picked PDFs outlive a restart: the merge dialog restores its last invoice
 * and time sheets on the next start, so the main process keeps the picked
 * paths in a settings row only it writes (the key is not on the renderer
 * allow-list in settingsWrite.ts, and settings:getAll leaves it out).
 */
export const PICKED_PDFS_KEY = 'pdf_merge_picked_paths'

/** Settings rows only the main process reads; settings:getAll leaves them out. */
export const MAIN_ONLY_SETTING_KEYS: ReadonlySet<string> = new Set([PICKED_PDFS_KEY])

/**
 * Enough for a few months of invoices and time sheets. A pick is refreshed
 * whenever `pdf:pdf-info` reads it, which the merge dialog does on every
 * pick and every restore, so a selection still in that dialog does not drop
 * out. The merge handlers themselves do not refresh.
 */
export const MAX_PICKED_PDFS = 50

function readPicked(db: Database.Database): string[] {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(PICKED_PDFS_KEY) as
    | { value: string }
    | undefined
  if (!row) return []
  try {
    const parsed: unknown = JSON.parse(row.value)
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

/**
 * Picks of the running session, per database connection (one per app run).
 * Never capped: the merge dialog's time-sheet list has no limit, so a long
 * merge must not evict an input it still holds. Only the persisted list,
 * which carries picks across a restart, is capped.
 */
const sessionPicks = new WeakMap<Database.Database, Set<string>>()

function sessionPicksOf(db: Database.Database): Set<string> {
  let picks = sessionPicks.get(db)
  if (!picks) {
    picks = new Set()
    sessionPicks.set(db, picks)
  }
  return picks
}

/** Record (or refresh) a picked PDF: most recently used first, once each, capped. */
export function rememberPickedPdf(db: Database.Database, path: string): void {
  const resolved = resolve(path)
  sessionPicksOf(db).add(resolved)
  const current = readPicked(db)
  if (current[0] === resolved) return
  const next = [resolved, ...current.filter((p) => p !== resolved)].slice(0, MAX_PICKED_PDFS)
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    PICKED_PDFS_KEY,
    JSON.stringify(next)
  )
}

/** True when `path` is a PDF the user picked in the native dialog. */
export function isPickedPdf(db: Database.Database, path: unknown): boolean {
  if (typeof path !== 'string' || path === '') return false
  const resolved = resolve(path)
  return sessionPicksOf(db).has(resolved) || readPicked(db).includes(resolved)
}

export const NOT_PICKED_MESSAGE =
  'Diese Datei wurde nicht über die Dateiauswahl gewählt. Bitte die PDF erneut auswählen.'

export const MALFORMED_PDF_REQUEST_MESSAGE = 'Ungültige PDF-Anfrage'

const isAbsent = (v: unknown): boolean => v === undefined || v === null || v === ''

/**
 * The path fields of a PDF request (`pdf:pdf-info`, `pdf:merge-only`,
 * `pdf:merge-export`), or null when any of them has a shape the handlers do
 * not expect. Strict on purpose: every path field is absent, a string, or
 * (the time-sheet list) an array of strings. Anything else is refused before
 * a handler can touch the file system, so the guard and the handlers cannot
 * read the same request differently.
 */
export function pdfRequestPaths(req: unknown): string[] | null {
  if (req === null || typeof req !== 'object') return null
  const r = req as Record<string, unknown>
  const paths: string[] = []
  for (const field of ['filePath', 'invoicePath', 'stundennachweisPath'] as const) {
    const v = r[field]
    if (isAbsent(v)) continue
    if (typeof v !== 'string') return null
    paths.push(v)
  }
  const list = r.stundennachweisPaths
  if (list !== undefined && list !== null) {
    if (!Array.isArray(list) || !list.every((p) => typeof p === 'string')) return null
    paths.push(...list.filter((p) => p !== ''))
  }
  return paths
}

/**
 * Every path in the request must be a picked PDF, and the request must be
 * well-formed. Returns the refusal, or null. Checks every path field, also
 * one a handler would ignore, so a stray field cannot reach the file system.
 */
export function unpickedPdfError(db: Database.Database, req: unknown): string | null {
  const paths = pdfRequestPaths(req)
  if (paths === null) return MALFORMED_PDF_REQUEST_MESSAGE
  const picked = new Set([...sessionPicksOf(db), ...readPicked(db)])
  for (const p of paths) {
    if (!picked.has(resolve(p))) return NOT_PICKED_MESSAGE
  }
  return null
}

/**
 * The paths `shell:openPath` / `shell:showItemInFolder` accept: the app's own
 * locations (supplied without touching the file system, so a dead network
 * share cannot stall the check) and the files this session's merges wrote.
 */
export class ShellTargets {
  private readonly written = new Set<string>()

  constructor(private readonly appPaths: () => string[]) {}

  /** A file the main process wrote and told the renderer about. */
  rememberWritten(path: string): void {
    this.written.add(resolve(path))
  }

  allows(path: unknown): boolean {
    if (typeof path !== 'string' || path === '') return false
    const key = resolve(path)
    if (this.written.has(key)) return true
    return this.appPaths().some((p) => p !== '' && resolve(p) === key)
  }
}

export const SHELL_REFUSED_MESSAGE =
  'Dieser Pfad gehört nicht zu TimeTrack und wird nicht geöffnet.'
