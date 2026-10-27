import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import {
  applyMigrations,
  createMigratedTemplate,
  LAST_V1_VERSION,
  loadSqlite,
  openMigratedCopy,
  type DatabaseCtor
} from './sqlite'
import { generateLegacyDb } from './legacyEntriesGenerator'

let Ctor: DatabaseCtor
let dir: string
const handles: Database.Database[] = []

beforeAll(async () => {
  Ctor = await loadSqlite()
})
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-sqlite-helpers-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of handles.splice(0)) db.close()
  rmSync(dir, { recursive: true, force: true })
})

function openDb(): Database.Database {
  const db = new Ctor(join(dir, 'test.sqlite'))
  handles.push(db)
  return db
}

describe('SQLite test helpers (#378)', () => {
  it('disables synchronous writes when applying migrations in rollback-journal mode', () => {
    const db = openDb()
    expect(db.pragma('journal_mode', { simple: true })).toBe('delete')
    expect(db.pragma('synchronous', { simple: true })).not.toBe(0)

    applyMigrations(db)

    expect(db.pragma('synchronous', { simple: true })).toBe(0)
    expect(db.pragma('journal_mode', { simple: true })).toBe('delete')
  })

  it('preserves the synchronous default when WAL was enabled before applying migrations', () => {
    const db = openDb()
    db.pragma('journal_mode = WAL')
    // SQLite applies its WAL synchronous default on the first database access.
    db.prepare('SELECT name FROM sqlite_master').all()
    const synchronous = db.pragma('synchronous', { simple: true })
    expect(synchronous).not.toBe(0)

    applyMigrations(db)

    expect(db.pragma('synchronous', { simple: true })).toBe(synchronous)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
  })

  it('disables synchronous writes on a fresh template copy and keeps rollback journaling', () => {
    const template = createMigratedTemplate(Ctor, dir)
    const copyDir = join(dir, 'copy')
    mkdirSync(copyDir)
    const db = openMigratedCopy(Ctor, template, copyDir)
    handles.push(db)

    expect(db.pragma('synchronous', { simple: true })).toBe(0)
    expect(db.pragma('journal_mode', { simple: true })).toBe('delete')
  })

  it('writes all legacy clients, projects, settings and entries in exactly one transaction', () => {
    const db = openDb()
    applyMigrations(db, LAST_V1_VERSION)
    const writes: { table: string; inTransaction: boolean }[] = []
    // Observe actual SQLite writes, independently of prepare/run usage.
    db.function('record_write', (table: string) => {
      writes.push({ table, inTransaction: db.inTransaction })
      return 0
    })
    for (const table of ['clients', 'projects', 'settings', 'entries']) {
      const event = table === 'settings' ? 'UPDATE' : 'INSERT'
      db.exec(`CREATE TEMP TRIGGER record_${table} AFTER ${event} ON ${table}
        BEGIN SELECT record_write('${table}'); END`)
    }
    const transaction = vi.spyOn(db, 'transaction')

    const generated = generateLegacyDb(db, 5)

    expect(writes.map(({ table }) => table)).toEqual([
      ...Array(3).fill('clients'),
      ...Array(4).fill('projects'),
      ...Array(2).fill('settings'),
      ...Array(generated.rows.length).fill('entries')
    ])
    expect(writes.every(({ inTransaction }) => inTransaction)).toBe(true)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(db.inTransaction).toBe(false)
  })
})
