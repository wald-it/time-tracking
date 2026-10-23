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
 * Enough for a few months of invoices and time sheets. A pick the merge
 * dialog keeps using is refreshed on every successful read, so only paths
 * nobody uses any more drop out.
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

/** Record (or refresh) a picked PDF: newest first, once each, capped. */
export function rememberPickedPdf(db: Database.Database, path: string): void {
  const resolved = resolve(path)
  const next = [resolved, ...readPicked(db).filter((p) => p !== resolved)].slice(0, MAX_PICKED_PDFS)
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    PICKED_PDFS_KEY,
    JSON.stringify(next)
  )
}

/** True when `path` is a PDF the user picked in the native dialog. */
export function isPickedPdf(db: Database.Database, path: unknown): boolean {
  if (typeof path !== 'string' || path === '') return false
  return readPicked(db).includes(resolve(path))
}

export const NOT_PICKED_MESSAGE =
  'Diese Datei wurde nicht über die Dateiauswahl gewählt. Bitte die PDF erneut auswählen.'

/**
 * The input paths a PDF request (`pdf:pdf-info`, `pdf:merge-only`,
 * `pdf:merge-export`) will read, chosen the way the handlers choose them:
 * the time-sheet list wins over the legacy single field. Non-string values
 * are left out; the handlers refuse them as malformed without reading.
 */
export function pdfRequestPaths(req: unknown): string[] {
  const r = (req ?? {}) as Record<string, unknown>
  const candidates: unknown[] = [r.filePath, r.invoicePath]
  if (Array.isArray(r.stundennachweisPaths) && r.stundennachweisPaths.length > 0) {
    candidates.push(...r.stundennachweisPaths)
  } else {
    candidates.push(r.stundennachweisPath)
  }
  return candidates.filter((p): p is string => typeof p === 'string' && p !== '')
}

/** Every path the request will read must be a picked PDF. Returns the refusal, or null. */
export function unpickedPdfError(db: Database.Database, req: unknown): string | null {
  const picked = new Set(readPicked(db))
  for (const p of pdfRequestPaths(req)) {
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
