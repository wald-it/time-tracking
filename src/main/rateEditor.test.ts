import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { deleteRate, listRates, saveRate, readProfile, saveProfile } from './rateEditor'
import { RATE_EDITOR_CONFLICT_ERROR } from '../shared/rateEditor'
import { seedEntry } from '../test/entryFixtures'
import { createRun, verifyRunHtml } from './billingRuns'
import { executeMigration } from './migrations'
import { migration033 } from './migrations/033-rate-editor'
import { buildJsonExportPayload } from './jsonExport'

let Sqlite: DatabaseCtor
let db: Database.Database
let today: string
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
beforeEach(() => {
  db = new Sqlite(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  db.exec(
    "INSERT INTO clients (id, name, rate_cent, short_code) VALUES (1, 'A', 6000, 'A'); INSERT INTO projects (id, client_id, name, rate_cent) VALUES (10, 1, 'P', 7000)"
  )
  today = (db.prepare("SELECT date('now','localtime') AS day").get() as { day: string }).day
})
afterEach(() => db.close())
const client = { kind: 'client', id: 1 } as const
const project = { kind: 'project', id: 10 } as const

describe('rate editor and legacy field', () => {
  it.each([client, project])(
    'protects today editor rows for $kind, allows unchanged saves',
    (target) => {
      saveRate(db, target, { valid_from: today, rate_cent: 9000 })
      const before = listRates(db, target)
      const table = target.kind === 'client' ? 'clients' : 'projects'
      expect(() =>
        db.prepare(`UPDATE ${table} SET rate_cent = 10000 WHERE id = ?`).run(target.id)
      ).toThrow(RATE_EDITOR_CONFLICT_ERROR)
      db.prepare(`UPDATE ${table} SET name = 'Renamed', rate_cent = 9000 WHERE id = ?`).run(
        target.id
      )
      expect(listRates(db, target)).toEqual(before)
      expect(db.prepare(`SELECT rate_cent FROM ${table} WHERE id = ?`).get(target.id)).toEqual({
        rate_cent: 9000
      })
    }
  )
  it.each([client, project])(
    'keeps past editor rows when the old $kind field changes',
    (target) => {
      // On the first day of a month use the previous month, so this always tests a past row.
      const first = today.slice(0, 8) + '01'
      const past = first === today ? '2020-01-01' : first
      saveRate(db, target, { valid_from: past, rate_cent: 8000 })
      const table = target.kind === 'client' ? 'clients' : 'projects'
      db.prepare(`UPDATE ${table} SET rate_cent = 10000 WHERE id = ?`).run(target.id)
      expect(listRates(db, target)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ valid_from: past, rate_cent: 8000 }),
          expect.objectContaining({ valid_from: today, rate_cent: 10000 })
        ])
      )
      expect(
        db
          .prepare('SELECT source FROM rate WHERE valid_from = ? AND ' + target.kind + '_id = ?')
          .get(past, target.id)
      ).toEqual({ source: 'editor' })
    }
  )
  it('protects a project NULL row and synchronizes inheritance', () => {
    saveRate(db, project, { valid_from: today, rate_cent: null })
    expect(db.prepare('SELECT rate_cent FROM projects WHERE id = 10').get()).toEqual({
      rate_cent: null
    })
    expect(() => db.exec('UPDATE projects SET rate_cent = 9000 WHERE id = 10')).toThrow(
      RATE_EDITOR_CONFLICT_ERROR
    )
    db.exec("UPDATE projects SET name = 'Renamed', rate_cent = NULL WHERE id = 10")
    expect(listRates(db, project)).toHaveLength(2)
  })
  it('keeps a past project NULL row when the legacy field adds today', () => {
    saveRate(db, project, { valid_from: '2020-01-01', rate_cent: null })
    db.exec('UPDATE projects SET rate_cent = 9000 WHERE id = 10')
    expect(listRates(db, project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ valid_from: '2020-01-01', rate_cent: null }),
        expect.objectContaining({ valid_from: today, rate_cent: 9000 })
      ])
    )
  })
  // A future editor row leaves the old column on the previous rate until its day
  // comes; a rename that sends that stale rate back must not touch the rows.
  it.each([
    { ...client, day: 'today' },
    { ...client, day: 'past' },
    { ...project, day: 'today' },
    { ...project, day: 'past' }
  ])('ignores a rename with a stale $kind column once an editor row is due ($day)', (target) => {
    const table = target.kind === 'client' ? 'clients' : 'projects'
    const validFrom = target.day === 'today' ? today : '2020-01-02'
    db.prepare(
      `INSERT INTO rate (${target.kind}_id, rate_cent, valid_from, source) VALUES (?, 9000, ?, 'editor')`
    ).run(target.id, validFrom)
    const before = listRates(db, target)
    const stale = target.kind === 'client' ? 6000 : 7000
    db.prepare(`UPDATE ${table} SET name = 'Renamed', rate_cent = ? WHERE id = ?`).run(
      stale,
      target.id
    )
    expect(listRates(db, target)).toEqual(before)
  })
  it.each([client, project])(
    'upserts dates, moves rows and synchronizes today without a legacy row for $kind',
    (target) => {
      saveRate(db, target, { valid_from: '2020-01-01', rate_cent: 8000 })
      saveRate(db, target, { valid_from: '2020-01-01', rate_cent: 8500 })
      expect(listRates(db, target)).toHaveLength(2)
      const row = listRates(db, target)[1]
      saveRate(db, target, { id: row.id, valid_from: today, rate_cent: 9000 })
      expect(listRates(db, target)).toHaveLength(2)
      expect(db.prepare('SELECT source FROM rate WHERE id = ?').get(row.id)).toEqual({
        source: 'editor'
      })
      deleteRate(db, target, row.id)
      expect(listRates(db, target)).toHaveLength(1)
      expect(
        db
          .prepare(
            `SELECT rate_cent FROM ${target.kind === 'client' ? 'clients' : 'projects'} WHERE id = ?`
          )
          .get(target.id)
      ).toEqual({ rate_cent: target.kind === 'client' ? 6000 : 7000 })
    }
  )
  it('allows deleting all project rows and preserves the current rate for future writes', () => {
    saveRate(db, client, { valid_from: '9999-01-01', rate_cent: 12000 })
    expect(db.prepare('SELECT rate_cent FROM clients WHERE id = 1').get()).toEqual({
      rate_cent: 6000
    })
    deleteRate(db, project, listRates(db, project)[0].id)
    expect(listRates(db, project)).toEqual([])
    expect(db.prepare('SELECT rate_cent FROM projects WHERE id = 10').get()).toEqual({
      rate_cent: null
    })
  })
  it('rejects invalid dates, rates, baseline removal/move and the final client row', () => {
    for (const date of ['2026-02-29', '2026-04-31', '0000-01-01', '2026-1-01', 'no']) {
      expect(() => saveRate(db, client, { valid_from: date, rate_cent: 1 })).toThrow(/Datum/)
    }
    for (const rate of [-1, 1.5, null, NaN]) {
      expect(() => saveRate(db, client, { valid_from: today, rate_cent: rate })).toThrow(/Satz/)
    }
    const baseline = listRates(db, client)[0]
    expect(() => deleteRate(db, client, baseline.id)).toThrow(/Kundenzeile/)
    expect(() =>
      saveRate(db, client, { id: baseline.id, valid_from: today, rate_cent: 1 })
    ).toThrow(/0001-01-01/)
    saveRate(db, client, { valid_from: '0001-01-01', rate_cent: 5000 })
    expect(listRates(db, client)[0].rate_cent).toBe(5000)
    db.exec("UPDATE rate SET valid_from = '2000-01-01' WHERE client_id = 1")
    expect(() => deleteRate(db, client, baseline.id)).toThrow(/Kundenzeile/)
  })
  it('validates owners and refuses editing another owner’s row', () => {
    expect(() => listRates(db, { kind: 'client', id: 999 })).toThrow(/gefunden/)
    expect(() =>
      saveRate(db, project, { id: listRates(db, client)[0].id, valid_from: today, rate_cent: 1 })
    ).toThrow(/gefunden/)
  })
  it('migrates 030 rows as legacy and leaves all other triggers unchanged', () => {
    db.close()
    db = new Sqlite(':memory:')
    applyMigrations(db, 30)
    db.exec(
      "INSERT INTO clients (id, name, rate_cent) VALUES (1, 'A', 6000); INSERT INTO projects (id, client_id, name, rate_cent) VALUES (10, 1, 'P', 7000); UPDATE clients SET rate_cent = 8000 WHERE id = 1; UPDATE projects SET rate_cent = NULL WHERE id = 10"
    )
    const untouched = (): unknown[] =>
      db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name NOT IN ('trg_rate_sync_client_update', 'trg_rate_sync_project_update') ORDER BY name"
        )
        .all()
    const triggers = untouched()
    const old = db.prepare('SELECT * FROM rate ORDER BY id').all() as Record<string, unknown>[]
    db.transaction(() => executeMigration(db, migration033))()
    expect(db.prepare('SELECT * FROM rate ORDER BY id').all()).toEqual(
      old.map((row) => ({ ...row, source: 'legacy' }))
    )
    expect(untouched()).toEqual(triggers)
    expect(() => db.exec("UPDATE rate SET source = 'other'")).toThrow(/CHECK/)
  })
  it('includes editor provenance in JSON exports', () => {
    saveRate(db, client, { valid_from: today, rate_cent: 9000 })
    expect(buildJsonExportPayload(db, '2.0').rate).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'editor', valid_from: today })])
    )
  })
})

describe('billing profile editor', () => {
  it('inherits per field and preserves other fields and the default row', () => {
    const defaults = db
      .prepare('SELECT * FROM billing_profile WHERE client_id IS NULL AND project_id IS NULL')
      .get()
    saveProfile(db, client, { interval_min: 15, min_unit_min: 30 })
    db.exec(
      "UPDATE billing_profile SET language = 'en', alignment = 'none', columns = 'no_times', fee_column = 'off', group_by = 'tag' WHERE client_id = 1"
    )
    saveProfile(db, project, { interval_min: 5, min_unit_min: null })
    expect(readProfile(db, project)).toMatchObject({
      interval_min: 5,
      min_unit_min: null,
      inherited: { interval_min: 15, min_unit_min: 30 }
    })
    saveProfile(db, client, { interval_min: null, min_unit_min: null })
    expect(
      db
        .prepare(
          'SELECT language, alignment, columns, fee_column, group_by FROM billing_profile WHERE client_id = 1'
        )
        .get()
    ).toEqual({
      language: 'en',
      alignment: 'none',
      columns: 'no_times',
      fee_column: 'off',
      group_by: 'tag'
    })
    expect(
      db
        .prepare('SELECT * FROM billing_profile WHERE client_id IS NULL AND project_id IS NULL')
        .get()
    ).toEqual(defaults)
    for (const fields of [
      { interval_min: 61, min_unit_min: 0 },
      { interval_min: 0, min_unit_min: -1 },
      { interval_min: 1.5, min_unit_min: 0 }
    ]) {
      expect(() => saveProfile(db, client, fields)).toThrow(/Takt|Mindestzeit/)
    }
  })
  it('keeps P5 billed lines, items, documents and HTML unchanged while unbilled segments follow the editor', async () => {
    const add = (id: number): void => {
      seedEntry(db, {
        id,
        client_id: 1,
        started_at: '2026-10-10T10:00:00.000Z',
        stopped_at: '2026-10-10T10:04:00.000Z'
      })
    }
    saveProfile(db, client, { interval_min: 5, min_unit_min: 0 })
    add(1)
    const run = await createRun(
      db,
      { clientId: 1, fromIso: '2026-10-01', toIso: '2026-10-31' },
      async (html) => Buffer.from(html)
    )
    const billed = db.prepare('SELECT * FROM billing_lines WHERE entry_id = 1').all()
    const items = db.prepare('SELECT * FROM billing_run_item').all()
    const documents = db.prepare('SELECT * FROM billing_run_document').all()
    add(2)
    saveRate(db, client, { valid_from: '2026-10-01', rate_cent: 12000 })
    saveProfile(db, client, { interval_min: 15, min_unit_min: 30 })
    expect(db.prepare('SELECT * FROM billing_lines WHERE entry_id = 1').all()).toEqual(billed)
    expect(db.prepare('SELECT * FROM billing_run_item').all()).toEqual(items)
    expect(db.prepare('SELECT * FROM billing_run_document').all()).toEqual(documents)
    expect(verifyRunHtml(db, run.id)).toBe(true)
    expect(
      db.prepare('SELECT rate_cent, billed_minutes FROM billing_lines WHERE entry_id = 2').get()
    ).toEqual({ rate_cent: 12000, billed_minutes: 30 })
  })
})
