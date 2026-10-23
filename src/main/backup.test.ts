import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

// Mock electron's `app.getPath('userData')` so backup.ts works in node tests.
let userDataDir: string

// A side file (`-wal` / `-shm`) that cannot be removed — on Windows the case
// when another process (the MCP server) still holds the database open.
let lockedSuffix: string | null = null
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return {
    ...real,
    unlinkSync: (path: import('fs').PathLike) => {
      if (lockedSuffix && String(path).endsWith(lockedSuffix)) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
      return real.unlinkSync(path)
    }
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'userData') return userDataDir
      throw new Error(`Unexpected getPath key: ${key}`)
    }
  }
}))

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'tt-backup-'))
  lockedSuffix = null
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
  vi.resetModules()
})

async function loadBackup(): Promise<typeof import('./backup')> {
  // Re-import per test so the mocked electron is fresh.
  return await import('./backup')
}

function makeFile(path: string, content = 'x'): void {
  writeFileSync(path, content)
}

/**
 * A WAL database whose last commit is still only in the `-wal` file — the
 * state after a crash or a killed process. Auto-checkpointing is off, so the
 * main file does not have the row until a checkpoint runs.
 */
function walDb(path: string, value: string): Database.Database {
  const db = new DatabaseImpl(path)
  db.pragma('journal_mode = WAL')
  db.pragma('wal_autocheckpoint = 0')
  db.exec('CREATE TABLE t (v TEXT)')
  db.prepare('INSERT INTO t (v) VALUES (?)').run(value)
  return db
}

function readValues(path: string): string[] {
  const db = new DatabaseImpl(path)
  try {
    return (db.prepare('SELECT v FROM t ORDER BY rowid').all() as Array<{ v: string }>).map(
      (r) => r.v
    )
  } finally {
    db.close()
  }
}

describe('createBackupSync', () => {
  it('writes a pre-migration snapshot into the backups dir', async () => {
    const { createBackupSync, getBackupsDir } = await loadBackup()
    const db = walDb(join(userDataDir, 'src.sqlite'), 'data')
    const target = createBackupSync(db, 'pre-migration', 3)
    db.close()
    expect(existsSync(target)).toBe(true)
    expect(target).toContain('backup-pre-migration-v3-')
    expect(target.startsWith(getBackupsDir())).toBe(true)
  })

  // Owner review (release 1.22): a plain copy of the main file loses every
  // commit that still sits in the WAL after a crash.
  it('includes commits that are still only in the WAL', async () => {
    const { createBackupSync } = await loadBackup()
    const src = join(userDataDir, 'src.sqlite')
    const db = walDb(src, 'only-in-wal')
    // Precondition: the main file alone does not have the row yet.
    const plain = join(userDataDir, 'plain-copy.sqlite')
    copyFileSync(src, plain)
    expect(() => readValues(plain)).toThrow()
    const target = createBackupSync(db, 'pre-migration', 3)
    db.close()
    expect(readValues(target)).toEqual(['only-in-wal'])
  })
})

describe('listBackups', () => {
  it('classifies daily / manual / pre-migration / legacy', async () => {
    const { listBackups, getBackupsDir } = await loadBackup()
    const dir = getBackupsDir()
    makeFile(join(dir, 'backup-daily-2026-04-20.sqlite'))
    makeFile(join(dir, 'backup-daily-2026-04-21.sqlite'))
    makeFile(join(dir, 'backup-manual-2026-04-22T10-00-00-000Z.sqlite'))
    makeFile(join(dir, 'backup-pre-migration-v0-2026-04-23T00-00-00-000Z.sqlite'))
    makeFile(join(dir, 'pre-migration-v0-old-format.sqlite')) // legacy
    makeFile(join(dir, 'unrelated.txt'))

    const list = listBackups()
    const reasons = list.map((b) => b.reason).sort()
    expect(reasons).toEqual(['daily', 'daily', 'manual', 'pre-migration', 'pre-migration'])
    // Newest first
    const dailies = list.filter((b) => b.reason === 'daily')
    expect(dailies[0].filename).toContain('2026-04-21')
  })

  it('returns empty array for empty backups dir', async () => {
    const { listBackups } = await loadBackup()
    expect(listBackups()).toEqual([])
  })
})

describe('rotateDailyBackups', () => {
  it('keeps last N daily backups, deletes older', async () => {
    const { rotateDailyBackups, listBackups, getBackupsDir } = await loadBackup()
    const dir = getBackupsDir()
    // 10 daily backups
    for (let i = 1; i <= 10; i++) {
      const day = String(i).padStart(2, '0')
      makeFile(join(dir, `backup-daily-2026-04-${day}.sqlite`))
    }
    const deleted = rotateDailyBackups(7)
    expect(deleted).toHaveLength(3)
    const remaining = listBackups().filter((b) => b.reason === 'daily')
    expect(remaining).toHaveLength(7)
    // The 7 newest (04 to 10) should remain — the oldest 3 (01-03) deleted.
    expect(remaining.map((b) => b.filename).sort()).toEqual([
      'backup-daily-2026-04-04.sqlite',
      'backup-daily-2026-04-05.sqlite',
      'backup-daily-2026-04-06.sqlite',
      'backup-daily-2026-04-07.sqlite',
      'backup-daily-2026-04-08.sqlite',
      'backup-daily-2026-04-09.sqlite',
      'backup-daily-2026-04-10.sqlite'
    ])
  })

  it('never deletes manual or pre-migration backups', async () => {
    const { rotateDailyBackups, listBackups, getBackupsDir } = await loadBackup()
    const dir = getBackupsDir()
    makeFile(join(dir, 'backup-manual-2026-01-01T00-00-00-000Z.sqlite'))
    makeFile(join(dir, 'backup-pre-migration-v0-2026-01-01T00-00-00-000Z.sqlite'))
    for (let i = 1; i <= 10; i++) {
      const day = String(i).padStart(2, '0')
      makeFile(join(dir, `backup-daily-2026-04-${day}.sqlite`))
    }
    rotateDailyBackups(2)
    const list = listBackups()
    expect(list.filter((b) => b.reason === 'manual')).toHaveLength(1)
    expect(list.filter((b) => b.reason === 'pre-migration')).toHaveLength(1)
    expect(list.filter((b) => b.reason === 'daily')).toHaveLength(2)
  })
})

describe('restoreBackup', () => {
  it('throws when backup file does not exist', async () => {
    const { restoreBackup } = await loadBackup()
    const db = walDb(join(userDataDir, 'db.sqlite'), 'x')
    expect(() =>
      restoreBackup(db, join(userDataDir, 'missing.sqlite'), join(userDataDir, 'db.sqlite'))
    ).toThrow(/not found/i)
    db.close()
  })

  it('replaces the open WAL database consistently and keeps a safety snapshot', async () => {
    const { restoreBackup, listBackups } = await loadBackup()
    const currentDb = join(userDataDir, 'current.sqlite')
    const backupSrc = walDb(join(userDataDir, 'backup.sqlite'), 'BACKUP')
    backupSrc.close()
    const backup = join(userDataDir, 'backup.sqlite')
    // The current DB holds its last commit only in the WAL.
    const db = walDb(currentDb, 'CURRENT')

    const { safetyBackupPath } = restoreBackup(db, backup, currentDb)

    expect(db.open).toBe(false)
    expect(safetyBackupPath).toContain('backup-pre-restore-')
    // The safety snapshot has the WAL-only commit.
    expect(readValues(safetyBackupPath)).toEqual(['CURRENT'])
    // No WAL of the old database is left to be replayed over the restored file.
    expect(existsSync(currentDb + '-wal')).toBe(false)
    expect(existsSync(currentDb + '-shm')).toBe(false)
    expect(readValues(currentDb)).toEqual(['BACKUP'])
    // pre-restore safety copies are diagnostic, not listed for the user.
    expect(listBackups().some((b) => b.filename.startsWith('backup-pre-restore-'))).toBe(false)
  })

  // Owner review #253: with the database still open elsewhere the restore
  // must not happen, must leave the file untouched, and must say so.
  it('a side file that cannot be removed leaves the database file untouched and reports it', async () => {
    const { restoreBackupOrReport, DbInUseError, replaceDbFile, RESTORE_IN_USE_MESSAGE } =
      await loadBackup()
    const currentDb = join(userDataDir, 'current.sqlite')
    const backupSrc = walDb(join(userDataDir, 'backup.sqlite'), 'BACKUP')
    backupSrc.close()
    const backup = join(userDataDir, 'backup.sqlite')
    const db = walDb(currentDb, 'CURRENT')
    // A second connection that has read keeps -wal/-shm alive after our close,
    // like a running MCP server.
    const other = new DatabaseImpl(currentDb)
    other.prepare('SELECT COUNT(*) FROM t').get()
    lockedSuffix = '-wal'

    expect(() => replaceDbFile(backup, currentDb)).toThrow(DbInUseError)

    const reports: Array<[string, string]> = []
    const res = restoreBackupOrReport(db, backup, currentDb, (title, message) =>
      reports.push([title, message])
    )
    expect(res).toEqual({ ok: false, error: RESTORE_IN_USE_MESSAGE })
    expect(reports).toHaveLength(1)
    expect(reports[0][1]).toMatch(/anderen Programm geöffnet/)
    other.close()
    lockedSuffix = null
    expect(readValues(currentDb)).toEqual(['CURRENT'])
  })

  it('a successful restore reports nothing', async () => {
    const { restoreBackupOrReport } = await loadBackup()
    const backupSrc = walDb(join(userDataDir, 'backup.sqlite'), 'BACKUP')
    backupSrc.close()
    const currentDb = join(userDataDir, 'current.sqlite')
    const db = walDb(currentDb, 'CURRENT')
    const reports: string[] = []
    const res = restoreBackupOrReport(db, join(userDataDir, 'backup.sqlite'), currentDb, (t) =>
      reports.push(t)
    )
    expect(res.ok).toBe(true)
    expect(reports).toEqual([])
    expect(readValues(currentDb)).toEqual(['BACKUP'])
  })
})

// ── New tests for v1.9.5: custom backupPathOverride ──────────────────────────

describe('getBackupsDir with override', () => {
  it('uses override path when provided', async () => {
    const { getBackupsDir } = await loadBackup()
    const customDir = join(userDataDir, 'custom-backups')
    const result = getBackupsDir(customDir)
    expect(result).toBe(customDir)
    expect(existsSync(customDir)).toBe(true)
  })

  it('falls back to default when override is empty string', async () => {
    const { getBackupsDir, getDefaultBackupsDir } = await loadBackup()
    const result = getBackupsDir('')
    expect(result).toBe(getDefaultBackupsDir())
  })

  it('falls back to default when override is whitespace', async () => {
    const { getBackupsDir, getDefaultBackupsDir } = await loadBackup()
    const result = getBackupsDir('   ')
    expect(result).toBe(getDefaultBackupsDir())
  })
})

describe('listBackups with override', () => {
  it('lists backups from the custom dir only', async () => {
    const { listBackups, getBackupsDir } = await loadBackup()
    const defaultDir = getBackupsDir()
    const customDir = join(userDataDir, 'custom')
    getBackupsDir(customDir) // creates dir

    makeFile(join(defaultDir, 'backup-daily-2026-01-01.sqlite'))
    makeFile(join(customDir, 'backup-daily-2026-02-01.sqlite'))
    makeFile(join(customDir, 'backup-manual-2026-02-02T00-00-00-000Z.sqlite'))

    const defaultList = listBackups()
    expect(defaultList).toHaveLength(1)
    expect(defaultList[0].filename).toContain('2026-01-01')

    const customList = listBackups(customDir)
    expect(customList).toHaveLength(2)
    expect(customList.map((b) => b.filename).sort()).toEqual([
      'backup-daily-2026-02-01.sqlite',
      'backup-manual-2026-02-02T00-00-00-000Z.sqlite'
    ])
  })
})

// #272: `backup:restore` takes the file name of a listed backup, never a path,
// and never puts a non-database file in place of the DB.
describe('restoreListedBackupOrReport', () => {
  const NAME = 'backup-manual-2026-04-01T00-00-00-000Z.sqlite'

  function listedBackup(dir: string, value = 'BACKUP'): void {
    walDb(join(dir, NAME), value).close()
  }

  it('restores a backup named by its listed file name', async () => {
    const { restoreListedBackupOrReport, getBackupsDir } = await loadBackup()
    listedBackup(getBackupsDir())
    const currentDb = join(userDataDir, 'current.sqlite')
    const db = walDb(currentDb, 'CURRENT')
    const reports: string[] = []
    const res = restoreListedBackupOrReport(db, NAME, undefined, currentDb, (t) => reports.push(t))
    expect(res.ok).toBe(true)
    expect(reports).toEqual([])
    expect(readValues(currentDb)).toEqual(['BACKUP'])
  })

  it.each([
    ['a full path, even to a listed backup', (dir: string) => join(dir, NAME)],
    ['a name that climbs out of the folder', () => '../current.sqlite'],
    ['a name that is not listed', () => 'backup-manual-unknown.sqlite'],
    ['a value that is not a string', () => ({ filename: NAME })]
  ])('refuses %s and leaves the database open and unchanged', async (_label, value) => {
    const { restoreListedBackupOrReport, getBackupsDir, RESTORE_UNKNOWN_MESSAGE } =
      await loadBackup()
    const dir = getBackupsDir()
    listedBackup(dir)
    const currentDb = join(userDataDir, 'current.sqlite')
    const db = walDb(currentDb, 'CURRENT')
    const reports: string[] = []
    const res = restoreListedBackupOrReport(db, value(dir), undefined, currentDb, (_t, m) =>
      reports.push(m)
    )
    expect(res).toEqual({ ok: false, error: RESTORE_UNKNOWN_MESSAGE })
    expect(reports).toEqual([RESTORE_UNKNOWN_MESSAGE])
    expect(db.open).toBe(true)
    db.close()
    expect(readValues(currentDb)).toEqual(['CURRENT'])
  })

  it('looks only in the configured backup folder, not the default one', async () => {
    const { restoreListedBackupOrReport, getBackupsDir } = await loadBackup()
    listedBackup(getBackupsDir()) // default folder
    const customDir = getBackupsDir(join(userDataDir, 'custom'))
    const currentDb = join(userDataDir, 'current.sqlite')
    const db = walDb(currentDb, 'CURRENT')
    const res = restoreListedBackupOrReport(db, NAME, customDir, currentDb, () => {})
    expect(res.ok).toBe(false)
    expect(db.open).toBe(true)
    db.close()
  })

  it('refuses a listed file that is not a SQLite database', async () => {
    const { restoreListedBackupOrReport, getBackupsDir } = await loadBackup()
    makeFile(join(getBackupsDir(), NAME), 'not a database')
    const currentDb = join(userDataDir, 'current.sqlite')
    const db = walDb(currentDb, 'CURRENT')
    const reports: string[] = []
    const res = restoreListedBackupOrReport(db, NAME, undefined, currentDb, (_t, m) =>
      reports.push(m)
    )
    expect(res.ok).toBe(false)
    expect(reports[0]).toMatch(/Not a SQLite database/)
    // Refused before the snapshot: the open database was not closed.
    expect(db.open).toBe(true)
    db.close()
    expect(readValues(currentDb)).toEqual(['CURRENT'])
  })
})

describe('hasSqliteHeader', () => {
  it('tells a database from other files', async () => {
    const { hasSqliteHeader } = await loadBackup()
    const dbFile = join(userDataDir, 'real.sqlite')
    walDb(dbFile, 'x').close()
    makeFile(join(userDataDir, 'short.sqlite'), 'SQLite')
    makeFile(join(userDataDir, 'text.sqlite'), 'SQLite format 4\0 and more')
    expect(hasSqliteHeader(dbFile)).toBe(true)
    expect(hasSqliteHeader(join(userDataDir, 'short.sqlite'))).toBe(false)
    expect(hasSqliteHeader(join(userDataDir, 'text.sqlite'))).toBe(false)
    expect(hasSqliteHeader(join(userDataDir, 'missing.sqlite'))).toBe(false)
  })
})
