import type Database from 'better-sqlite3'
import { existsSync } from 'fs'
import { executeMigration, migrations, type Migration } from './index'
import { createBackupSync, replaceDbFile } from '../backup'

const SCHEMA_VERSION_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`

export interface MigrationResult {
  applied: number[]
  backupPath: string | null
}

/**
 * Apply all pending migrations in a single atomic flow.
 *
 * - Creates `schema_version` if missing.
 * - Determines current version (MAX(version) or 0).
 * - If pending migrations exist: writes a pre-migration backup — a consistent
 *   snapshot through the connection (`VACUUM INTO`), so commits still in the
 *   WAL are in it.
 * - Each migration runs in its own transaction. On failure: rollback, close
 *   the database, restore the backup (WAL/SHM removed first), rethrow. The
 *   app must NOT continue with a partially migrated database; `db` is closed
 *   when a MigrationError is thrown.
 */
export function runMigrations(db: Database.Database, dbPath: string): MigrationResult {
  db.exec(SCHEMA_VERSION_TABLE)

  const currentVersion = getCurrentVersion(db)
  const pending = migrations.filter((m) => m.version > currentVersion)

  if (pending.length === 0) {
    return { applied: [], backupPath: null }
  }

  const backupPath = createBackupSync(db, 'pre-migration', currentVersion)
  const applied: number[] = []

  for (const migration of pending) {
    try {
      applyMigration(db, migration)
      applied.push(migration.version)
      console.log(`[migrations] Applied #${migration.version} (${migration.name})`)
    } catch (err) {
      console.error(`[migrations] FAILED #${migration.version} (${migration.name}):`, err)
      restoreAfterFailedMigration(db, backupPath, dbPath)
      throw new MigrationError(migration, err as Error, backupPath)
    }
  }

  return { applied, backupPath }
}

function getCurrentVersion(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as {
    v: number | null
  }
  return row.v ?? 0
}

function applyMigration(db: Database.Database, m: Migration): void {
  // Pre-apply observability: surface clock-skew and running-entry counts so
  // we can correlate post-deploy support tickets with the pre-state.
  if (m.version === 3) {
    logPreV3State(db)
  }

  const tx = db.transaction(() => {
    executeMigration(db, m)
    db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(m.version, m.name)
    // Post-apply invariants (run inside the same transaction so a failing
    // assertion rolls back the migration cleanly — runner's catch will then
    // restore from the pre-migration backup).
    if (m.version === 3) {
      assertNoNegativeRoundedMin(db)
    }
  })
  tx()
}

function logPreV3State(db: Database.Database): void {
  try {
    const skew = db
      .prepare(
        `SELECT COUNT(*) AS n FROM entries
          WHERE stopped_at IS NOT NULL AND stopped_at < started_at`
      )
      .get() as { n: number }
    const running = db
      .prepare(`SELECT COUNT(*) AS n FROM entries WHERE stopped_at IS NULL`)
      .get() as { n: number }
    console.log(
      `[migrations] pre-003: ${skew.n} clock-skew row(s) skipped; ${running.n} running entry/entries skipped`
    )
  } catch (err) {
    // Pre-apply logging must never block the migration itself.
    console.warn('[migrations] pre-003 log failed:', err)
  }
}

function assertNoNegativeRoundedMin(db: Database.Database): void {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE rounded_min < 0`).get() as {
    n: number
  }
  if (row.n > 0) {
    throw new Error(
      `Post-migration assertion failed: ${row.n} entry/entries have negative rounded_min`
    )
  }
}

function restoreAfterFailedMigration(
  db: Database.Database,
  backupPath: string,
  dbPath: string
): void {
  // Earlier migrations of this run are committed; only the backup brings the
  // pre-run state back. The file is replaced only with the connection closed.
  db.close()
  if (!existsSync(backupPath)) {
    console.warn('[migrations] No backup to restore.')
    return
  }
  try {
    replaceDbFile(backupPath, dbPath)
    console.log(`[migrations] Restored DB from backup: ${backupPath}`)
  } catch (err) {
    console.error('[migrations] Backup restore FAILED:', err)
  }
}

export class MigrationError extends Error {
  constructor(
    public readonly migration: Migration,
    public readonly cause: Error,
    public readonly backupPath: string
  ) {
    super(`Migration #${migration.version} (${migration.name}) failed: ${cause.message}`)
    this.name = 'MigrationError'
  }
}
