import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { startTimer, stopEntryAt } from './entryMutations'

let Sqlite: DatabaseCtor
let db: Database.Database
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
afterEach(() => db.close())

describe('long-running stop across local midnight', () => {
  it.each([
    [1, 23, 30, 1],
    [2, 1, 0, 2]
  ])('stop on day %s at %s:%s makes %s segments', (day, hour, minute, count) => {
    db = new Sqlite(':memory:')
    applyMigrations(db)
    db.exec(
      "INSERT INTO clients (id, name, color, active, rate_cent) VALUES (1, 'Acme', '#111', 1, 0)"
    )
    const now = new Date(2026, 10, 2, 2).toISOString()
    const start = startTimer(
      db,
      { client_id: 1, description: '', started_at: new Date(2026, 10, 1, 18).toISOString() },
      { now }
    )
    if (!start.ok) throw new Error(start.error)
    const stoppedAt = new Date(2026, 10, day, hour, minute).toISOString()
    const stopped = stopEntryAt(db, start.data.id, stoppedAt, { now })
    expect(stopped.ok).toBe(true)
    const segments = db
      .prepare('SELECT * FROM entries WHERE id = ? ORDER BY started_at')
      .all(start.data.id) as { started_at: string; stopped_at: string }[]
    expect(segments).toHaveLength(count)
    expect(segments[0].started_at).toBe(start.data.started_at)
    expect(segments.at(-1)?.stopped_at).toBe(stoppedAt)
    if (count === 2) expect(segments[0].stopped_at).toBe(new Date(2026, 10, 2).toISOString())
  })
})
