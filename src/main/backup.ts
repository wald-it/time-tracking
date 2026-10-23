import type Database from 'better-sqlite3'
import { app } from 'electron'
import { join, normalize } from 'path'
import {
  mkdirSync,
  existsSync,
  copyFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync
} from 'fs'

export type BackupReason = 'daily' | 'manual' | 'pre-migration' | 'mcp'

export interface BackupInfo {
  filename: string
  fullPath: string
  reason: BackupReason
  /** ISO timestamp from filename (daily) or file mtime (others). */
  createdAt: string
  sizeBytes: number
}

const DAILY_RETENTION = 7

/**
 * Naming scheme:
 *   daily         -> backup-daily-YYYY-MM-DD.sqlite
 *   manual        -> backup-manual-YYYY-MM-DDTHH-mm-ss-sssZ.sqlite
 *   pre-migration -> backup-pre-migration-v{from}-YYYY-MM-DDTHH-mm-ss-sssZ.sqlite
 *
 * Rotation only deletes `daily` backups; manual + pre-migration are kept forever.
 */

export function getDefaultBackupsDir(): string {
  return join(app.getPath('userData'), 'backups')
}

export function getBackupsDir(backupPathOverride?: string): string {
  const dir = backupPathOverride?.trim()
    ? normalize(backupPathOverride.trim())
    : getDefaultBackupsDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

function isoTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD
}

function buildFilename(reason: BackupReason, fromVersion?: number): string {
  switch (reason) {
    case 'daily':
      return `backup-daily-${todayDate()}.sqlite`
    case 'manual':
      return `backup-manual-${isoTimestamp()}.sqlite`
    case 'pre-migration':
      return `backup-pre-migration-v${fromVersion ?? 0}-${isoTimestamp()}.sqlite`
    case 'mcp':
      return `backup-mcp-${isoTimestamp()}.sqlite`
  }
}

function classify(filename: string): BackupReason | null {
  if (filename.startsWith('backup-daily-')) return 'daily'
  if (filename.startsWith('backup-manual-')) return 'manual'
  if (filename.startsWith('backup-mcp-')) return 'mcp'
  if (filename.startsWith('backup-pre-migration-')) return 'pre-migration'
  // Legacy v1.1.0 pre-migration filename.
  if (filename.startsWith('pre-migration-')) return 'pre-migration'
  return null
}

/**
 * Create a backup using better-sqlite3's atomic backup API.
 * Safe even with concurrent writers (uses SQLite's online backup).
 */
export async function createBackup(
  db: Database.Database,
  reason: BackupReason,
  fromVersion?: number,
  backupDirOverride?: string
): Promise<string> {
  const dir = getBackupsDir(backupDirOverride)
  const targetPath = join(dir, buildFilename(reason, fromVersion))
  // db.backup() returns a Promise that resolves with progress info.
  await db.backup(targetPath)
  console.log(`[backup] Created (${reason}): ${targetPath}`)
  return targetPath
}

/**
 * Write a consistent copy of the OPEN database to `targetPath` (`VACUUM INTO`).
 *
 * The database runs in WAL mode: commits can still sit in the `-wal` file,
 * not yet checkpointed into the main file — always after a crash or a killed
 * process. A plain file copy of the main file would miss them; `VACUUM INTO`
 * reads through the connection and so includes them.
 */
export function snapshotSync(db: Database.Database, targetPath: string): void {
  db.prepare('VACUUM INTO ?').run(targetPath)
}

/**
 * Synchronous backup for the migration runner: a consistent snapshot of the
 * open database before any migration touches it.
 */
export function createBackupSync(
  db: Database.Database,
  reason: BackupReason,
  fromVersion?: number
): string {
  // Always use the default dir — called from the migration runner before
  // DB settings are available, so backup_path cannot be read yet.
  const dir = getDefaultBackupsDir()
  mkdirSync(dir, { recursive: true })
  const targetPath = join(dir, buildFilename(reason, fromVersion))
  snapshotSync(db, targetPath)
  console.log(`[backup] Created sync (${reason}): ${targetPath}`)
  return targetPath
}

/** The database file cannot be replaced: another process still has it open. */
export class DbInUseError extends Error {
  constructor(cause: unknown) {
    super('Database is still open in another process', { cause })
    this.name = 'DbInUseError'
  }
}

/**
 * Put `sourcePath` in place of the database file. The database must be
 * CLOSED. Its `-wal` / `-shm` files go first: SQLite would otherwise replay a
 * leftover WAL over the restored file on the next open. If one of them cannot
 * be removed — on Windows another process (e.g. the MCP server) still holds
 * the database open — this throws `DbInUseError` before the database file is
 * touched. (macOS/Linux let the files go even under an open reader; that
 * reader then sees an inconsistent state until it restarts, which is why the
 * restore confirmation asks to quit MCP clients first.)
 */
export function replaceDbFile(sourcePath: string, dbPath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const side = dbPath + suffix
    if (!existsSync(side)) continue
    try {
      unlinkSync(side)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw new DbInUseError(err)
      throw err
    }
  }
  copyFileSync(sourcePath, dbPath)
}

export function listBackups(backupPathOverride?: string): BackupInfo[] {
  const dir = getBackupsDir(backupPathOverride)
  const entries = readdirSync(dir)
  const result: BackupInfo[] = []
  for (const filename of entries) {
    if (!filename.endsWith('.sqlite')) continue
    const reason = classify(filename)
    if (!reason) continue
    const fullPath = join(dir, filename)
    const stat = statSync(fullPath)
    let createdAt: string
    if (reason === 'daily') {
      const m = filename.match(/(\d{4}-\d{2}-\d{2})/)
      createdAt = m ? `${m[1]}T00:00:00.000Z` : stat.mtime.toISOString()
    } else {
      createdAt = stat.mtime.toISOString()
    }
    result.push({
      filename,
      fullPath,
      reason,
      createdAt,
      sizeBytes: stat.size
    })
  }
  return result.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1')

/** True when the file starts with the 16-byte SQLite database header. */
export function hasSqliteHeader(path: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(SQLITE_HEADER.length)
    const read = readSync(fd, buf, 0, buf.length, 0)
    return read === buf.length && buf.equals(SQLITE_HEADER)
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Keep only the last N daily backups. Manual + pre-migration are never deleted.
 */
export function rotateDailyBackups(retain = DAILY_RETENTION, backupDirOverride?: string): string[] {
  const dailies = listBackups(backupDirOverride).filter((b) => b.reason === 'daily')
  // listBackups returns newest first; entries beyond `retain` are old.
  const toDelete = dailies.slice(retain)
  for (const b of toDelete) {
    try {
      unlinkSync(b.fullPath)
      console.log(`[backup] Rotated out: ${b.filename}`)
    } catch (err) {
      console.warn(`[backup] Could not delete ${b.filename}:`, err)
    }
  }
  return toDelete.map((b) => b.filename)
}

/**
 * Create today's daily backup if it doesn't already exist.
 * Failures are logged but never thrown — backup must not block app start.
 */
export async function runDailyBackupIfNeeded(db: Database.Database): Promise<void> {
  try {
    const override = readBackupPathSetting(db)
    const today = todayDate()
    const existing = listBackups(override).find(
      (b) => b.reason === 'daily' && b.filename.includes(today)
    )
    if (existing) return
    await createBackup(db, 'daily', undefined, override)
    rotateDailyBackups(DAILY_RETENTION, override)
  } catch (err) {
    console.warn('[backup] Daily backup failed (non-fatal):', err)
  }
}

/**
 * Read the `backup_path` setting from the DB.
 * Returns the trimmed value, or `undefined` when absent / empty (meaning: use default dir).
 */
export function readBackupPathSetting(db: Database.Database): string | undefined {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'backup_path'").get() as
      | { value: string }
      | undefined
    return row?.value?.trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Restore a backup file over the current DB. The caller passes the OPEN
 * handle; this closes it. The caller then prompts the user to restart.
 *
 * Before overwriting, a safety snapshot of the current DB is taken (through
 * the connection, so it includes what still sits in the WAL) so the user can
 * roll back if the chosen backup turns out to be worse than the current state.
 */
export function restoreBackup(
  db: Database.Database,
  backupPath: string,
  currentDbPath: string
): { safetyBackupPath: string } {
  if (!existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`)
  }
  // #272: never put something other than a database in place of the DB file.
  if (!hasSqliteHeader(backupPath)) {
    throw new Error(`Not a SQLite database: ${backupPath}`)
  }
  // Safety copy always goes to the default dir — never depends on network paths.
  const dir = getDefaultBackupsDir()
  mkdirSync(dir, { recursive: true })
  const safetyName = `backup-pre-restore-${isoTimestamp()}.sqlite`
  const safetyBackupPath = join(dir, safetyName)
  snapshotSync(db, safetyBackupPath)
  db.close()
  replaceDbFile(backupPath, currentDbPath)
  console.log(`[backup] Restored ${backupPath} -> ${currentDbPath}`)
  return { safetyBackupPath }
}

/** What the user is told when a restore did not happen. */
export const RESTORE_FAILED_TITLE = 'TimeTrack — Wiederherstellung nicht durchgeführt'
export const RESTORE_IN_USE_MESSAGE =
  'Wiederherstellung nicht durchgeführt — die Datenbank ist noch in einem anderen Programm ' +
  'geöffnet (z. B. ein MCP-Client wie Claude Desktop). Programm beenden und erneut versuchen.'

/**
 * `restoreBackup` for the IPC handler: a failure is reported through
 * `report` (a native dialog in the app) before the result goes back. The
 * renderer relaunches the app after every restore attempt, so a message shown
 * only in the renderer would vanish with the window and the user would take
 * the relaunch for a successful restore.
 */
export function restoreBackupOrReport(
  db: Database.Database,
  backupPath: string,
  currentDbPath: string,
  report: (title: string, message: string) => void
): { ok: true; data: { safetyBackupPath: string } } | { ok: false; error: string } {
  try {
    return { ok: true, data: restoreBackup(db, backupPath, currentDbPath) }
  } catch (err) {
    const message =
      err instanceof DbInUseError
        ? RESTORE_IN_USE_MESSAGE
        : `Wiederherstellung nicht durchgeführt: ${(err as Error).message}`
    report(RESTORE_FAILED_TITLE, message)
    return { ok: false, error: message }
  }
}

export const RESTORE_UNKNOWN_MESSAGE =
  'Wiederherstellung nicht durchgeführt — diese Backup-Datei steht nicht in der Backup-Liste.'

/**
 * #272 — `backup:restore` takes the file NAME of a backup that `listBackups`
 * shows for the current backup folder, never a path. Anything else is refused
 * before the open database is touched.
 */
export function restoreListedBackupOrReport(
  db: Database.Database,
  filename: unknown,
  backupPathOverride: string | undefined,
  currentDbPath: string,
  report: (title: string, message: string) => void
): { ok: true; data: { safetyBackupPath: string } } | { ok: false; error: string } {
  let listed: BackupInfo | undefined
  try {
    listed =
      typeof filename === 'string'
        ? listBackups(backupPathOverride).find((b) => b.filename === filename)
        : undefined
  } catch (err) {
    // The folder is unreachable (an offline network share): say so here, the
    // renderer relaunches right after and would swallow its own message.
    const message = `Wiederherstellung nicht durchgeführt: ${(err as Error).message}`
    report(RESTORE_FAILED_TITLE, message)
    return { ok: false, error: message }
  }
  if (!listed) {
    report(RESTORE_FAILED_TITLE, RESTORE_UNKNOWN_MESSAGE)
    return { ok: false, error: RESTORE_UNKNOWN_MESSAGE }
  }
  return restoreBackupOrReport(db, listed.fullPath, currentDbPath, report)
}
