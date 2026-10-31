import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import { buildBillingPreview } from './billingPreview'
import { buildPdfPayload } from './pdf'
import { createRun, releaseRun } from './billingRuns'
import { saveRate } from './rateEditor'

let Ctor: DatabaseCtor
let db: Database.Database
const req = { clientId: 1, fromIso: '2026-10-01', toIso: '2026-10-31' }
const at = (day: number, hour: number, minute = 0): string =>
  new Date(2026, 9, day, hour, minute).toISOString()
const render = async (): Promise<Buffer> => Buffer.from('test pdf')
beforeAll(async () => {
  Ctor = await loadSqlite()
})
beforeEach(() => {
  db = new Ctor(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  db.exec(`INSERT INTO clients (id, name, rate_cent, short_code) VALUES
    (1, 'Client', 6000, 'ABC'), (2, 'Other', 6000, NULL);
    INSERT INTO projects (id, client_id, name, rate_cent) VALUES
    (1, 1, 'Work', 6001), (2, 1, 'Goodwill', 0)`)
  saveRate(db, { kind: 'project', id: 1 }, { valid_from: '2026-10-15', rate_cent: 9001 })
  seedEntry(db, {
    client_id: 1,
    project_id: 1,
    description: 'Midnight',
    segments: [
      { started_at: at(1, 23, 45), stopped_at: at(2, 0), segment_date: '2026-10-01' },
      { started_at: at(2, 0), stopped_at: at(2, 0, 15), segment_date: '2026-10-02' }
    ]
  })
  for (const [hour, description] of [
    [8, 'Midnight'],
    [9, 'Second; "quoted"']
  ] as const)
    seedEntry(db, {
      client_id: 1,
      project_id: 1,
      description,
      started_at: at(2, hour),
      stopped_at: at(2, hour, 1)
    })
  seedEntry(db, {
    client_id: 1,
    project_id: 1,
    description: 'New rate',
    started_at: at(20, 8),
    stopped_at: at(20, 8, 20)
  })
  seedEntry(db, {
    client_id: 1,
    project_id: 2,
    description: 'Gift',
    started_at: at(3, 8),
    stopped_at: at(3, 8, 30)
  })
  seedEntry(db, { client_id: 1, description: '  ', started_at: at(4, 8), stopped_at: at(4, 8, 10) })
  seedEntry(db, {
    client_id: 1,
    billable: 0,
    description: 'Do not bill',
    started_at: at(2, 10),
    stopped_at: at(2, 12)
  })
})
afterEach(() => db.close())

describe('billing preview', () => {
  it('matches PDF minutes and cents before anything is billed, without writes', () => {
    const before = db.prepare('SELECT total_changes() AS n').get()
    const preview = buildBillingPreview(db, req)
    const pdf = buildPdfPayload(db, req, '', '2026-11-01T00:00:00Z')
    expect(preview.totals).toEqual({
      billedMinutes: pdf.totals.minutes,
      feeCent: pdf.totals.feeCent
    })
    expect(preview.totals.billedMinutes).toBe(92)
    expect(preview.billedEntriesCount).toBe(0)
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
  })
  it('matches the next real run after one midnight segment was billed', async () => {
    await createRun(db, { ...req, toIso: '2026-10-01' }, render)
    const preview = buildBillingPreview(db, req)
    const next = await createRun(db, req, render)
    const totals = db
      .prepare(
        `SELECT SUM(billed_minutes) AS billedMinutes, SUM(fee_cent) AS feeCent
      FROM billing_run_item WHERE run_id = ?`
      )
      .get(next.id)
    expect(preview.totals).toEqual(totals)
    expect(preview.totals.billedMinutes).toBe(77)
    expect(preview.billedEntriesCount).toBe(1)
  })
  it('counts distinct excluded entries even when both segments of one entry are billed', async () => {
    await createRun(db, { ...req, toIso: '2026-10-02' }, render)
    const preview = buildBillingPreview(db, req)
    expect(preview.billedEntriesCount).toBe(3)
    expect(preview.totals.billedMinutes).toBe(60)
    expect(preview.dayGrid[1]).toMatchObject({ date: '2026-10-02', billedMinutes: 17 })
  })
  it('keeps separate rates and service periods, goodwill and entries without project', () => {
    const { lines } = buildBillingPreview(db, req)
    expect(lines).toEqual([
      {
        projectId: null,
        projectName: null,
        rateCent: 6000,
        billedMinutes: 10,
        feeCent: 1000,
        fromIso: '2026-10-04',
        toIso: '2026-10-04'
      },
      {
        projectId: 2,
        projectName: 'Goodwill',
        rateCent: 0,
        billedMinutes: 30,
        feeCent: 0,
        fromIso: '2026-10-03',
        toIso: '2026-10-03'
      },
      {
        projectId: 1,
        projectName: 'Work',
        rateCent: 6001,
        billedMinutes: 32,
        feeCent: 3200,
        fromIso: '2026-10-01',
        toIso: '2026-10-02'
      },
      {
        projectId: 1,
        projectName: 'Work',
        rateCent: 9001,
        billedMinutes: 20,
        feeCent: 3000,
        fromIso: '2026-10-20',
        toIso: '2026-10-20'
      }
    ])
  })
  it('returns the day attachment with billed time, distinct descriptions and both midnight days', async () => {
    await createRun(db, { ...req, toIso: '2026-10-01' }, render)
    expect(buildBillingPreview(db, req).dayGrid).toEqual([
      { date: '2026-10-01', billedMinutes: 15, activity: 'Midnight' },
      { date: '2026-10-02', billedMinutes: 17, activity: 'Midnight; Second; "quoted"' },
      { date: '2026-10-03', billedMinutes: 30, activity: 'Gift' },
      { date: '2026-10-04', billedMinutes: 10, activity: '' },
      { date: '2026-10-20', billedMinutes: 20, activity: 'New rate' }
    ])
  })
  it('previews without a client short code and always includes amounts when fees are hidden', () => {
    db.exec(
      "UPDATE clients SET short_code = NULL WHERE id = 1; UPDATE billing_profile SET fee_column = 'off'"
    )
    expect(buildBillingPreview(db, req).totals).toEqual({ billedMinutes: 92, feeCent: 7200 })
  })
  it('uses the same client, project, stopped and inclusive date filters for both results', () => {
    seedEntry(db, { client_id: 2, started_at: at(2, 12), stopped_at: at(2, 13) })
    seedEntry(db, { client_id: 1, project_id: 1, started_at: at(32, 12), stopped_at: at(32, 13) })
    seedEntry(db, { client_id: 1, project_id: 1, started_at: at(5, 12), stopped_at: null })
    seedEntry(db, {
      client_id: 1,
      project_id: 1,
      started_at: at(6, 12),
      stopped_at: at(6, 13),
      deleted_at: at(7, 0)
    })
    const preview = buildBillingPreview(db, { ...req, projectId: 1, toIso: '2026-10-02' })
    expect(preview.lines).toHaveLength(1)
    expect(preview.totals).toEqual({ billedMinutes: 32, feeCent: 3200 })
    expect(preview.dayGrid).toHaveLength(2)
    expect(buildBillingPreview(db, { ...req, projectId: 999 })).toEqual({
      lines: [],
      totals: { billedMinutes: 0, feeCent: 0 },
      billedEntriesCount: 0,
      dayGrid: []
    })
  })
  it('returns released segments to the preview and returns empty lines when fully billed', async () => {
    const run = await createRun(db, req, render)
    expect(buildBillingPreview(db, req)).toMatchObject({
      lines: [],
      totals: { billedMinutes: 0, feeCent: 0 },
      billedEntriesCount: 6
    })
    releaseRun(db, run.id, 'Correction')
    expect(buildBillingPreview(db, req)).toMatchObject({
      totals: { billedMinutes: 92, feeCent: 7200 },
      billedEntriesCount: 0
    })
  })
})
