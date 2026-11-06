import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  utimesSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { localDateKey } from '../shared/dateRanges'

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

describe('listBackups local midnight (#508)', () => {
  it('uses local midnight as a Z-ISO timestamp for daily backups', async () => {
    const { listBackups, getBackupsDir } = await loadBackup()
    makeFile(join(getBackupsDir(), 'backup-daily-2026-11-04.sqlite'))

    const [backup] = listBackups()

    expect(backup.createdAt).toBe(new Date(2026, 10, 4).toISOString())
    expect(backup.createdAt.endsWith('Z')).toBe(true)
  })

  it('sorts multiple daily backups and a manual backup by newest timestamp first', async () => {
    const { listBackups, getBackupsDir } = await loadBackup()
    const dir = getBackupsDir()
    for (const day of ['03', '04', '05']) {
      makeFile(join(dir, `backup-daily-2026-11-${day}.sqlite`))
    }
    const manual = 'backup-manual-2026-11-04T12-00-00-000Z.sqlite'
    const manualTime = new Date(2026, 10, 4, 0, 30)
    makeFile(join(dir, manual))
    utimesSync(join(dir, manual), manualTime, manualTime)

    const list = listBackups()

    expect(list.map((backup) => backup.filename)).toEqual([
      'backup-daily-2026-11-05.sqlite',
      manual,
      'backup-daily-2026-11-04.sqlite',
      'backup-daily-2026-11-03.sqlite'
    ])
    expect(list[1].createdAt).toBe(manualTime.toISOString())
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
    const { restoreBackupOrReport, DbInUseError, replaceDbFile } = await loadBackup()
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
    const res = restoreBackupOrReport(db, backup, currentDb, 'de', (title, message) =>
      reports.push([title, message])
    )
    const inUse =
      'Wiederherstellung nicht durchgeführt — die Datenbank ist noch in einem anderen Programm ' +
      'geöffnet (z. B. ein MCP-Client wie Claude Desktop). Programm beenden und erneut versuchen.'
    expect(res).toEqual({ ok: false, error: inUse })
    expect(reports).toEqual([['TimeTrack — Wiederherstellung nicht durchgeführt', inUse]])
    other.close()
    lockedSuffix = null
    expect(readValues(currentDb)).toEqual(['CURRENT'])
  })

  // #270: the same failure in English.
  it('reports a failed restore in the language it is given', async () => {
    const { restoreBackupOrReport } = await loadBackup()
    const currentDb = join(userDataDir, 'current.sqlite')
    const db = walDb(currentDb, 'CURRENT')
    const reports: Array<[string, string]> = []
    const res = restoreBackupOrReport(
      db,
      join(userDataDir, 'missing.sqlite'),
      currentDb,
      'en',
      (title, message) => reports.push([title, message])
    )
    expect(res.ok).toBe(false)
    expect(reports).toHaveLength(1)
    expect(reports[0][0]).toBe('TimeTrack — Backup not restored')
    expect(reports[0][1]).toMatch(/^Backup not restored: /)
    db.close()
  })

  it('a successful restore reports nothing', async () => {
    const { restoreBackupOrReport } = await loadBackup()
    const backupSrc = walDb(join(userDataDir, 'backup.sqlite'), 'BACKUP')
    backupSrc.close()
    const currentDb = join(userDataDir, 'current.sqlite')
    const db = walDb(currentDb, 'CURRENT')
    const reports: string[] = []
    const res = restoreBackupOrReport(
      db,
      join(userDataDir, 'backup.sqlite'),
      currentDb,
      'de',
      (t) => reports.push(t)
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
    const res = restoreListedBackupOrReport(db, NAME, undefined, currentDb, 'de', (t) =>
      reports.push(t)
    )
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
    const { restoreListedBackupOrReport, getBackupsDir } = await loadBackup()
    const dir = getBackupsDir()
    listedBackup(dir)
    const currentDb = join(userDataDir, 'current.sqlite')
    const db = walDb(currentDb, 'CURRENT')
    const reports: string[] = []
    const res = restoreListedBackupOrReport(db, value(dir), undefined, currentDb, 'de', (_t, m) =>
      reports.push(m)
    )
    const unknown =
      'Wiederherstellung nicht durchgeführt — diese Backup-Datei steht nicht in der Backup-Liste.'
    expect(res).toEqual({ ok: false, error: unknown })
    expect(reports).toEqual([unknown])
    expect(db.open).toBe(true)
    db.close()
    expect(readValues(currentDb)).toEqual(['CURRENT'])
  })

  // #270: the refusal speaks the app language.
  it('refuses an unlisted name in the language it is given', async () => {
    const { restoreListedBackupOrReport, getBackupsDir } = await loadBackup()
    listedBackup(getBackupsDir())
    const currentDb = join(userDataDir, 'current.sqlite')
    const db = walDb(currentDb, 'CURRENT')
    const reports: Array<[string, string]> = []
    const res = restoreListedBackupOrReport(db, 'nope.sqlite', undefined, currentDb, 'en', (t, m) =>
      reports.push([t, m])
    )
    const message = 'Backup not restored: this backup file is not in the backup list.'
    expect(res).toEqual({ ok: false, error: message })
    expect(reports).toEqual([['TimeTrack — Backup not restored', message]])
    expect(db.open).toBe(true)
    db.close()
    expect(readValues(currentDb)).toEqual(['CURRENT'])
  })

  it('reports an unreachable backup folder instead of failing silently', async () => {
    const { restoreListedBackupOrReport } = await loadBackup()
    // A file where the folder should be: creating or reading it throws.
    const blocked = join(userDataDir, 'blocked')
    makeFile(blocked)
    const currentDb = join(userDataDir, 'current.sqlite')
    const db = walDb(currentDb, 'CURRENT')
    const reports: string[] = []
    const res = restoreListedBackupOrReport(db, NAME, blocked, currentDb, 'de', (_t, m) =>
      reports.push(m)
    )
    expect(res.ok).toBe(false)
    expect(reports).toHaveLength(1)
    expect(db.open).toBe(true)
    db.close()
  })

  it('looks only in the configured backup folder, not the default one', async () => {
    const { restoreListedBackupOrReport, getBackupsDir } = await loadBackup()
    listedBackup(getBackupsDir()) // default folder
    const customDir = getBackupsDir(join(userDataDir, 'custom'))
    const currentDb = join(userDataDir, 'current.sqlite')
    const db = walDb(currentDb, 'CURRENT')
    const res = restoreListedBackupOrReport(db, NAME, customDir, currentDb, 'de', () => {})
    expect(res.ok).toBe(false)
    expect(db.open).toBe(true)
    db.close()
  })

  it('restores a fallback backup from the default folder while the configured one is unreachable (#506)', async () => {
    const { restoreListedBackupOrReport, getBackupsDir } = await loadBackup()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    listedBackup(getBackupsDir()) // default folder, where the fallback went
    const blocked = join(userDataDir, 'blocked')
    makeFile(blocked)
    const currentDb = join(userDataDir, 'current.sqlite')
    const db = walDb(currentDb, 'CURRENT')
    const reports: string[] = []
    const res = restoreListedBackupOrReport(db, NAME, blocked, currentDb, 'de', (t) =>
      reports.push(t)
    )
    expect(res.ok).toBe(true)
    expect(reports).toEqual([])
    expect(readValues(currentDb)).toEqual(['BACKUP'])
    vi.restoreAllMocks()
  })

  it('refuses a listed file that is not a SQLite database', async () => {
    const { restoreListedBackupOrReport, getBackupsDir } = await loadBackup()
    makeFile(join(getBackupsDir(), NAME), 'not a database')
    const currentDb = join(userDataDir, 'current.sqlite')
    const db = walDb(currentDb, 'CURRENT')
    const reports: string[] = []
    const res = restoreListedBackupOrReport(db, NAME, undefined, currentDb, 'de', (_t, m) =>
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

  it('passes other read errors through instead of calling the file "not a database"', async () => {
    const { hasSqliteHeader } = await loadBackup()
    // A directory: opening or reading it fails with something other than ENOENT.
    expect(() => hasSqliteHeader(userDataDir)).toThrow()
  })
})

describe('effectiveBackupsDir (#506)', () => {
  it('is the default folder without a configured one', async () => {
    const { effectiveBackupsDir, getDefaultBackupsDir } = await loadBackup()
    expect(effectiveBackupsDir(undefined)).toBe(getDefaultBackupsDir())
    expect(effectiveBackupsDir('  ')).toBe(getDefaultBackupsDir())
  })

  it('is the configured folder while it is reachable', async () => {
    const { effectiveBackupsDir } = await loadBackup()
    const custom = join(userDataDir, 'custom')
    expect(effectiveBackupsDir(custom)).toBe(custom)
    expect(existsSync(custom)).toBe(true)
  })

  it('falls back to the default folder and lists its backups while the configured one is unreachable', async () => {
    const { effectiveBackupsDir, getDefaultBackupsDir, listBackups } = await loadBackup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const blocked = join(userDataDir, 'blocked')
    makeFile(blocked)
    mkdirSync(getDefaultBackupsDir(), { recursive: true })
    makeFile(join(getDefaultBackupsDir(), 'backup-daily-2026-11-05.sqlite'))

    const dir = effectiveBackupsDir(blocked, 'backup list shows the default folder')

    expect(dir).toBe(getDefaultBackupsDir())
    expect(listBackups(dir).map((b) => b.filename)).toEqual(['backup-daily-2026-11-05.sqlite'])
    expect(warn).toHaveBeenCalledWith(
      '[backup] Backup folder unreachable, backup list shows the default folder:',
      blocked,
      '->',
      getDefaultBackupsDir(),
      expect.any(Error)
    )
    vi.restoreAllMocks()
  })

  // Known limit (#512): once the configured folder is back, the list shows
  // only that folder; backups written to the default folder meanwhile are
  // not listed there.
  it('shows only the configured folder again once it is reachable', async () => {
    const { effectiveBackupsDir, getDefaultBackupsDir, listBackups } = await loadBackup()
    mkdirSync(getDefaultBackupsDir(), { recursive: true })
    makeFile(join(getDefaultBackupsDir(), 'backup-daily-2026-11-05.sqlite'))
    const custom = join(userDataDir, 'custom')

    expect(listBackups(effectiveBackupsDir(custom))).toEqual([])
  })
})

describe('runDailyBackupIfNeeded fallback (#506)', () => {
  let blocked: string
  let defaultDir: string
  let db: Database.Database
  let runDailyBackupIfNeeded: typeof import('./backup').runDailyBackupIfNeeded

  beforeEach(async () => {
    const backup = await loadBackup()
    runDailyBackupIfNeeded = backup.runDailyBackupIfNeeded
    defaultDir = backup.getDefaultBackupsDir()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 5, 12))
    blocked = join(userDataDir, 'blocked')
    makeFile(blocked)
    db = new DatabaseImpl(join(userDataDir, 'source.sqlite'))
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('backup_path', blocked)
  })

  afterEach(() => {
    db?.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('writes and rotates in the default folder when the configured folder is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mkdirSync(defaultDir)
    const oldNames = Array.from({ length: 7 }, (_, day) => {
      const name = `backup-daily-${localDateKey(new Date(2026, 9, 25 + day))}.sqlite`
      makeFile(join(defaultDir, name))
      return name
    })

    await runDailyBackupIfNeeded(db)

    const todayName = `backup-daily-${localDateKey(new Date())}.sqlite`
    expect(readdirSync(defaultDir).sort()).toEqual([...oldNames.slice(1), todayName])
    expect(warn).toHaveBeenCalledWith(
      '[backup] Backup folder unreachable, daily backup goes to the default folder:',
      blocked,
      '->',
      defaultDir,
      expect.any(Error)
    )
  })

  it('does not create another fallback backup on the same local day', async () => {
    const backup = vi.spyOn(db, 'backup')
    await runDailyBackupIfNeeded(db)
    await runDailyBackupIfNeeded(db)

    expect(backup).toHaveBeenCalledTimes(1)
    expect(readdirSync(defaultDir)).toEqual([`backup-daily-${localDateKey(new Date())}.sqlite`])
  })

  it('returns to the configured folder on the next day when it is reachable again', async () => {
    await runDailyBackupIfNeeded(db)
    const previousName = `backup-daily-${localDateKey(new Date())}.sqlite`
    expect(readdirSync(defaultDir)).toEqual([previousName])
    rmSync(blocked)
    vi.setSystemTime(new Date(2026, 10, 6, 12))

    await runDailyBackupIfNeeded(db)

    expect(readdirSync(blocked)).toEqual([`backup-daily-${localDateKey(new Date())}.sqlite`])
    expect(readdirSync(defaultDir)).toEqual([previousName])
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('backup_path')).toEqual({
      value: blocked
    })
  })
})

describe('runDailyBackupIfNeeded local days (#501)', () => {
  let backupDir: string
  let db: Database.Database
  let runDailyBackupIfNeeded: typeof import('./backup').runDailyBackupIfNeeded

  beforeEach(async () => {
    runDailyBackupIfNeeded = (await loadBackup()).runDailyBackupIfNeeded
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 5, 0, 30))
    backupDir = join(userDataDir, 'custom-backups')
    mkdirSync(backupDir)
    db = new DatabaseImpl(join(userDataDir, 'source.sqlite'))
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('backup_path', backupDir)
  })

  afterEach(() => {
    db?.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('creates only one backup for two calls on the same local day', async () => {
    const backup = vi.spyOn(db, 'backup')
    await runDailyBackupIfNeeded(db)
    vi.setSystemTime(new Date(2026, 10, 5, 12))
    await runDailyBackupIfNeeded(db)
    expect(backup).toHaveBeenCalledTimes(1)
    expect(readdirSync(backupDir)).toEqual(['backup-daily-2026-11-05.sqlite'])
  })

  it('creates a second backup on the next local day', async () => {
    vi.setSystemTime(new Date(2026, 10, 5, 23, 30))
    await runDailyBackupIfNeeded(db)
    vi.setSystemTime(new Date(2026, 10, 6, 0, 30))
    await runDailyBackupIfNeeded(db)
    expect(readdirSync(backupDir).sort()).toEqual([
      'backup-daily-2026-11-05.sqlite',
      'backup-daily-2026-11-06.sqlite'
    ])
  })

  it('rotates eight existing daily files down to the seven newest including today', async () => {
    for (let day = 1; day <= 8; day++) {
      writeFileSync(join(backupDir, `backup-daily-2026-11-0${day}.sqlite`), '')
    }
    vi.setSystemTime(new Date(2026, 10, 9, 0, 30))
    await runDailyBackupIfNeeded(db)
    expect(readdirSync(backupDir).sort()).toEqual([
      'backup-daily-2026-11-03.sqlite',
      'backup-daily-2026-11-04.sqlite',
      'backup-daily-2026-11-05.sqlite',
      'backup-daily-2026-11-06.sqlite',
      'backup-daily-2026-11-07.sqlite',
      'backup-daily-2026-11-08.sqlite',
      'backup-daily-2026-11-09.sqlite'
    ])
  })

  it('names the daily file using localDateKey(now)', async () => {
    const now = new Date('2026-11-04T23:30:00Z')
    vi.setSystemTime(now)
    await runDailyBackupIfNeeded(db)
    expect(readdirSync(backupDir)).toEqual([`backup-daily-${localDateKey(now)}.sqlite`])
  })
})
