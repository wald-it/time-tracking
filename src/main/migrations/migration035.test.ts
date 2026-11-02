import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../../test/sqlite'
import { executeMigration, migrations } from './index'
let Sqlite: DatabaseCtor
let db: Database.Database
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
beforeEach(() => {
  db = new Sqlite(':memory:')
  applyMigrations(db, 34)
})
afterEach(() => db.close())

it('035 is registered and preserves legacy hours/total budgets on upgrade', () => {
  db.exec("INSERT INTO projects (name, budget_minutes) VALUES ('Legacy', 600), ('Empty', NULL)")
  const migration = migrations.find((m) => m.version === 35)
  expect(migration).toBeDefined()
  db.transaction(() => executeMigration(db, migration!))()
  expect(
    db
      .prepare(
        'SELECT budget_kind, budget_period, budget_minutes, budget_cent FROM projects ORDER BY id'
      )
      .all()
  ).toEqual([
    { budget_kind: 'hours', budget_period: 'total', budget_minutes: 600, budget_cent: null },
    { budget_kind: 'hours', budget_period: 'total', budget_minutes: null, budget_cent: null }
  ])
  expect(() => db.exec("UPDATE projects SET budget_kind = 'days'")).toThrow(/CHECK/)
  expect(() => db.exec("UPDATE projects SET budget_period = 'week'")).toThrow(/CHECK/)
})
