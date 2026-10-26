/**
 * The backup probe (design doc L7): it copies, runs the P1 migration on the
 * copy, rolls back, and reports. The databases come from the seeded generator,
 * never from real data. Pinned to Europe/Berlin like migrateV2.test.ts, in a
 * file of its own because a TZ pin leaks into later tests of the same file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import {
  createMigratedTemplate,
  loadSqlite,
  openMigratedCopy,
  type DatabaseCtor
} from '../../test/sqlite'
import { generateLegacyDb } from '../../test/legacyEntriesGenerator'
import { formatProbeResult, runBackupProbe } from './backupProbe'

let Ctor: DatabaseCtor
let templateDir: string
let template: string
const previousTz = process.env.TZ

beforeAll(async () => {
  process.env.TZ = 'Europe/Berlin'
  Ctor = await loadSqlite()
  templateDir = mkdtempSync(join(tmpdir(), 'tt-probe-template-'))
  template = createMigratedTemplate(Ctor, templateDir)
})
afterAll(() => {
  rmSync(templateDir, { recursive: true, force: true })
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

let dir: string
let backup: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-probe-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A "backup" file: a closed 1.x database filled by the generator. */
function makeBackup(seed: number, tweak?: (db: Database.Database) => void): void {
  const db = openMigratedCopy(Ctor, template, dir)
  generateLegacyDb(db, seed)
  tweak?.(db)
  db.close()
  backup = join(dir, 'backup-daily-2026-10-26.sqlite')
  copyFileSync(join(dir, 'test.sqlite'), backup)
}

const tablesOf = (path: string): string[] => {
  const db = new Ctor(path)
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name)
  } finally {
    db.close()
  }
}

describe('runBackupProbe', () => {
  it('reports the shapes and exceptions and leaves source and copy as 1.x', () => {
    makeBackup(1)
    const before = readFileSync(backup)
    const work = join(dir, 'work')
    const result = runBackupProbe(Ctor, backup, work)

    expect(result.outcome.kind).toBe('report')
    if (result.outcome.kind !== 'report') return
    const { report } = result.outcome
    expect(report.legacyRows).toBeGreaterThan(0)
    expect(report.entries).toBeGreaterThan(0)
    expect(report.exceptions.map((e) => e.code)).toContain('migration.sameDayPair')

    // The source was only copied; the copy was rolled back to the 1.x schema.
    expect(readFileSync(backup).equals(before)).toBe(true)
    expect(result.copyPath.startsWith(work)).toBe(true)
    expect(tablesOf(result.copyPath)).not.toContain('entry')
    expect(tablesOf(result.copyPath)).toContain('entries')

    const text = formatProbeResult(result)
    expect(text).toContain('migration.sameDayPair')
    expect(text).toContain('Self-check passed')
    for (const e of report.exceptions) expect(text).toContain(`ids ${e.legacyIds.join(', ')}`)
  })

  it('can run twice on the same work directory (nothing is left behind)', () => {
    makeBackup(2)
    const work = join(dir, 'work')
    const first = runBackupProbe(Ctor, backup, work)
    const second = runBackupProbe(Ctor, backup, work)
    expect(second.outcome).toEqual(first.outcome)
  })

  it('reports an abort as a result, with code and id', () => {
    makeBackup(3, (db) => {
      db.prepare("UPDATE entries SET started_at = 'not a date' WHERE id = 1").run()
    })
    const result = runBackupProbe(Ctor, backup, join(dir, 'work'))
    expect(result.outcome).toMatchObject({ kind: 'abort', code: 'migration.timestampUnreadable' })
    const text = formatProbeResult(result)
    expect(text).toContain('ABORTED: migration.timestampUnreadable')
    expect(text).toContain('id 1:')
    expect(tablesOf(result.copyPath)).not.toContain('entry')
  })

  it('rethrows what is not an abort (a file that is no database)', () => {
    const bogus = join(dir, 'backup-bogus.sqlite')
    writeFileSync(bogus, 'this is not sqlite, and long enough to be read as a header '.repeat(4))
    expect(() => runBackupProbe(Ctor, bogus, join(dir, 'work'))).toThrow()
  })

  it('refuses a missing source and a source with WAL sidecars', () => {
    expect(() => runBackupProbe(Ctor, join(dir, 'nope.sqlite'), join(dir, 'work'))).toThrow(
      /not found/
    )
    makeBackup(4)
    writeFileSync(`${backup}-wal`, '')
    expect(() => runBackupProbe(Ctor, backup, join(dir, 'work'))).toThrow(/self-contained/)
  })
})
