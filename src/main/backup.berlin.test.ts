import { afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runDailyBackupIfNeeded } from './backup'

vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }))

let userDataDir: string

afterEach(() => {
  vi.useRealTimers()
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})

it('uses November 5 in Berlin when UTC is still November 4', async () => {
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Berlin')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-04T23:30:00Z'))
  userDataDir = mkdtempSync(join(tmpdir(), 'tt-daily-berlin-'))
  const db = new Database(join(userDataDir, 'source.sqlite'))
  try {
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
    await runDailyBackupIfNeeded(db)
    expect(readdirSync(join(userDataDir, 'backups'))).toEqual(['backup-daily-2026-11-05.sqlite'])
  } finally {
    db.close()
  }
})
