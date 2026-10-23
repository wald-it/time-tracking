/**
 * Q17 — get_report: worked and billed time and revenue over any range of
 * local days, grouped by client, project and/or day.
 *
 * Three kinds of check, because equal sums can be wrong together (#285, and
 * the Codex objection in the 2.0 decision note):
 *   1. against hand-calculated targets for a fixture that exercises the
 *      money rule (rounding step, project rate before client rate, a 0 €
 *      project, a sub-minute entry, non-billable time);
 *   2. against the JS path the invoice PDF uses (billedMinutes, feeCent);
 *   3. against get_analytics for the same month.
 *
 * Every timestamp sits at midday UTC, so its local day is the same in any
 * zone from UTC-11 to UTC+11: SQLite's 'localtime' follows the system zone,
 * not one a test sets (vault note on process.env.TZ).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { billedMinutes, effectiveRateCent, feeCent } from '../shared/currency'
import { getAnalytics, getReport, REPORT_MAX_DAYS, type SqliteDb } from './queries'
import type { PrivacyConfig } from './privacy'

const HIDE: PrivacyConfig = { exposeRates: false, exposePrivateNotes: false }
const SHOW: PrivacyConfig = { exposeRates: true, exposePrivateNotes: true }

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

interface FixtureEntry {
  id: number
  client_id: number
  project_id: number | null
  started_at: string
  stopped_at: string | null
  billable: 0 | 1
  deleted_at?: string
}

const CLIENT_RATE: Record<number, number> = { 1: 12000, 2: 9000 }
const PROJECT_RATE: Record<number, number | null> = { 10: 15000, 12: 0, 20: null }

/** In range and counted: the five completed, live June entries. */
const COUNTED: FixtureEntry[] = [
  // 67 min on Website (15000 ct/h) → 75 billed min → 18750 ct
  {
    id: 1,
    client_id: 1,
    project_id: 10,
    started_at: '2026-06-10T12:00:00.000Z',
    stopped_at: '2026-06-10T13:07:00.000Z',
    billable: 1
  },
  // 50 s, no project (client 12000 ct/h) → 1 min → 15 billed min → 3000 ct
  {
    id: 2,
    client_id: 1,
    project_id: null,
    started_at: '2026-06-10T14:00:00.000Z',
    stopped_at: '2026-06-10T14:00:50.000Z',
    billable: 1
  },
  // 30 min on Website, not billable → rounded 30 min, no revenue
  {
    id: 3,
    client_id: 1,
    project_id: 10,
    started_at: '2026-06-11T12:00:00.000Z',
    stopped_at: '2026-06-11T12:30:00.000Z',
    billable: 0
  },
  // 60 min on Goodwill (project rate 0 beats the client rate) → 0 ct
  {
    id: 4,
    client_id: 1,
    project_id: 12,
    started_at: '2026-06-11T13:00:00.000Z',
    stopped_at: '2026-06-11T14:00:00.000Z',
    billable: 1
  },
  // 20 min on Beta-Projekt (no project rate → client 9000 ct/h) → 30 billed min → 4500 ct
  {
    id: 5,
    client_id: 2,
    project_id: 20,
    started_at: '2026-06-12T12:00:00.000Z',
    stopped_at: '2026-06-12T12:20:00.000Z',
    billable: 1
  }
]

/** Never counted: running, deleted, outside the June range. */
const IGNORED: FixtureEntry[] = [
  {
    id: 6,
    client_id: 1,
    project_id: null,
    started_at: '2026-06-12T15:00:00.000Z',
    stopped_at: null,
    billable: 1
  },
  {
    id: 7,
    client_id: 2,
    project_id: 20,
    started_at: '2026-06-12T13:00:00.000Z',
    stopped_at: '2026-06-12T15:00:00.000Z',
    billable: 1,
    deleted_at: '2026-06-13T09:00:00.000Z'
  },
  {
    id: 8,
    client_id: 1,
    project_id: 10,
    started_at: '2026-07-01T12:00:00.000Z',
    stopped_at: '2026-07-01T13:00:00.000Z',
    billable: 1
  }
]

function seed(db: Database.Database, roundStep: number): void {
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  db.prepare(`UPDATE settings SET value = ? WHERE key = 'pdf_round_minutes'`).run(String(roundStep))
  db.prepare(
    `INSERT INTO clients (id, name, color, active, rate_cent)
     VALUES (1, 'Acme', '#111111', 1, ${CLIENT_RATE[1]}),
            (2, 'Beta', '#222222', 1, ${CLIENT_RATE[2]})`
  ).run()
  const project = db.prepare(
    `INSERT INTO projects (id, client_id, name, color, rate_cent, active, status)
     VALUES (?, ?, ?, '#333333', ?, 1, 'active')`
  )
  project.run(10, 1, 'Website', PROJECT_RATE[10])
  project.run(12, 1, 'Goodwill', PROJECT_RATE[12])
  project.run(20, 2, 'Beta-Projekt', PROJECT_RATE[20])
  const ins = db.prepare(
    `INSERT INTO entries (id, client_id, project_id, description, started_at, stopped_at,
                          tags, reference, billable, private_note, deleted_at)
     VALUES (@id, @client_id, @project_id, 'x', @started_at, @stopped_at, '', '', @billable,
             'geheim', @deleted_at)`
  )
  for (const e of [...COUNTED, ...IGNORED]) ins.run({ deleted_at: null, ...e })
}

const JUNE = { from: '2026-06-01', to: '2026-06-30' }

describe('get_report (Q17)', () => {
  let db: Database.Database
  let sdb: SqliteDb

  function open(roundStep: number): void {
    db = new DatabaseImpl(':memory:')
    seed(db, roundStep)
    sdb = db
  }

  beforeEach(() => open(15))

  describe('against hand-calculated targets (rounding step 15)', () => {
    it('totals over June', () => {
      const r = getReport(sdb, SHOW, { ...JUNE, groupBy: [] })
      expect(r.rounding_minutes).toBe(15)
      expect(r.rows).toEqual([])
      expect(r.totals).toEqual({
        entry_count: 5,
        seconds: 4020 + 50 + 1800 + 3600 + 1200,
        billable_seconds: 4020 + 50 + 3600 + 1200,
        rounded_seconds: (75 + 15 + 30 + 60 + 30) * 60,
        billable_rounded_seconds: (75 + 15 + 60 + 30) * 60,
        revenue_cent: 18750 + 3000 + 0 + 4500
      })
    })

    it('by client', () => {
      expect(getReport(sdb, SHOW, { ...JUNE, groupBy: ['client'] }).rows).toEqual([
        {
          client_id: 1,
          client_name: 'Acme',
          entry_count: 4,
          seconds: 4020 + 50 + 1800 + 3600,
          billable_seconds: 4020 + 50 + 3600,
          rounded_seconds: (75 + 15 + 30 + 60) * 60,
          billable_rounded_seconds: (75 + 15 + 60) * 60,
          revenue_cent: 18750 + 3000
        },
        {
          client_id: 2,
          client_name: 'Beta',
          entry_count: 1,
          seconds: 1200,
          billable_seconds: 1200,
          rounded_seconds: 1800,
          billable_rounded_seconds: 1800,
          revenue_cent: 4500
        }
      ])
    })

    it('by day, then client: one row per local day and client', () => {
      const rows = getReport(sdb, SHOW, { ...JUNE, groupBy: ['day', 'client'] }).rows
      expect(
        rows.map((r) => [r.day, r.client_id, r.billable_rounded_seconds, r.revenue_cent])
      ).toEqual([
        ['2026-06-10', 1, (75 + 15) * 60, 18750 + 3000],
        ['2026-06-11', 1, 60 * 60, 0],
        ['2026-06-12', 2, 30 * 60, 4500]
      ])
    })

    it('by project names entries without one "(kein Projekt)", with project_id null', () => {
      const rows = getReport(sdb, SHOW, { ...JUNE, groupBy: ['project'] }).rows
      expect(rows.map((r) => [r.project_id, r.project_name, r.revenue_cent])).toEqual([
        [null, '(kein Projekt)', 3000],
        [20, 'Beta-Projekt', 4500],
        [12, 'Goodwill', 0],
        [10, 'Website', 18750]
      ])
    })
  })

  it('bills what the invoice PDF bills: the JS path of pdf.ts over the same entries', () => {
    const r = getReport(sdb, SHOW, { ...JUNE, groupBy: [] })
    const billable = COUNTED.filter((e) => e.billable === 1)
    const ms = (e: FixtureEntry): number => Date.parse(e.stopped_at!) - Date.parse(e.started_at)
    const minutes = billable.map((e) => billedMinutes(ms(e), 15))
    const revenue = billable.reduce((sum, e, i) => {
      const rate = effectiveRateCent(
        e.project_id == null ? null : PROJECT_RATE[e.project_id],
        CLIENT_RATE[e.client_id]
      )
      return sum + feeCent(minutes[i], rate)
    }, 0)
    expect(r.totals.billable_rounded_seconds).toBe(minutes.reduce((a, b) => a + b, 0) * 60)
    expect(r.totals.revenue_cent).toBe(revenue)
  })

  it.each([0, 15])('a month by client and by project equals get_analytics (step %i)', (step) => {
    open(step)
    for (const privacy of [HIDE, SHOW]) {
      const a = getAnalytics(sdb, privacy, 2026, 6)
      const total = getReport(sdb, privacy, { ...JUNE, groupBy: [] }).totals
      expect(total.seconds).toBe(a.total_seconds)
      expect(total.billable_seconds).toBe(a.billable_seconds)
      expect(total.rounded_seconds).toBe(a.rounded_seconds)
      expect(total.billable_rounded_seconds).toBe(a.billable_rounded_seconds)
      expect(total.revenue_cent).toBe(a.revenue_cent)

      const byClient = getReport(sdb, privacy, { ...JUNE, groupBy: ['client'] }).rows
      expect(
        byClient
          .map((r) => ({ id: r.client_id, s: r.seconds, rev: r.revenue_cent }))
          .sort((x, y) => x.id! - y.id!)
      ).toEqual(
        a.by_client
          .map((c) => ({ id: c.client_id, s: c.seconds, rev: c.revenue_cent }))
          .sort((x, y) => x.id - y.id)
      )
      const byProject = getReport(sdb, privacy, { ...JUNE, groupBy: ['project'] }).rows
      const key = (id: number | null | undefined): number => id ?? -1
      expect(
        byProject
          .map((r) => ({ id: r.project_id, s: r.seconds, rev: r.revenue_cent }))
          .sort((x, y) => key(x.id) - key(y.id))
      ).toEqual(
        a.by_project
          .map((p) => ({ id: p.project_id, s: p.seconds, rev: p.revenue_cent }))
          .sort((x, y) => key(x.id) - key(y.id))
      )
    }
  })

  it('keeps revenue out unless rates are exposed', () => {
    const r = getReport(sdb, HIDE, { ...JUNE, groupBy: ['client', 'project'] })
    expect(r.totals.revenue_cent).toBeUndefined()
    expect(r.rows.every((row) => !('revenue_cent' in row))).toBe(true)
  })

  it('never carries descriptions or notes', () => {
    const text = JSON.stringify(
      getReport(sdb, SHOW, { ...JUNE, groupBy: ['day', 'client', 'project'] })
    )
    expect(text).not.toContain('geheim')
    expect(text).not.toContain('"description"')
  })

  it('filters by client, project and billable', () => {
    expect(getReport(sdb, SHOW, { ...JUNE, groupBy: [], clientId: 2 }).totals.entry_count).toBe(1)
    expect(getReport(sdb, SHOW, { ...JUNE, groupBy: [], projectId: 10 }).totals.seconds).toBe(
      4020 + 1800
    )
    const billable = getReport(sdb, SHOW, { ...JUNE, groupBy: [], billableOnly: true }).totals
    expect(billable.entry_count).toBe(4)
    expect(billable.seconds).toBe(billable.billable_seconds)
  })

  it('counts both ends of the range and nothing outside it', () => {
    expect(
      getReport(sdb, SHOW, { from: '2026-06-10', to: '2026-06-10', groupBy: [] }).totals.entry_count
    ).toBe(2)
    expect(
      getReport(sdb, SHOW, { from: '2026-06-12', to: '2026-07-01', groupBy: [] }).totals.entry_count
    ).toBe(2)
    expect(
      getReport(sdb, SHOW, { from: '2026-05-01', to: '2026-05-31', groupBy: ['client'] })
    ).toMatchObject({
      rows: [],
      totals: { entry_count: 0, seconds: 0, revenue_cent: 0 }
    })
  })

  it('grouped by project, each row names its client; clients without projects stay apart', () => {
    // Beta also gets an entry without a project: two "(kein Projekt)" rows.
    db.prepare(
      `INSERT INTO entries (id, client_id, project_id, description, started_at, stopped_at,
                            tags, reference, billable, private_note)
       VALUES (10, 2, NULL, 'x', '2026-06-22T12:00:00.000Z', '2026-06-22T12:30:00.000Z', '', '', 1, '')`
    ).run()
    const rows = getReport(sdb, SHOW, { ...JUNE, groupBy: ['project'] }).rows
    expect(rows.map((r) => [r.project_id, r.client_id, r.seconds])).toEqual([
      [null, 1, 50],
      [null, 2, 1800],
      [20, 2, 1200],
      [12, 1, 3600],
      [10, 1, 4020 + 1800]
    ])
  })

  it('leaves a group of zero-length entries out of the rows, like get_analytics', () => {
    db.prepare(
      `INSERT INTO entries (id, client_id, project_id, description, started_at, stopped_at,
                            tags, reference, billable, private_note)
       VALUES (9, 2, NULL, 'x', '2026-06-20T12:00:00.000Z', '2026-06-20T12:00:00.000Z', '', '', 1, '')`
    ).run()
    const r = getReport(sdb, SHOW, { ...JUNE, groupBy: ['day'] })
    expect(r.rows.map((row) => row.day)).not.toContain('2026-06-20')
    expect(r.totals.entry_count).toBe(6)
    expect(getAnalytics(sdb, SHOW, 2026, 6).by_client.map((c) => c.client_id)).toEqual(
      getReport(sdb, SHOW, { ...JUNE, groupBy: ['client'] }).rows.map((row) => row.client_id)
    )
  })

  it('lists the same clients as get_analytics, also for a sub-second non-billable entry', () => {
    // 400 ms, not billable: no whole second and no revenue, but a billed
    // minute. get_analytics leaves such a client out; so does the report.
    db.prepare(
      `INSERT INTO clients (id, name, color, active, rate_cent) VALUES (3, 'Gamma', '#555555', 1, 6000)`
    ).run()
    db.prepare(
      `INSERT INTO entries (id, client_id, project_id, description, started_at, stopped_at,
                            tags, reference, billable, private_note)
       VALUES (11, 3, NULL, 'x', '2026-06-25T12:00:00.000Z', '2026-06-25T12:00:00.400Z', '', '', 0, '')`
    ).run()
    const report = getReport(sdb, SHOW, { ...JUNE, groupBy: ['client'] }).rows.map(
      (r) => r.client_id
    )
    const analytics = getAnalytics(sdb, SHOW, 2026, 6).by_client.map((c) => c.client_id)
    expect(report.sort()).toEqual(analytics.sort())
    expect(report).not.toContain(3)
  })

  it('with rates hidden, whether a row appears does not depend on the rate', () => {
    // Two clients, each with one billable 400 ms entry (a billed minute, no
    // whole second); one has a rate, one has none. A row that showed only
    // for the client with a rate would reveal that rate.
    db.prepare(
      `INSERT INTO clients (id, name, color, active, rate_cent)
       VALUES (3, 'Gamma', '#555555', 1, 6000), (4, 'Delta', '#666666', 1, 0)`
    ).run()
    const ins = db.prepare(
      `INSERT INTO entries (id, client_id, project_id, description, started_at, stopped_at,
                            tags, reference, billable, private_note)
       VALUES (?, ?, NULL, 'x', '2026-06-26T12:00:00.000Z', '2026-06-26T12:00:00.400Z', '', '', 1, '')`
    )
    ins.run(12, 3)
    ins.run(13, 4)
    const listed = getReport(sdb, HIDE, { ...JUNE, groupBy: ['client'] }).rows.map(
      (r) => r.client_id
    )
    expect(listed.includes(3)).toBe(listed.includes(4))
  })

  it('treats a negative stored rounding step as no step, like the money rule', () => {
    db.prepare(`UPDATE settings SET value = '-5' WHERE key = 'pdf_round_minutes'`).run()
    const r = getReport(sdb, SHOW, { ...JUNE, groupBy: [] })
    expect(r.rounding_minutes).toBe(0)
    // 67 + 1 + 30 + 60 + 20 whole minutes, no step.
    expect(r.totals.rounded_seconds).toBe((67 + 1 + 30 + 60 + 20) * 60)
  })

  it('refuses malformed input instead of guessing', () => {
    const at =
      (q: Partial<Parameters<typeof getReport>[2]>): (() => unknown) =>
      () =>
        getReport(sdb, SHOW, { ...JUNE, groupBy: [], ...q })
    expect(at({ from: '2026-6-1' })).toThrow(/YYYY-MM-DD/)
    expect(at({ to: '2026-02-30' })).toThrow(/YYYY-MM-DD/)
    expect(at({ from: '2026-07-01', to: '2026-06-01' })).toThrow(/is after/)
    expect(at({ from: '2025-01-01', to: '2026-01-02' })).toThrow(
      new RegExp(String(REPORT_MAX_DAYS))
    )
    expect(at({ groupBy: ['client', 'client'] })).toThrow(/twice/)
    // The longest allowed range passes.
    expect(at({ from: '2025-06-30', to: '2026-06-30' })).not.toThrow()
  })
})
