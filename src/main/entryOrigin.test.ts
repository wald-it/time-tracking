import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import type { Entry } from '../shared/types'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import { monthEntries } from './entryRanges'
import { readTodayEntries } from './dashboardTotals'
import { updateManualEntry } from './entryMutations'

let Sqlite: DatabaseCtor
let db: Database.Database
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
beforeEach(() => {
  db = new Sqlite(':memory:')
  applyMigrations(db)
  db.exec("INSERT INTO clients (id, name) VALUES (1, 'Client')")
})
afterEach(() => db.close())

it.each(['month', 'today'] as const)(
  '%s rows carry the current version source, not the creation source',
  (surface) => {
    const now = new Date()
    // Local start of today: inside the queried day and month at any wall time.
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const id = seedEntry(db, {
      client_id: 1,
      source: 'mcp',
      created_source: 'import',
      started_at: dayStart.toISOString(),
      stopped_at: new Date(dayStart.getTime() + 60000).toISOString()
    })
    const rows = (): Entry[] =>
      surface === 'month'
        ? monthEntries(db, now.getFullYear(), now.getMonth() + 1)
        : readTodayEntries(db)
    expect(rows().find((e) => e.id === id)?.source).toBe('mcp')
    expect(updateManualEntry(db, { id, description: 'Edited by hand' }).ok).toBe(true)
    expect(rows().find((e) => e.id === id)?.source).toBe('app')
  }
)
