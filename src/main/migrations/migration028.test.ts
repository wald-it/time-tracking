/**
 * Migration 028 (2.0 P2): the switch from the table `entries` to the entry
 * lifecycle. Registered in the runner, the old table becomes `entries_v1`,
 * the view `entries` replaces it, and the readers see the same rows as
 * before on a generated 1.x database (design doc section 13, P2 done-check:
 * "the full suite green with readers unchanged on the view").
 *
 * Pinned to Europe/Berlin like migrateV2.test.ts (a segment's date is local),
 * in a file of its own because a TZ pin leaks into later tests of the file.
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
import { generateLegacyDb } from '../../test/legacyEntriesGenerator'
import { executeMigration, migrations } from './index'
import { migration028 } from './028-v2-entry-lifecycle'
import { ENTRIES_VIEW_READ_ONLY } from '../entryLifecycle/schemaV2'
import { writeEntry } from '../entryMutations'
import { deleteClientGuarded, deleteProjectGuarded } from '../masterDataDelete'

let Ctor: DatabaseCtor
let templateDir: string
let template: string
const previousTz = process.env.TZ

beforeAll(async () => {
  process.env.TZ = 'Europe/Berlin'
  Ctor = await loadSqlite()
  templateDir = mkdtempSync(join(tmpdir(), 'tt-028-template-'))
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
  dir = mkdtempSync(join(tmpdir(), 'tt-028-'))
  db = openMigratedCopy(Ctor, template, dir)
  db.pragma('foreign_keys = ON')
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const apply028 = (): void => {
  db.transaction(() => executeMigration(db, migration028))()
}

const objects = (type: 'table' | 'view' | 'trigger'): string[] =>
  (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = ? ORDER BY name`).all(type) as Array<{
      name: string
    }>
  ).map((r) => r.name)

interface ReaderRow {
  id: number
  client_id: number
  project_id: number | null
  description: string
  started_at: string
  stopped_at: string | null
  heartbeat_at: string | null
  tags: string
  reference: string
  billable: number
  private_note: string
  graph_event_id: string | null
}
const READER_COLUMNS =
  'id, client_id, project_id, description, started_at, stopped_at, heartbeat_at, tags, reference, billable, private_note, graph_event_id'

describe('migration 028', () => {
  it('is registered as the last migration', () => {
    const last = migrations[migrations.length - 1]
    expect(last.version).toBe(28)
    expect(last.name).toBe('v2-entry-lifecycle')
    expect(last).toBe(migration028)
    expect(LAST_V1_VERSION).toBe(27)
  })

  it('renames the table, creates the view and the triggers, and leaves entries_v1 as it was', () => {
    generateLegacyDb(db, 3)
    const before = db.prepare(`SELECT * FROM entries ORDER BY id`).all()
    expect(objects('table')).toContain('entries')
    apply028()
    expect(objects('table')).not.toContain('entries')
    expect(objects('table')).toEqual(
      expect.arrayContaining([
        'entries_v1',
        'entry',
        'entry_version',
        'entry_segment',
        'entry_legacy_id',
        'rate',
        'billing_profile'
      ])
    )
    expect(objects('view')).toContain('entries')
    expect(objects('trigger')).toEqual(
      expect.arrayContaining([
        'trg_entries_view_insert',
        'trg_entries_view_update',
        'trg_entries_view_delete',
        'trg_entry_version_sealed',
        'trg_entry_version_no_delete',
        'trg_entry_segment_sealed_update',
        'trg_entry_segment_sealed_delete',
        'trg_entry_fixed_columns',
        'trg_entry_no_delete',
        'trg_entries_v1_insert',
        'trg_entries_v1_update',
        'trg_entries_v1_delete'
      ])
    )
    expect(db.prepare(`SELECT * FROM entries_v1 ORDER BY id`).all()).toEqual(before)
    expect(() => db.prepare(`DELETE FROM entries`).run()).toThrow(ENTRIES_VIEW_READ_ONLY)
  })

  it('the view has the columns the 1.x readers select', () => {
    apply028()
    const cols = (db.prepare(`PRAGMA table_info(entries)`).all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    for (const c of [
      'id',
      'client_id',
      'description',
      'started_at',
      'stopped_at',
      'heartbeat_at',
      'rounded_min',
      'deleted_at',
      'created_at',
      'link_id',
      'tags',
      'reference',
      'billable',
      'private_note',
      'project_id',
      'graph_event_id',
      'segment_seq',
      'version_id',
      'version_no'
    ]) {
      expect(cols).toContain(c)
    }
  })

  it('reader parity: every live 1.x row is one row of the view with the same fields, under its entry id', () => {
    for (const seed of [1, 2, 5]) {
      const d = openMigratedCopy(Ctor, template, mkdtempSync(join(dir, `s${seed}-`)))
      d.pragma('foreign_keys = ON')
      try {
        generateLegacyDb(d, seed)
        const legacy = d
          .prepare(`SELECT ${READER_COLUMNS} FROM entries WHERE deleted_at IS NULL ORDER BY id`)
          .all() as ReaderRow[]
        d.transaction(() => executeMigration(d, migration028))()
        const mapping = new Map(
          (
            d.prepare(`SELECT legacy_id, entry_id FROM entry_legacy_id`).all() as Array<{
              legacy_id: number
              entry_id: number
            }>
          ).map((r) => [r.legacy_id, r.entry_id])
        )
        const view = d
          .prepare(`SELECT ${READER_COLUMNS} FROM entries ORDER BY id, segment_seq`)
          .all() as ReaderRow[]
        // The anchor is the entry's (4.1): a 1.x pair carried it on one half,
        // the view shows it on both segments, so it is checked apart.
        const key = (r: ReaderRow): string =>
          [
            r.id,
            r.client_id,
            r.project_id,
            r.description,
            r.started_at,
            r.stopped_at,
            r.tags,
            r.reference,
            r.billable,
            r.private_note
          ].join('|')
        const viewKeys = new Set(view.map(key))
        const mapped = legacy.filter((r) => mapping.has(r.id))
        expect(mapped.length).toBeGreaterThan(0)
        const missing = mapped
          .map((r) => ({ ...r, id: mapping.get(r.id)! }))
          .filter((r) => !viewKeys.has(key(r)))
        expect(missing).toEqual([])
        // One view row per live 1.x row: nothing appears that was not there.
        expect(view.length).toBe(mapped.length)
        for (const r of mapped.filter((l) => l.graph_event_id !== null)) {
          const anchors = new Set(
            view.filter((v) => v.id === mapping.get(r.id)).map((v) => v.graph_event_id)
          )
          expect([...anchors]).toEqual([r.graph_event_id])
        }
        // A running row keeps its heartbeat; a stopped one shows its stop.
        for (const r of legacy.filter((l) => l.stopped_at === null && mapping.has(l.id))) {
          const v = view.find((x) => x.id === mapping.get(r.id) && x.stopped_at === null)!
          expect(v.heartbeat_at).toBe(r.heartbeat_at)
        }
      } finally {
        d.close()
      }
    }
  })

  it('after the switch the write path works and ids continue after the highest 1.x id', () => {
    generateLegacyDb(db, 7)
    const maxLegacy = (db.prepare(`SELECT MAX(id) AS m FROM entries`).get() as { m: number }).m
    apply028()
    const r = writeEntry(
      db,
      {
        op: 'create',
        fields: {
          client_id: 1,
          description: 'after',
          // A day no generated row can touch (they lie in October/November 2026).
          started_at: '2020-01-01T09:00:00.000Z',
          stopped_at: '2020-01-01T10:00:00.000Z'
        }
      },
      { source: 'app' }
    )
    if (!r.ok) throw new Error(r.error)
    expect(r.data.id).toBeGreaterThan(maxLegacy)
  })

  it('a client or project with versions cannot be deleted after the switch (owner decision 2026-10-26)', () => {
    generateLegacyDb(db, 1)
    apply028()
    // Every client and project of the generator has entries.
    expect(deleteClientGuarded(db, 1).ok).toBe(false)
    expect(deleteProjectGuarded(db, 10).ok).toBe(false)
    // A fresh client without entries goes, rate rows included (the migration
    // seeded one for every client).
    db.prepare(`INSERT INTO clients (id, name, color) VALUES (99, 'Neu', '#000')`).run()
    db.prepare(
      `INSERT INTO rate (client_id, project_id, valid_from, rate_cent) VALUES (99, NULL, '0001-01-01', 0)`
    ).run()
    expect(deleteClientGuarded(db, 99)).toEqual({ ok: true, data: undefined })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM rate WHERE client_id = 99`).get()).toEqual({
      n: 0
    })
  })
})
