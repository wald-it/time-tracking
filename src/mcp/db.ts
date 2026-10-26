/**
 * Opens the TimeTrack SQLite database in strict read-only mode for the MCP
 * server. The connection can NEVER mutate data — `readonly: true` makes SQLite
 * reject any write at the driver level, which is the core safety guarantee of
 * the read-only MVP (see issue: MCP-Server Read-only).
 *
 * The server runs on the app's Electron binary in Node mode; see
 * `src/main/mcpLaunch.ts` and the README "MCP integration" section for how
 * it is launched.
 */
import Database from 'better-sqlite3'
import { existsSync } from 'fs'
import { resolveDbPath } from './dbPath'
import type { SqliteDb } from './queries'

export interface OpenResult {
  db: Database.Database
  path: string
}

/**
 * Open the database read-only. Throws a clear, actionable error when the file
 * is missing (e.g. TimeTrack never launched, or wrong TIMETRACK_DB_PATH).
 */
export function openReadonly(path: string = resolveDbPath()): OpenResult {
  if (!existsSync(path)) {
    throw new Error(
      `TimeTrack-Datenbank nicht gefunden: ${path}\n` +
        `Starte TimeTrack einmal, damit die DB angelegt wird, oder setze ` +
        `TIMETRACK_DB_PATH auf den korrekten Pfad.`
    )
  }
  const db = new Database(path, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  return { db, path }
}

/** Structural narrowing to the read-only surface used by the query layer. */
export function asSqliteDb(db: Database.Database): SqliteDb {
  return db
}
