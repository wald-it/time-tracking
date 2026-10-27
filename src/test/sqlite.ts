/**
 * Shared SQLite bootstrap for the DB-backed test suites (#151).
 *
 * Twelve test files used to carry their own copy of the same probe: try to
 * load `better-sqlite3`, and if the native binding does not fit the current
 * runtime's ABI, silently skip every test in the file. That turned a broken
 * environment into a green summary — `334 passed | 201 skipped` reads as
 * success, not as "a third of your coverage did not run".
 *
 * Since #269 `better-sqlite3` is an N-API module with prebuilt binaries for
 * every runtime the suite uses, so there is no legitimate reason for these
 * suites to be unavailable. `loadSqlite()` therefore **throws** instead of
 * skipping: if the module cannot load, the run is red and says what to do.
 */
import { copyFileSync } from 'fs'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { executeMigration, migrations } from '../main/migrations'

/** Constructor shape of `better-sqlite3`'s default export. */
export type DatabaseCtor = new (path: string) => Database.Database

const HINT = [
  'better-sqlite3 could not be loaded — the DB-backed tests cannot run.',
  '',
  'The package ships prebuilt N-API binaries in',
  'node_modules/better-sqlite3/prebuilds/ that load under Node and Electron',
  'alike, so this means the install is broken: the file for this platform is',
  'missing or was replaced. Reinstall:',
  '',
  '    pnpm install --frozen-lockfile',
  '',
  'Do not rebuild the module (electron-rebuild, pnpm rebuild): nothing needs',
  'compiling, and without Visual Studio or Xcode the rebuild fails.'
].join('\n')

let cached: DatabaseCtor | null = null

/**
 * Load the `better-sqlite3` constructor, or throw with an actionable message.
 *
 * The import is dynamic and the constructor is exercised once, because the
 * native binding can fail either at load time or only on first instantiation
 * depending on how the bindings shim resolves.
 */
export async function loadSqlite(): Promise<DatabaseCtor> {
  if (cached) return cached
  try {
    const mod = await import('better-sqlite3')
    const Ctor = mod.default as unknown as DatabaseCtor
    const probe = new Ctor(':memory:')
    probe.close()
    cached = Ctor
    return Ctor
  } catch (cause) {
    throw new Error(`${HINT}\n\nUnderlying error: ${(cause as Error)?.message ?? cause}`, { cause })
  }
}

/**
 * The last 1.x schema version: `entries` is still a table here. Suites that
 * write 1.x rows (the legacy generator, the migration-027 tests, the 028
 * tests themselves) migrate up to this version and no further.
 */
export const LAST_V1_VERSION = 27

/**
 * Bring an empty database up to the current schema by running every migration
 * in order, exactly as `runMigrations` does in production. `upTo` stops after
 * that version (see LAST_V1_VERSION).
 *
 * Deliberately does not touch `PRAGMA foreign_keys`: some suites enable it and
 * some rely on it being off, so that stays with the caller.
 */
export function applyMigrations(db: Database.Database, upTo = Number.MAX_SAFE_INTEGER): void {
  // Test databases are disposable files: each commit's fsync costs about 20 ms
  // on the Windows runner (#378). Keep handles already in WAL mode untouched,
  // so suites that enable WAL before calling us still exercise WAL backups.
  if (db.pragma('journal_mode', { simple: true }) !== 'wal') {
    db.pragma('synchronous = OFF')
  }
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  )
  for (const m of migrations.filter((mm) => mm.version <= upTo)) {
    db.transaction(() => {
      executeMigration(db, m)
      db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(m.version, m.name)
    })()
  }
}

/**
 * Migrate a fresh database file once and return its path, so a suite can hand
 * every test a byte copy of it instead of re-running every migration per test
 * (#233). Migrating per test let a slow Windows runner cross Vitest's 60 s
 * hook timeout.
 *
 * The template is closed before this returns: with the default rollback
 * journal that leaves a complete, self-contained file that `copyFileSync` can
 * duplicate safely. Do not switch the template to WAL, or a copy could miss
 * pages still sitting in the `-wal` file.
 */
export function createMigratedTemplate(
  Ctor: DatabaseCtor,
  dir: string,
  upTo = Number.MAX_SAFE_INTEGER
): string {
  const path = join(dir, 'template.sqlite')
  const db = new Ctor(path)
  try {
    applyMigrations(db, upTo)
  } finally {
    db.close()
  }
  return path
}

/**
 * Open a private copy of a template made by {@link createMigratedTemplate}.
 * Every call gets its own file, so tests stay as isolated from each other as
 * if each had migrated an empty database itself.
 */
export function openMigratedCopy(
  Ctor: DatabaseCtor,
  templatePath: string,
  dir: string
): Database.Database {
  const path = join(dir, 'test.sqlite')
  copyFileSync(templatePath, path)
  const db = new Ctor(path)
  // Test databases are disposable files: each commit's fsync costs about 20 ms
  // on the Windows runner (#378). The template uses rollback journaling.
  db.pragma('synchronous = OFF')
  return db
}
