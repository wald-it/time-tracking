import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, normalize } from 'path'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import type { BackupInfo, IpcResult } from '../shared/types'
import { de } from '../shared/locales/de'
import { registerIpcHandlers, type IpcHooks } from './ipc'
import { runDailyBackupIfNeeded } from './backup'

const { handlers, state, report } = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: unknown, ...args: unknown[]) => IpcResult<unknown> | Promise<IpcResult<unknown>>
  >(),
  state: { db: undefined as Database.Database | undefined, dir: '' },
  report: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: never) => handlers.set(channel, handler),
    on: vi.fn()
  },
  app: { getPath: () => state.dir },
  shell: {},
  dialog: { showErrorBox: report }
}))
vi.mock('./db', () => ({
  getDb: () => state.db,
  getDbPath: () => join(state.dir, 'current.sqlite')
}))

let Sqlite: DatabaseCtor
let db: Database.Database
let custom: string
let defaultDir: string
const NAME = 'backup-daily-2026-11-05.sqlite'
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'tt-ipc-backups-'))
  custom = join(state.dir, 'custom')
  defaultDir = join(state.dir, 'backups')
  db = new Sqlite(join(state.dir, 'current.sqlite'))
  applyMigrations(db)
  db.exec("CREATE TABLE backup_content (value TEXT); INSERT INTO backup_content VALUES ('CURRENT')")
  db.prepare("UPDATE settings SET value = ? WHERE key = 'backup_path'").run(custom)
  state.db = db
  handlers.clear()
  report.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  registerIpcHandlers({} as IpcHooks)
})
afterEach(() => {
  if (db?.open) db.close()
  rmSync(state.dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})
async function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return (await handlers.get(channel)!(null, ...args)) as IpcResult<T>
}
function backup(dir: string, value: string, filename = NAME): void {
  mkdirSync(dir, { recursive: true })
  const file = new Sqlite(join(dir, filename))
  file.exec('CREATE TABLE backup_content (value TEXT)')
  file.prepare('INSERT INTO backup_content VALUES (?)').run(value)
  file.close()
}
function restoredValue(): string {
  const restored = new Sqlite(join(state.dir, 'current.sqlite'))
  try {
    return (restored.prepare('SELECT value FROM backup_content').get() as { value: string }).value
  } finally {
    restored.close()
  }
}

describe('backup IPC folder binding (#512)', () => {
  it('keeps a daily fallback listed after recovery, alongside the custom backups, newest first', async () => {
    writeFileSync(custom, 'blocked')
    await runDailyBackupIfNeeded(db)
    const fallback = readdirSync(defaultDir)[0]
    rmSync(custom)
    backup(custom, 'CUSTOM', 'backup-daily-2000-01-01.sqlite')
    const result = await invoke<BackupInfo[]>('backup:list')
    expect(result).toMatchObject({
      ok: true,
      data: [
        { filename: fallback, folder: 'default' },
        { filename: 'backup-daily-2000-01-01.sqlite', folder: 'custom' }
      ]
    })
  })

  it.each(['custom', 'default'] as const)(
    'restores the same-named daily from %s',
    async (folder) => {
      backup(custom, 'CUSTOM')
      backup(defaultDir, 'DEFAULT')
      await invoke('backup:list')
      expect(await invoke('backup:restore', NAME, folder)).toMatchObject({ ok: true })
      expect(restoredValue()).toBe(folder.toUpperCase())
    }
  )

  it('refuses ambiguous folder-less names and unknown or invalid pairs without closing the DB', async () => {
    backup(custom, 'CUSTOM')
    backup(defaultDir, 'DEFAULT')
    await invoke('backup:list')
    for (const args of [
      [NAME],
      [NAME, 'other'],
      [NAME, null],
      ['missing.sqlite', 'custom'],
      ['../' + NAME, 'default'],
      [42, 'default']
    ]) {
      expect(await invoke('backup:restore', ...args)).toMatchObject({ ok: false })
      expect(db.open).toBe(true)
      expect(report).toHaveBeenLastCalledWith(expect.any(String), de['mainDialog.restore.unknown'])
    }
  })

  it('accepts a unique folder-less filename from the merged list', async () => {
    backup(custom, 'CUSTOM', 'backup-daily-2000-01-01.sqlite')
    backup(defaultDir, 'DEFAULT')
    await invoke('backup:list')
    expect(await invoke('backup:restore', NAME)).toMatchObject({ ok: true })
    expect(restoredValue()).toBe('DEFAULT')
  })

  it('does not swap in a same-named custom file if the folder recovers after listing (#513 P1)', async () => {
    writeFileSync(custom, 'blocked')
    backup(defaultDir, 'DEFAULT')
    await invoke('backup:list')
    rmSync(custom)
    backup(custom, 'CUSTOM')
    expect(await invoke('backup:restore', NAME)).toMatchObject({ ok: true })
    expect(restoredValue()).toBe('DEFAULT')
  })

  it('keeps a listed custom binding when the setting changes and refuses if that file vanishes', async () => {
    backup(custom, 'CUSTOM')
    await invoke('backup:list')
    backup(defaultDir, 'DEFAULT')
    db.prepare("UPDATE settings SET value = '' WHERE key = 'backup_path'").run()
    rmSync(join(custom, NAME))
    expect(await invoke('backup:restore', NAME, 'custom')).toMatchObject({ ok: false })
    expect(db.open).toBe(true)
  })

  it('keeps the effective-folder behavior before any list for a folder-less call', async () => {
    writeFileSync(custom, 'blocked')
    backup(defaultDir, 'DEFAULT')
    expect(await invoke('backup:restore', NAME)).toMatchObject({ ok: true })
    expect(restoredValue()).toBe('DEFAULT')
  })

  it('refuses an explicit folder before any listing', async () => {
    backup(custom, 'CUSTOM')
    expect(await invoke('backup:restore', NAME, 'custom')).toMatchObject({ ok: false })
    expect(db.open).toBe(true)
  })

  it.each([false, true])(
    'lists the default folder once when the custom path is equivalent (case variant: %s)',
    async (caseVariant) => {
      backup(defaultDir, 'DEFAULT')
      const configured =
        caseVariant && process.platform === 'win32'
          ? defaultDir.toUpperCase()
          : `${defaultDir}/../backups/`
      db.prepare("UPDATE settings SET value = ? WHERE key = 'backup_path'").run(configured)
      expect(await invoke('backup:list')).toMatchObject({
        ok: true,
        data: [{ filename: NAME, folder: 'default' }]
      })
    }
  )

  it('lists only default backups without a custom path or while it is unreachable', async () => {
    backup(defaultDir, 'DEFAULT')
    writeFileSync(custom, 'blocked')
    expect(await invoke('backup:list')).toMatchObject({
      ok: true,
      data: [{ filename: NAME, folder: 'default' }]
    })
    db.prepare("UPDATE settings SET value = '' WHERE key = 'backup_path'").run()
    expect(await invoke('backup:list')).toMatchObject({
      ok: true,
      data: [{ filename: NAME, folder: 'default' }]
    })
  })

  it.each(['blocked', 'reachable', 'unset'] as const)(
    'manual backup uses the effective folder and reports fallback: %s',
    async (mode) => {
      if (mode === 'blocked') writeFileSync(custom, 'blocked')
      if (mode === 'unset')
        db.prepare("UPDATE settings SET value = '' WHERE key = 'backup_path'").run()
      const result = await invoke<{ path: string; usedDefaultFolder: boolean }>('backup:create')
      expect(result).toMatchObject({ ok: true, data: { usedDefaultFolder: mode === 'blocked' } })
      if (!result.ok) throw new Error(result.error)
      const target = mode === 'reachable' ? custom : defaultDir
      expect(normalize(result.data.path)).toBe(join(target, readdirSync(target)[0]))
      const saved = new Sqlite(result.data.path)
      try {
        expect(saved.prepare('SELECT value FROM backup_content').get()).toEqual({
          value: 'CURRENT'
        })
      } finally {
        saved.close()
      }
    }
  )
})
