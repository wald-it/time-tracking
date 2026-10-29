/**
 * Migration 031 (2.0 P4 renderer part, #374): the view `entries` gains the
 * money columns of `billing_lines`. A database at 030 is brought up to it;
 * the view stays read-only and shows one row per segment as before.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import {
  LAST_V1_VERSION,
  createMigratedTemplate,
  loadSqlite,
  openMigratedCopy,
  type DatabaseCtor
} from '../../test/sqlite'
import { executeMigration, migrations } from './index'
import { migration028 } from './028-v2-entry-lifecycle'
import { migration029 } from './029-v2-entries-view-segment-count'
import { migration030 } from './030-v2-billing-lines'
import { migration031 } from './031-v2-entries-view-money'
import { ENTRIES_VIEW_READ_ONLY } from '../entryLifecycle/schemaV2'

let Ctor: DatabaseCtor
let templateDir: string
let template: string
beforeAll(async () => {
  Ctor = await loadSqlite()
  templateDir = mkdtempSync(join(tmpdir(), 'tt-031-template-'))
  template = createMigratedTemplate(Ctor, templateDir, LAST_V1_VERSION)
})
afterAll(() => rmSync(templateDir, { recursive: true, force: true }))

let dir: string
let db: Database.Database
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-031-'))
  db = openMigratedCopy(Ctor, template, dir)
  db.pragma('foreign_keys = ON')
  for (const m of [migration028, migration029, migration030]) {
    db.transaction(() => executeMigration(db, m))()
  }
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const viewColumns = (): string[] =>
  (db.prepare(`PRAGMA table_info(entries)`).all() as Array<{ name: string }>).map((c) => c.name)

describe('migration 031', () => {
  it('is registered as migration 31', () => {
    expect(migrations.find((m) => m.version === 31)).toBe(migration031)
  })

  it('adds the money columns and the profile values to a database that stopped at 030', () => {
    expect(viewColumns()).not.toContain('fee_cent')
    db.transaction(() => executeMigration(db, migration031))()
    expect(viewColumns()).toEqual(
      expect.arrayContaining([
        'segment_count',
        'billed_minutes',
        'rate_cent',
        'fee_cent',
        'rate_is_project',
        'interval_min',
        'min_unit_min'
      ])
    )
  })

  it('keeps the view read-only', () => {
    db.transaction(() => executeMigration(db, migration031))()
    expect(() => db.prepare(`INSERT INTO entries (id) VALUES (1)`).run()).toThrow(
      ENTRIES_VIEW_READ_ONLY
    )
  })
})
