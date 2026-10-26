/**
 * Migration 029 (2.0 P3, #372 item 2): the view `entries` gains
 * `segment_count`. Pinned to Europe/Berlin like migration028.test.ts, in a
 * file of its own because a TZ pin leaks into later tests of the file.
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
import { ENTRIES_VIEW_READ_ONLY } from '../entryLifecycle/schemaV2'
import { createManualEntry } from '../entryMutations'
import { seed } from '../../test/bridgeKit'

let Ctor: DatabaseCtor
let templateDir: string
let template: string
const previousTz = process.env.TZ

beforeAll(async () => {
  process.env.TZ = 'Europe/Berlin'
  Ctor = await loadSqlite()
  templateDir = mkdtempSync(join(tmpdir(), 'tt-029-template-'))
  template = createMigratedTemplate(Ctor, templateDir, LAST_V1_VERSION)
})
afterAll(() => {
  rmSync(templateDir, { recursive: true, force: true })
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

let dir: string
let db: Database.Database
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-029-'))
  db = openMigratedCopy(Ctor, template, dir)
  db.pragma('foreign_keys = ON')
  db.transaction(() => executeMigration(db, migration028))()
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const viewColumns = (): string[] =>
  (db.prepare(`PRAGMA table_info(entries)`).all() as Array<{ name: string }>).map((c) => c.name)

describe('migration 029', () => {
  it('is registered as migration 29', () => {
    expect(migrations.find((m) => m.version === 29)).toBe(migration029)
  })

  it('adds segment_count to a database that stopped at 028 and keeps the view read-only', () => {
    // The view as it stood before P3: the column is not there yet.
    db.exec(`DROP VIEW entries`)
    db.exec(`CREATE VIEW entries AS SELECT e.id AS id, s.seq AS segment_seq
               FROM entry e JOIN entry_version v ON v.id = e.current_version_id
               JOIN entry_segment s ON s.version_id = v.id`)
    expect(viewColumns()).not.toContain('segment_count')

    db.transaction(() => executeMigration(db, migration029))()

    expect(viewColumns()).toContain('segment_count')
    // The INSTEAD OF trigger fires for an INSERT even on an empty view.
    expect(() => db.prepare(`INSERT INTO entries (id) VALUES (1)`).run()).toThrow(
      ENTRIES_VIEW_READ_ONLY
    )
  })

  it('counts the segments of the current version: 1 for a day, 2 for a night across midnight', () => {
    const full = new Ctor(':memory:')
    seed(full)
    const day = createManualEntry(full, {
      client_id: 1,
      description: 'Tag',
      started_at: new Date(2026, 5, 10, 9, 0, 0).toISOString(),
      stopped_at: new Date(2026, 5, 10, 10, 0, 0).toISOString()
    })
    const night = createManualEntry(full, {
      client_id: 1,
      description: 'Nacht',
      started_at: new Date(2026, 5, 10, 23, 0, 0).toISOString(),
      stopped_at: new Date(2026, 5, 11, 1, 0, 0).toISOString()
    })
    if (!day.ok || !night.ok) throw new Error('seed failed')
    const rows = full
      .prepare(`SELECT id, segment_seq, segment_count FROM entries ORDER BY id, segment_seq`)
      .all()
    expect(rows).toEqual([
      { id: day.data.id, segment_seq: 0, segment_count: 1 },
      { id: night.data.id, segment_seq: 0, segment_count: 2 },
      { id: night.data.id, segment_seq: 1, segment_count: 2 }
    ])
    full.close()
  })
})
