/**
 * Design 11.2: every reader of money gives the same billed minutes and
 * revenue per client and month, AND those equal values worked out by hand.
 * Four sums agreeing is not enough: they could all be wrong together.
 *
 * October 2026 (midday UTC, so the local date is the same in every zone):
 *   Client A, 90 €/h until 14 Oct, 120 €/h from 15 Oct; profile: grid 15, minimum 30.
 *   Project PA of A: profile overrides only the interval (10), minimum unit 30 is inherited.
 *   Client B, 60 €/h, default profile (rounding off).
 *
 *   e1 A      5 Oct   4 min      -> unit 30 on grid 15          = 30 min x  90 €/h =  45,00 €
 *   e2 A/PA   6 Oct  31 min      -> 31 on grid 10               = 40 min x  90 €/h =  60,00 €
 *   e3 A     20 Oct  30 min      -> 30                          = 30 min x 120 €/h =  60,00 €
 *   e4 B      7 Oct  61 min 1 s  -> 62 whole minutes, no grid   = 62 min x  60 €/h =  62,00 €
 *   e5 B      8 Oct  10 min, not billable                       = 10 min, no revenue
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { buildAnalyticsSummary } from './analyticsHandlers'
import { buildBudgetStatus } from './budgetHandlers'
import { getAnalytics, listProjects } from '../mcp/queries'
import { buildPdfPayload } from './pdf'
import { buildWebhookPayload } from './webhooks'
import { seedEntry } from '../test/entryFixtures'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

const SHOW = { exposeRates: true, exposePrivateNotes: false }

describe('all money readers agree with the hand-computed month', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    db.prepare(
      `INSERT INTO clients (id, name, color, rate_cent) VALUES (1, 'A', '#111', 9000), (2, 'B', '#222', 6000)`
    ).run()
    db.prepare(
      `INSERT INTO projects (id, client_id, name, budget_minutes) VALUES (10, 1, 'PA', 600)`
    ).run()
    db.prepare(
      `INSERT INTO rate (client_id, rate_cent, valid_from) VALUES (1, 12000, '2026-10-15')`
    ).run()
    db.prepare(
      `INSERT INTO billing_profile (client_id, interval_min, min_unit_min) VALUES (1, 15, 30)`
    ).run()
    db.prepare(`INSERT INTO billing_profile (project_id, interval_min) VALUES (10, 10)`).run()
    const add = (
      id: number,
      client_id: number,
      project_id: number | null,
      day: string,
      secs: number,
      billable = 1
    ): void => {
      const start = Date.parse(`${day}T10:00:00.000Z`)
      seedEntry(db, {
        id,
        client_id,
        project_id,
        billable,
        started_at: new Date(start).toISOString(),
        stopped_at: new Date(start + secs * 1000).toISOString()
      })
    }
    add(1, 1, null, '2026-10-05', 4 * 60)
    add(2, 1, 10, '2026-10-06', 31 * 60)
    add(3, 1, null, '2026-10-20', 30 * 60)
    add(4, 2, null, '2026-10-07', 61 * 60 + 1)
    add(5, 2, null, '2026-10-08', 10 * 60, 0)
  })
  afterEach(() => db.close())

  it('Auswertung', () => {
    const app = buildAnalyticsSummary(db, { year: 2026, month: 10 }, new Date(2026, 10, 2, 12))
    if (!app.ok) throw new Error(app.error)
    expect(app.data.month.revenue).toBe(22700)
    expect(app.data.month.hoursRounded).toBe(172 * 60)
    const byClient = new Map(app.data.byClient.map((c) => [c.client_id, c]))
    expect(byClient.get(1)?.rev).toBe(16500)
    expect(byClient.get(2)?.rev).toBe(6200)
  })

  it('MCP get_analytics', () => {
    const a = getAnalytics(db, SHOW, 2026, 10)
    expect(a.revenue_cent).toBe(22700)
    expect(a.rounded_seconds).toBe(172 * 60)
    expect(a.billable_rounded_seconds).toBe(162 * 60)
    const rev = new Map(a.by_client.map((c) => [c.client_id, c.revenue_cent]))
    expect(rev.get(1)).toBe(16500)
    expect(rev.get(2)).toBe(6200)
  })

  it('PDF per client', () => {
    const range = { fromIso: '2026-10-01', toIso: '2026-10-31' }
    const a = buildPdfPayload(db, { clientId: 1, ...range }, '')
    const b = buildPdfPayload(db, { clientId: 2, ...range }, '')
    expect(a.totals).toMatchObject({ minutes: 100, feeCent: 16500 })
    expect(b.totals).toMatchObject({ minutes: 62, feeCent: 6200 })
  })

  it('budget of the project and MCP list_projects', () => {
    const status = buildBudgetStatus(db, 10)
    if (!status.ok) throw new Error(status.error)
    expect(status.data.usedMinutes).toBe(40)
    expect(listProjects(db, SHOW).find((p) => p.id === 10)?.used_minutes).toBe(40)
  })

  it('webhook revenue of an entry', () => {
    const row = db.prepare('SELECT * FROM entries WHERE id = 3').get() as never
    const p = buildWebhookPayload(db, 'entry.updated', row, SHOW, { deliveryId: 'x', now: 0 })
    expect(p.entry.revenue_cent).toBe(6000)
  })
})
