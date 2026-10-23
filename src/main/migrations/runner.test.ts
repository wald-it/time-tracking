/**
 * The migration runner around its backup (release 1.22, owner decision D1):
 * the pre-migration backup is a consistent snapshot that includes commits
 * still in the WAL; a failed migration closes the database and restores that
 * backup with no old WAL left behind; a second start applies nothing.
 *
 * The migration list is replaced by two test migrations, so a failure can be
 * provoked without touching the real ones.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../../test/sqlite'

let userDataDir: string
let failSecond = false

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'userData') return userDataDir
      throw new Error(`Unexpected getPath key: ${key}`)
    }
  }
}))

vi.mock('./index', () => ({
  migrations: [
    {
      version: 1,
      name: 'add-m1',
      up: `CREATE TABLE IF NOT EXISTS t (v TEXT); INSERT INTO t (v) VALUES ('m1')`
    },
    {
      version: 2,
      name: 'maybe-fail',
      up: `INSERT INTO t (v) VALUES ('m2')`,
      run: () => {
        if (failSecond) throw new Error('provoked')
      }
    }
  ],
  executeMigration: (db: Database.Database, m: { up: string; run?: (db: unknown) => void }) => {
    db.exec(m.up)
    m.run?.(db)
  }
}))

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'tt-runner-'))
  failSecond = false
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

/** A WAL database whose last commit ('before') is still only in the WAL. */
function crashedDb(path: string): Database.Database {
  const db = new DatabaseImpl(path)
  db.pragma('journal_mode = WAL')
  db.pragma('wal_autocheckpoint = 0')
  db.exec('CREATE TABLE t (v TEXT)')
  db.prepare(`INSERT INTO t (v) VALUES ('before')`).run()
  return db
}

function values(path: string): string[] {
  const db = new DatabaseImpl(path)
  try {
    return (db.prepare('SELECT v FROM t ORDER BY rowid').all() as Array<{ v: string }>).map(
      (r) => r.v
    )
  } finally {
    db.close()
  }
}

function backupsDir(): string {
  return join(userDataDir, 'backups')
}

describe('runMigrations', () => {
  it('backs up the WAL content, applies, and a second start applies nothing', async () => {
    const { runMigrations } = await import('./runner')
    const path = join(userDataDir, 'timetrack.sqlite')
    const db = crashedDb(path)
    const first = runMigrations(db, path)
    expect(first.applied).toEqual([1, 2])
    expect(values(first.backupPath!)).toEqual(['before'])
    const second = runMigrations(db, path)
    expect(second).toEqual({ applied: [], backupPath: null })
    expect(readdirSync(backupsDir())).toHaveLength(1)
    db.close()
    expect(values(path)).toEqual(['before', 'm1', 'm2'])
  })

  it('a brand-new database gets no snapshot', async () => {
    const { runMigrations } = await import('./runner')
    const path = join(userDataDir, 'timetrack.sqlite')
    const db = new DatabaseImpl(path)
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE t (v TEXT)')
    db.exec('DROP TABLE t')
    const res = runMigrations(db, path)
    db.close()
    expect(res.backupPath).toBeNull()
    expect(existsSync(backupsDir())).toBe(false)
  })

  it('a failed migration closes the DB and restores the backup without an old WAL', async () => {
    const { runMigrations, MigrationError } = await import('./runner')
    const path = join(userDataDir, 'timetrack.sqlite')
    const db = crashedDb(path)
    failSecond = true
    expect(() => runMigrations(db, path)).toThrow(MigrationError)
    expect(db.open).toBe(false)
    expect(existsSync(path + '-wal')).toBe(false)
    expect(existsSync(path + '-shm')).toBe(false)
    // Migration 1 had committed; the restore takes it back. 'before' (which
    // was only in the WAL) is there.
    expect(values(path)).toEqual(['before'])
    const reopened = new DatabaseImpl(path)
    try {
      const v = reopened
        .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'schema_version'`)
        .get() as { n: number }
      // schema_version itself was created before the backup; it holds no row.
      if (v.n > 0) {
        const rows = reopened.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as {
          n: number
        }
        expect(rows.n).toBe(0)
      }
      expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally {
      reopened.close()
    }
  })
})
