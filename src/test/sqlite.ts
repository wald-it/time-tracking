/**
 * Shared SQLite bootstrap for the DB-backed test suites (#151).
 *
 * Twelve test files used to carry their own copy of the same probe: try to
 * load `better-sqlite3`, and if the native binding does not fit the current
 * runtime's ABI, silently skip every test in the file. That turned a broken
 * environment into a green summary — `334 passed | 201 skipped` reads as
 * success, not as "a third of your coverage did not run".
 *
 * `pnpm test` now runs on the Electron binary in Node mode (see
 * `scripts/run-vitest.mjs`), so the ABI always matches and there is no longer
 * a legitimate reason for these suites to be unavailable. `loadSqlite()`
 * therefore **throws** instead of skipping: if the module cannot load, the run
 * is red and says exactly what to do about it.
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
  'The binary is compiled against the Electron ABI (the app needs that at',
  'runtime), so the suite must run on Electron in Node mode. Use the package',
  'script, which does that for you:',
  '',
  '    pnpm test',
  '',
  'Running `vitest` directly under a system Node will always fail here.',
  '',
  'If `pnpm test` itself fails this way, the binary is stale — most likely',
  'because `pnpm rebuild better-sqlite3` replaced it with a Node-ABI build.',
  'Note that `pnpm install` does NOT repair this: electron-builder caches the',
  'ABI marker in node_modules/better-sqlite3/build/Release/.forge-meta and',
  'skips the rebuild. Force it:',
  '',
  '    pnpm exec electron-rebuild -f -w better-sqlite3'
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
 * Bring an empty database up to the current schema by running every migration
 * in order, exactly as `runMigrations` does in production.
 *
 * Deliberately does not touch `PRAGMA foreign_keys`: some suites enable it and
 * some rely on it being off, so that stays with the caller.
 */
export function applyMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  )
  for (const m of migrations) {
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
export function createMigratedTemplate(Ctor: DatabaseCtor, dir: string): string {
  const path = join(dir, 'template.sqlite')
  const db = new Ctor(path)
  try {
    applyMigrations(db)
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
  return new Ctor(path)
}
