import type Database from 'better-sqlite3'
import { existsSync, statSync } from 'fs'
import { dirname, isAbsolute, join } from 'path'

/**
 * #269 — remember the folder of each export type.
 *
 * Since Electron 43 the save dialog opens in Downloads every time and the
 * operating system no longer remembers the last folder. Someone who files
 * every monthly Stundennachweis in the same place would have to walk there on
 * every export, so the app remembers the folder itself, per export type and
 * across restarts (owner decision 2026-10-23).
 *
 * One settings row, `export_folders`, holds a JSON object `{ kind: folder }`.
 * Only the main process writes it (after a successful save dialog), so it is
 * not on the renderer allow-list in settingsWrite.ts.
 */
export type ExportKind = 'csv' | 'ical' | 'json' | 'pdf'

export const EXPORT_FOLDERS_SETTING = 'export_folders'

type Folders = Partial<Record<ExportKind, string>>

function readFolders(db: Database.Database): Folders {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(EXPORT_FOLDERS_SETTING) as
    | { value: string }
    | undefined
  if (!row) return {}
  try {
    const parsed: unknown = JSON.parse(row.value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Folders) : {}
  } catch {
    return {}
  }
}

function isFolder(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The `defaultPath` for a save dialog: the suggested file name inside the
 * folder last used for this export type. Without a remembered folder, or when
 * it no longer exists (a removed USB drive, a renamed folder), it is the bare
 * file name and the dialog opens where Electron opens it (Downloads).
 */
export function exportDefaultPath(
  db: Database.Database,
  kind: ExportKind,
  fileName: string
): string {
  const folder = readFolders(db)[kind]
  return typeof folder === 'string' && isAbsolute(folder) && isFolder(folder)
    ? join(folder, fileName)
    : fileName
}

/** Remember the folder of a file the user just chose in a save dialog. */
export function rememberExportFolder(
  db: Database.Database,
  kind: ExportKind,
  filePath: string
): void {
  const folders = { ...readFolders(db), [kind]: dirname(filePath) }
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(
    EXPORT_FOLDERS_SETTING,
    JSON.stringify(folders)
  )
}
