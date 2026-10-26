import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { runMigrations, MigrationError } from './migrations/runner'
import { runDailyBackupIfNeeded } from './backup'
import { writeEntry } from './entryMutations'

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

/**
 * Crash recovery (2.0 design D4, section 5): a running entry whose last
 * heartbeat is older than five minutes was left behind by a crash. It is
 * sealed at that heartbeat, or at its start when it never had one, through
 * `writeEntry` with source `recovery`, the one write path. Zero length is
 * allowed here on purpose (section 11.7).
 */
export function recoverZombieEntries(): void {
  const db = getDb()
  recoverZombies(db)
}

export function recoverZombies(
  db: Database.Database,
  now = Date.now()
): Array<{ id: number; stopped_at: string }> {
  const fiveMinutesAgo = new Date(now - 5 * 60 * 1000).toISOString()
  const zombies = db
    .prepare(
      `SELECT e.id, COALESCE(e.heartbeat_at, v.started_at) AS last_seen
         FROM entry e JOIN entry_version v ON v.id = e.current_version_id
        WHERE e.is_deleted = 0 AND v.state = 'open'
          AND COALESCE(e.heartbeat_at, v.started_at) < ?`
    )
    .all(fiveMinutesAgo) as Array<{ id: number; last_seen: string }>
  const sealed: Array<{ id: number; stopped_at: string }> = []
  for (const z of zombies) {
    const res = writeEntry(
      db,
      { op: 'seal', id: z.id, stopped_at: z.last_seen },
      { source: 'recovery', now: new Date(now).toISOString() }
    )
    if (res.ok) sealed.push({ id: z.id, stopped_at: res.data.stopped_at! })
    else console.error(`[db] zombie ${z.id} not recovered: ${res.error}`)
  }
  return sealed
}
