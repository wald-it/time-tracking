import type Database from 'better-sqlite3'
import log from 'electron-log/main'
import { stat } from 'fs/promises'
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
 * Only the main process writes it (after a successful save), so it is not on
 * the renderer allow-list in settingsWrite.ts, and the JSON data export leaves
 * it out (jsonExport.ts).
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

/**
 * Asynchronous on purpose: the remembered folder may sit on a network share
 * that is offline, and a synchronous stat of an unreachable path can block the
 * main process (window, tray, timer) for many seconds.
 */
async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
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
export async function exportDefaultPath(
  db: Database.Database,
  kind: ExportKind,
  fileName: string
): Promise<string> {
  const folder = readFolders(db)[kind]
  return typeof folder === 'string' && isAbsolute(folder) && (await isFolder(folder))
    ? join(folder, fileName)
    : fileName
}

/**
 * Remember the folder of a file the user just saved. A convenience: if the
 * settings write fails, the export it follows has still succeeded, so the
 * error is logged and swallowed rather than reported as a failed export.
 */
export function rememberExportFolder(
  db: Database.Database,
  kind: ExportKind,
  filePath: string
): void {
  try {
    const folders = { ...readFolders(db), [kind]: dirname(filePath) }
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(
      EXPORT_FOLDERS_SETTING,
      JSON.stringify(folders)
    )
  } catch (error) {
    log.warn(`[export] could not remember the ${kind} export folder:`, error)
  }
}
