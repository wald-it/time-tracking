/**
 * Migration 027 against the "Heute" totals (`readTotals`, the stat cards, the
 * tray and the Stream Deck dial): rows that were canonical already give the
 * same today/week seconds before and after; rewritten rows give what their
 * parsed instants call for.
 *
 * Deliberately NOT pinned to a time zone: `readTotals` cuts the day with
 * SQLite's `DATE(…,'localtime')` against `'now'`, and on Windows SQLite's
 * 'localtime' ignores process.env.TZ (#248) — a pin would leave JS and SQLite
 * on two clocks. Unpinned, both read the runner's zone. The rows are placed
 * between local midnight and now, so they are "today" whenever this runs.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { executeMigration, migrations } from './index'
import { loadSqlite, type DatabaseCtor } from '../../test/sqlite'
import { readTotals } from '../dashboardTotals'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** `YYYY-MM-DDTHH:MM:SS` local wall clock, no zone — as a 1.21.0 MCP write could leave it. */
function zoneless(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** The same instant written with an explicit offset of +05:30. */
function withOffset(ms: number): string {
  const d = new Date(ms + (5 * 60 + 30) * 60_000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+05:30`
}

/** `Z` without milliseconds. */
function zNoMs(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z')
}

describe('migration 027 — Heute totals before and after', () => {
  let tmpDir: string
  let db: Database.Database
  /** Whole-second slots between local midnight and now, ending before now. */
  let slots: Array<{ start: number; stop: number }>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-m027-totals-'))
    db = new DatabaseImpl(join(tmpDir, 'test.sqlite'))
    db.exec(
      `CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    )
    for (const m of migrations.filter((mm) => mm.version <= 26)) {
      db.transaction(() => executeMigration(db, m))()
    }
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()

    const now = Math.floor(Date.now() / 1000) * 1000
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    const span = now - midnight.getTime()
    // Six slots spread over today so far, each at most a minute long.
    const n = 6
    const step = Math.floor(span / (n + 1) / 1000) * 1000
    const len = Math.max(1000, Math.min(60_000, Math.floor(step / 2000) * 1000))
    slots = Array.from({ length: n }, (_, i) => {
      const start = midnight.getTime() + 1000 + i * step
      return { start, stop: start + len }
    })
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const insert = (
    id: number,
    started: string,
    stopped: string,
    deleted: string | null = null
  ): void => {
    db.prepare(
      `INSERT INTO entries (id, client_id, started_at, stopped_at, deleted_at) VALUES (?, 1, ?, ?, ?)`
    ).run(id, started, stopped, deleted)
  }
  const apply27 = (): void =>
    db.transaction(() => executeMigration(db, migrations.find((m) => m.version === 27)!))()

  it('rows that were canonical already: the same today and week seconds', () => {
    slots.slice(0, 3).forEach((s, i) => {
      insert(i + 1, new Date(s.start).toISOString(), new Date(s.stop).toISOString())
    })
    // A canonical soft-deleted row: counted neither before nor after.
    const g = slots[3]
    insert(
      9,
      new Date(g.start).toISOString(),
      new Date(g.stop).toISOString(),
      new Date().toISOString()
    )
    const before = readTotals(db)
    apply27()
    expect(readTotals(db)).toEqual(before)
    const expected = slots.slice(0, 3).reduce((sum, s) => sum + (s.stop - s.start) / 1000, 0)
    expect(before.today_seconds).toBe(expected)
  })

  it('rewritten rows: today and week equal the parsed instants', () => {
    const [a, b, c, d, e, f] = slots
    insert(1, withOffset(a.start), withOffset(a.stop))
    insert(2, zoneless(b.start), zoneless(b.stop))
    insert(3, zNoMs(c.start), zNoMs(c.stop))
    insert(4, new Date(d.start).toISOString(), zoneless(d.stop))
    // Soft-deleted in old forms: rewritten, still not counted.
    insert(5, zoneless(e.start), zoneless(e.stop), new Date().toISOString())
    insert(6, withOffset(f.start), withOffset(f.stop), new Date().toISOString())
    apply27()
    const expected = [a, b, c, d].reduce((sum, s) => sum + (s.stop - s.start) / 1000, 0)
    const totals = readTotals(db)
    expect(totals.today_seconds).toBe(expected)
    // Today lies inside this week, whatever the week start.
    expect(totals.week_seconds).toBe(expected)
  })
})
