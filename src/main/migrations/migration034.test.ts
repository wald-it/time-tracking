import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../../test/sqlite'
import { generatePerformanceLegacyDb } from '../../test/legacyEntriesGenerator'
import { localMonthRange } from '../../shared/dateRanges'
import { monthEntries } from '../entryRanges'
import { buildAnalyticsSummary } from '../analyticsHandlers'
import { executeMigration, migrations } from './index'
import { migration034 } from './034-v2-range-indexes'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

let Ctor: DatabaseCtor
let db: Database.Database
beforeAll(async () => {
  Ctor = await loadSqlite()
})
beforeEach(() => {
  db = new Ctor(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db, 27)
  generatePerformanceLegacyDb(db, 20261028, 1000)
  for (const migration of migrations.filter((m) => m.version > 27 && m.version < 34)) {
    db.transaction(() => executeMigration(db, migration))()
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  db.close()
})

function applyIndexes(): void {
  db.transaction(() => executeMigration(db, migration034))()
}

function monthPlan(): string[] {
  // Capture the production statement, including its billed subquery, so this
  // guard follows future reader changes instead of testing a copied query.
  const prepare = vi.spyOn(db, 'prepare')
  monthEntries(db, 2023, 3)
  const sql = prepare.mock.calls.find(([sql]) => sql.includes('SELECT entries.*'))?.[0]
  prepare.mockRestore()
  expect(sql).toBeDefined()
  const { start, end } = localMonthRange(2023, 3)
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(start, end) as { detail: string }[]).map(
    (row) => row.detail
  )
}

function expectIndexedEntryLookup(details: string[]): void {
  expect(details.some((detail) => /\bSCAN (?:e|entry)\b/i.test(detail))).toBe(false)
  expect(
    details.some((detail) => /\b(?:SCAN|SEARCH) (?:e|entry)\b.*\bAUTOMATIC\b/i.test(detail))
  ).toBe(false)
}

describe('migration 034', () => {
  it('is registered and gives fresh and upgraded databases the same idempotent schema', () => {
    expect(migrations.find((m) => m.version === 34)).toBe(migration034)
    applyIndexes()
    applyIndexes()
    const fresh = new Ctor(':memory:')
    try {
      applyMigrations(fresh)
      const schema = (connection: Database.Database): unknown[] =>
        connection
          .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
          )
          .all()
      expect(schema(db)).toEqual(schema(fresh))
      for (const [name, column] of [
        ['idx_entry_current_version', 'current_version_id'],
        ['idx_entry_segment_started_at', 'started_at'],
        ['idx_entry_segment_date', 'segment_date']
      ]) {
        expect(db.prepare(`PRAGMA index_info(${name})`).all()).toEqual([
          expect.objectContaining({ name: column })
        ])
      }
      expect(db.pragma('foreign_key_check')).toEqual([])
    } finally {
      fresh.close()
    }
  })

  it('preserves month rows, columns, values and order and the complete analytics result', () => {
    const now = new Date('2026-10-28T12:00:00.000Z')
    const beforeMonth = monthEntries(db, 2023, 3)
    const beforeAnalytics = buildAnalyticsSummary(db, { year: 2023, month: 3 }, now)
    expect(beforeMonth.length).toBeGreaterThan(0)
    expect(beforeAnalytics.ok).toBe(true)
    applyIndexes()
    expect(monthEntries(db, 2023, 3)).toEqual(beforeMonth)
    expect(buildAnalyticsSummary(db, { year: 2023, month: 3 }, now)).toEqual(beforeAnalytics)
  })

  it('uses segment ranges without scanning entries or building an automatic entry index', () => {
    applyIndexes()
    expectIndexedEntryLookup(monthPlan())
  })

  it('detects the started_at-only trap when the current-version index is missing', () => {
    applyIndexes()
    // Capture before dropping the index: never execute the pathological query.
    const prepare = vi.spyOn(db, 'prepare')
    monthEntries(db, 2023, 3)
    const sql = prepare.mock.calls.find(([sql]) => sql.includes('SELECT entries.*'))![0]
    prepare.mockRestore()
    db.exec('DROP INDEX idx_entry_current_version')
    const { start, end } = localMonthRange(2023, 3)
    const details = (
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(start, end) as { detail: string }[]
    ).map((row) => row.detail)
    expect(() => expectIndexedEntryLookup(details)).toThrow()
  })
})
