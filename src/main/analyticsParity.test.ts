/**
 * The app's Auswertung and MCP get_analytics compute hours and revenue from
 * the same entries with the same rules (owner decision 2026-10-22): worked
 * seconds raw, the month rounded per entry like the invoice, revenue like the
 * invoice. Two code paths, one answer — so the numbers cannot drift apart
 * again, as hours and revenue once did.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { buildAnalyticsSummary } from './analyticsHandlers'
import { getAnalytics } from '../mcp/queries'
import { buildPdfPayload } from './pdf'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

const SHOW = { exposeRates: true, exposePrivateNotes: false }

describe('Auswertung and get_analytics agree', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-parity-'))
    db = new DatabaseImpl(join(tmpDir, 'test.sqlite'))
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    db.prepare(
      `INSERT INTO clients (id, name, color, rate_cent) VALUES (1, 'Acme', '#111', 8500), (2, 'Beta', '#222', 6000)`
    ).run()
    db.prepare(
      `INSERT INTO projects (id, client_id, name, rate_cent) VALUES (10, 1, 'Audit', 12000), (11, 1, 'Kulanz', 0)`
    ).run()
    const ins = db.prepare(
      `INSERT INTO entries (client_id, project_id, started_at, stopped_at, billable) VALUES (?, ?, ?, ?, ?)`
    )
    // Odd seconds on purpose, so raw, minute-ceiled and stepped all differ.
    ins.run(1, null, '2026-09-03T09:00:00.000Z', '2026-09-03T09:07:31.000Z', 1)
    ins.run(1, 10, '2026-09-04T10:00:00.000Z', '2026-09-04T11:52:05.500Z', 1)
    ins.run(1, 11, '2026-09-05T10:00:00.000Z', '2026-09-05T10:44:10.000Z', 1)
    ins.run(2, null, '2026-09-08T12:00:00.000Z', '2026-09-08T13:01:01.000Z', 0)
    ins.run(2, null, '2026-09-09T12:00:00.000Z', '2026-09-09T12:00:00.400Z', 1)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  for (const step of [0, 1, 6, 15, 30]) {
    it(`same hours, rounded hours and revenue (rounding step ${step})`, () => {
      db.prepare(
        `INSERT OR REPLACE INTO settings (key, value) VALUES ('pdf_round_minutes', ?)`
      ).run(String(step))
      const app = buildAnalyticsSummary(db, { year: 2026, month: 9 }, new Date(2026, 9, 22, 12))
      if (!app.ok) throw new Error(app.error)
      const mcp = getAnalytics(db, SHOW, 2026, 9)

      expect(app.data.month.hours).toBe(mcp.total_seconds)
      expect(app.data.month.revenue).toBe(mcp.revenue_cent)
      if (step > 0) expect(app.data.month.hoursRounded).toBe(mcp.rounded_seconds)
      else expect(app.data.month.hoursRounded).toBeNull()
      // Rounding never shrinks a month.
      expect(mcp.rounded_seconds).toBeGreaterThanOrEqual(mcp.total_seconds)

      // billable_rounded_seconds is what the month's invoices bill together:
      // the PDF hours of every client for September. The non-billable Beta
      // entry is in rounded_seconds but not here. The PDF reads the same step.
      const pdfSeconds = [1, 2].reduce((sum, clientId) => {
        const p = buildPdfPayload(db, { clientId, fromIso: '2026-09-01', toIso: '2026-09-30' }, '')
        return sum + p.totals.minutes * 60
      }, 0)
      expect(mcp.billable_rounded_seconds).toBe(pdfSeconds)
      expect(mcp.billable_rounded_seconds).toBeLessThan(mcp.rounded_seconds)

      const byApp = new Map(app.data.byClient.map((c) => [c.client_id, c]))
      for (const c of mcp.by_client) {
        expect(byApp.get(c.client_id)?.h, `client ${c.client_id} hours`).toBe(c.seconds)
        expect(byApp.get(c.client_id)?.rev, `client ${c.client_id} revenue`).toBe(c.revenue_cent)
      }
    })
  }
})
