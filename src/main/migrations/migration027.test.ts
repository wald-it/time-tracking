/**
 * Migration 027 rewrites stored timestamps the way the app read them with
 * new Date() (#246): offset or Z as given, zone-less as local time, the first
 * of the doubled hour, a bare date as UTC midnight.
 * Pinned to Europe/Berlin for the whole file, on purpose in a file of its own:
 * `delete process.env.TZ` does not reset Node's time zone, so a pin inside a
 * shared test file leaks into the tests after it. Vitest runs each test file
 * in its own process.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { executeMigration, migrations } from './index'
import { loadSqlite, type DatabaseCtor } from '../../test/sqlite'

let DatabaseImpl: DatabaseCtor
const previousTz = process.env.TZ

beforeAll(async () => {
  process.env.TZ = 'Europe/Berlin'
  DatabaseImpl = await loadSqlite()
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

describe('migration 027', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-migration027-'))
    db = new DatabaseImpl(join(tmpDir, 'test.sqlite'))
    db.pragma('foreign_keys = ON')
    db.exec(
      `CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    )
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function apply(filter: (version: number) => boolean): void {
    for (const m of migrations.filter((mm) => filter(mm.version))) {
      db.transaction(() => {
        executeMigration(db, m)
        db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
          m.version,
          m.name
        )
      })()
    }
  }
  const applyUpTo = (v: number): void => apply((x) => x <= v)
  const applyVersion = (v: number): void => apply((x) => x === v)

  it('rewrites timestamps the way the app read them, leaves canonical and unreadable ones', () => {
    applyUpTo(26)
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    const ins = db.prepare(
      `INSERT INTO entries (id, client_id, started_at, stopped_at, heartbeat_at) VALUES (?, 1, ?, ?, ?)`
    )
    // start_timer with an offset, as the old startTimer stored it
    ins.run(1, '2026-10-01T00:30:00+02:00', '2026-10-01T01:00:00.000Z', '2026-10-01T00:30:00+02:00')
    // seconds only, no milliseconds
    ins.run(2, '2026-10-02T08:00:00Z', null, null)
    // already canonical
    ins.run(3, '2026-10-03T08:00:00.000Z', '2026-10-03T09:00:00.000Z', null)
    // unreadable: left as it is rather than nulled
    ins.run(4, 'kaputt', null, null)
    // no zone: local time, as new Date read it
    ins.run(5, '2026-10-01T00:30:00', null, null)
    // the hour that exists twice when the clocks go back: new Date takes the first
    ins.run(6, '2026-10-25T02:30:00', null, null)
    // a bare date: new Date reads it as UTC midnight, not local
    ins.run(7, '2026-10-01', null, null)
    // space instead of T: local time, as new Date read it
    ins.run(8, '2026-10-01 08:00', null, null)
    applyVersion(27)
    const rows = db.prepare('SELECT id, started_at, stopped_at FROM entries ORDER BY id').all()
    expect(rows).toEqual([
      { id: 1, started_at: '2026-09-30T22:30:00.000Z', stopped_at: '2026-10-01T01:00:00.000Z' },
      { id: 2, started_at: '2026-10-02T08:00:00.000Z', stopped_at: null },
      { id: 3, started_at: '2026-10-03T08:00:00.000Z', stopped_at: '2026-10-03T09:00:00.000Z' },
      { id: 4, started_at: 'kaputt', stopped_at: null },
      { id: 5, started_at: '2026-09-30T22:30:00.000Z', stopped_at: null },
      { id: 6, started_at: '2026-10-25T00:30:00.000Z', stopped_at: null },
      { id: 7, started_at: '2026-10-01T00:00:00.000Z', stopped_at: null },
      { id: 8, started_at: '2026-10-01T06:00:00.000Z', stopped_at: null }
    ])
    const hb = db.prepare('SELECT heartbeat_at FROM entries WHERE id = 1').get() as {
      heartbeat_at: string
    }
    expect(hb.heartbeat_at).toBe('2026-09-30T22:30:00.000Z')
  })
})
