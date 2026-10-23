import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { runMigrations, MigrationError } from './migrations/runner'
import { runDailyBackupIfNeeded } from './backup'

let db: Database.Database | undefined
let _dbPath: string

export function getDb(): Database.Database {
  if (db) return db

  const userDataPath = app.getPath('userData')
  mkdirSync(userDataPath, { recursive: true })
  _dbPath = join(userDataPath, 'timetrack.sqlite')

  const conn = new Database(_dbPath)
  conn.pragma('journal_mode = WAL')
  conn.pragma('foreign_keys = ON')

  // Assigned only after the migrations: a failed run closes the connection,
  // and a later getDb() must not hand out that closed handle.
  const result = runMigrations(conn, _dbPath)
  db = conn
  if (result.applied.length > 0) {
    console.log(`[db] Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`)
  }

  // Daily backup is fire-and-forget — must not block startup or throw.
  void runDailyBackupIfNeeded(conn)

  return conn
}

export function getDbPath(): string {
  return _dbPath
}

export { MigrationError }

export function recoverZombieEntries(): void {
  const db = getDb()
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  db.prepare(
    `
    UPDATE entries
    SET stopped_at = heartbeat_at
    WHERE stopped_at IS NULL
      AND heartbeat_at IS NOT NULL
      AND heartbeat_at < ?
  `
  ).run(fiveMinutesAgo)
  // Stop entries without any heartbeat (crashed before first heartbeat)
  db.prepare(
    `
    UPDATE entries
    SET stopped_at = started_at
    WHERE stopped_at IS NULL
      AND heartbeat_at IS NULL
      AND started_at < ?
  `
  ).run(fiveMinutesAgo)
}
