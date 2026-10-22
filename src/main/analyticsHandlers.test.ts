/**
 * Unit tests for analytics:summary — SQL aggregation logic.
 *
 * We bypass the Electron IPC layer entirely and call `buildAnalyticsSummary`
 * directly against an in-memory SQLite DB with all migrations applied.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { buildAnalyticsSummary } from './analyticsHandlers'
import type { AnalyticsSummary } from '../shared/types'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

// ── DB setup helpers ───────────────────────────────────────────────────────

function makeDb(Ctor: DatabaseCtor, dir: string): Database.Database {
  const db = new Ctor(join(dir, 'test.sqlite'))
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  return db
}

/** Insert a completed entry. started/stopped are ISO strings. */
function addEntry(
  db: Database.Database,
  opts: {
    client_id: number
    started_at: string
    stopped_at: string
    billable?: number
    project_id?: number | null
  }
): void {
  db.prepare(
    `INSERT INTO entries (client_id, started_at, stopped_at, billable, project_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    opts.client_id,
    opts.started_at,
    opts.stopped_at,
    opts.billable ?? 1,
    opts.project_id ?? null
  )
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('buildAnalyticsSummary', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-analytics-'))
    db = makeDb(DatabaseImpl, tmpDir)

    // Seed two clients
    db.prepare(
      `INSERT INTO clients (id, name, color, rate_cent) VALUES (1, 'Acme', '#8b7cf8', 8500)`
    ).run()
    db.prepare(
      `INSERT INTO clients (id, name, color, rate_cent) VALUES (2, 'Beta', '#4ade80', 0)`
    ).run()
  })

  afterEach(() => {
    if (!db) return
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── 1. Month stats happy path ────────────────────────────────────────────

  it('returns correct hours and revenue for selected month', () => {
    // 2 hours for Acme (rate 85 €/h) in April 2025
    addEntry(db, {
      client_id: 1,
      started_at: '2025-04-10T08:00:00.000Z',
      stopped_at: '2025-04-10T10:00:00.000Z' // 7200 sec
    })

    const res = buildAnalyticsSummary(db, { year: 2025, month: 4 })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(res.data.month.hours).toBe(7200)
    // 85 €/h * 2 h = 170 € = 17000 cents
    expect(res.data.month.revenue).toBe(17000)
    expect(res.data.month.hasData).toBe(true)
    expect(res.data.month.hasRateConfigured).toBe(true)
    expect(res.data.month.daysInMonth).toBe(30)
  })

  // ── 2. hasData = false for empty month ───────────────────────────────────

  it('returns hasData=false and zero values for a month with no entries', () => {
    const res = buildAnalyticsSummary(db, { year: 2024, month: 1 })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(res.data.month.hasData).toBe(false)
    expect(res.data.month.hours).toBe(0)
    expect(res.data.month.revenue).toBe(0)
  })

  // ── 3. COALESCE: project rate overrides client rate ──────────────────────

  it('uses project rate_cent when it overrides client rate', () => {
    // Project with 120 €/h = 12000 cents
    db.prepare(
      `INSERT INTO projects (id, client_id, name, color, rate_cent) VALUES (10, 1, 'BigDeal', '#fff', 12000)`
    ).run()

    // 1 hour on that project → 120 € = 12000 cents
    addEntry(db, {
      client_id: 1,
      started_at: '2025-06-01T09:00:00.000Z',
      stopped_at: '2025-06-01T10:00:00.000Z', // 3600 sec
      project_id: 10
    })

    const res = buildAnalyticsSummary(db, { year: 2025, month: 6 })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(res.data.month.revenue).toBe(12000)
  })

  // ── 4. project_id = NULL uses client rate ────────────────────────────────

  it('falls back to client rate when project_id is null', () => {
    // 3 hours for Acme (client rate 85 €/h), no project
    addEntry(db, {
      client_id: 1,
      started_at: '2025-07-05T08:00:00.000Z',
      stopped_at: '2025-07-05T11:00:00.000Z', // 10800 sec
      project_id: null
    })

    const res = buildAnalyticsSummary(db, { year: 2025, month: 7 })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    // 85 €/h * 3 h = 255 € = 25500 cents
    expect(res.data.month.revenue).toBe(25500)
  })

  // ── 5. billable ratio ────────────────────────────────────────────────────

  it('computes billable ratio correctly', () => {
    // 2 hours billable, 1 hour non-billable
    addEntry(db, {
      client_id: 1,
      started_at: '2025-08-01T08:00:00.000Z',
      stopped_at: '2025-08-01T10:00:00.000Z', // 7200 sec, billable=1
      billable: 1
    })
    addEntry(db, {
      client_id: 1,
      started_at: '2025-08-01T11:00:00.000Z',
      stopped_at: '2025-08-01T12:00:00.000Z', // 3600 sec, billable=0
      billable: 0
    })

    const res = buildAnalyticsSummary(db, { year: 2025, month: 8 })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(res.data.month.hours).toBe(10800) // 2h + 1h
    // billable = 7200 / 10800 ≈ 0.666...
    expect(res.data.month.billable).toBeCloseTo(2 / 3, 5)
  })

  // ── 6. January — year boundary (prev month = December of prior year) ─────

  it('handles January correctly (prev month = December prior year)', () => {
    // December 2024 entry
    addEntry(db, {
      client_id: 1,
      started_at: '2024-12-15T09:00:00.000Z',
      stopped_at: '2024-12-15T10:00:00.000Z'
    })
    // January 2025 entry
    addEntry(db, {
      client_id: 1,
      started_at: '2025-01-10T09:00:00.000Z',
      stopped_at: '2025-01-10T11:00:00.000Z'
    })

    const res = buildAnalyticsSummary(db, { year: 2025, month: 1 })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(res.data.month.hours).toBe(7200) // only January
    expect(res.data.month.hoursPrev).toBe(3600) // December
    expect(res.data.month.daysInMonth).toBe(31)
  })

  // ── 7. February — correct days-in-month (2024 = leap year) ──────────────

  it('reports correct days for February 2024 (leap year)', () => {
    addEntry(db, {
      client_id: 2,
      started_at: '2024-02-14T10:00:00.000Z',
      stopped_at: '2024-02-14T11:00:00.000Z'
    })

    const res = buildAnalyticsSummary(db, { year: 2024, month: 2 })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(res.data.month.daysInMonth).toBe(29)
  })

  // ── 8. 12-week trailing: returns exactly 12 week buckets ────────────────

  it('returns exactly 12 week buckets in weeks array', () => {
    addEntry(db, {
      client_id: 1,
      started_at: '2025-04-10T08:00:00.000Z',
      stopped_at: '2025-04-10T10:00:00.000Z'
    })

    const res = buildAnalyticsSummary(db, { year: 2025, month: 4 })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(res.data.weeks).toHaveLength(12)
    // Each entry has lbl, b, n
    for (const w of res.data.weeks) {
      expect(w).toHaveProperty('lbl')
      expect(w).toHaveProperty('b')
      expect(w).toHaveProperty('n')
    }
  })

  // ── 9. 12-month trailing: returns exactly 12 month buckets ──────────────

  it('returns exactly 12 month buckets in months array', () => {
    addEntry(db, {
      client_id: 1,
      started_at: '2025-04-10T08:00:00.000Z',
      stopped_at: '2025-04-10T10:00:00.000Z'
    })

    const res = buildAnalyticsSummary(db, { year: 2025, month: 4 })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(res.data.months).toHaveLength(12)
    // The last bucket should be April (the selected month)
    expect(res.data.months[11].lbl).toBe('Apr')
    // The first bucket should be May of prior year
    expect(res.data.months[0].lbl).toBe('Mai')
  })

  // ── 10. Invalid query returns error ─────────────────────────────────────

  it('returns error for invalid month query', () => {
    const res = buildAnalyticsSummary(db, { year: 2025, month: 13 })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(/Monatsangabe/)
  })

  // ── 11. Deleted entries are excluded ────────────────────────────────────

  it('excludes deleted entries from totals', () => {
    // Insert entry + mark deleted
    const info = db
      .prepare(
        `INSERT INTO entries (client_id, started_at, stopped_at) VALUES (1, '2025-09-01T08:00:00.000Z', '2025-09-01T10:00:00.000Z')`
      )
      .run()
    db.prepare(`UPDATE entries SET deleted_at = datetime('now') WHERE id = ?`).run(
      info.lastInsertRowid
    )

    const res = buildAnalyticsSummary(db, { year: 2025, month: 9 })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(res.data.month.hasData).toBe(false)
    expect(res.data.month.hours).toBe(0)
  })

  // ── 12. weekday array contains 7 entries (Mo–So) ─────────────────────────

  it('returns 7 weekday entries labeled Mo–So', () => {
    addEntry(db, {
      client_id: 1,
      started_at: '2025-04-07T08:00:00.000Z', // Monday
      stopped_at: '2025-04-07T10:00:00.000Z'
    })

    const res = buildAnalyticsSummary(db, { year: 2025, month: 4 })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(res.data.weekday).toHaveLength(7)
    expect(res.data.weekday.map((d) => d.d)).toEqual(['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'])
  })

  // ── Invoice rule (shared/currency.ts) ───────────────────────────────────

  it('a sub-second entry is data: no whole second of hours, but the minute it bills', () => {
    addEntry(db, {
      client_id: 1,
      started_at: '2025-04-10T08:00:00.000Z',
      stopped_at: '2025-04-10T08:00:00.400Z'
    })
    const res = buildAnalyticsSummary(db, { year: 2025, month: 4 })
    if (!res.ok) throw new Error(res.error)
    expect(res.data.month.hasData).toBe(true)
    expect(res.data.month.hours).toBe(0)
    // 1 min at 85 €/h = 141,67 ct → 142
    expect(res.data.month.revenue).toBe(142)
  })

  it('a goodwill project (rate 0) adds hours but no revenue', () => {
    db.prepare(`INSERT INTO projects (id, client_id, name, rate_cent) VALUES (9, 1, 'K', 0)`).run()
    addEntry(db, {
      client_id: 1,
      project_id: 9,
      started_at: '2025-04-10T08:00:00.000Z',
      stopped_at: '2025-04-10T10:00:00.000Z'
    })
    const res = buildAnalyticsSummary(db, { year: 2025, month: 4 })
    if (!res.ok) throw new Error(res.error)
    expect(res.data.month.hours).toBe(7200)
    expect(res.data.month.revenue).toBe(0)
  })

  it('the 12-month revenue trend counts billable time only (#104)', () => {
    addEntry(db, {
      client_id: 1,
      billable: 0,
      started_at: '2025-04-10T08:00:00.000Z',
      stopped_at: '2025-04-10T10:00:00.000Z'
    })
    const res = buildAnalyticsSummary(db, { year: 2025, month: 4 })
    if (!res.ok) throw new Error(res.error)
    // The trend ends with the selected month.
    const april = res.data.months[res.data.months.length - 1]
    expect(april.h).toBe(7200)
    expect(april.r).toBe(0)
  })

  // ── 13. Non-billable hours excluded from revenue (#104) ─────────────────

  it('excludes non-billable entries from revenue calculation', () => {
    // 2 hours billable at 100 €/h → 200 € = 20000 cents
    addEntry(db, {
      client_id: 1,
      started_at: '2025-10-01T08:00:00.000Z',
      stopped_at: '2025-10-01T10:00:00.000Z',
      billable: 1
    })
    // 3 hours non-billable — must NOT contribute to revenue
    addEntry(db, {
      client_id: 1,
      started_at: '2025-10-01T11:00:00.000Z',
      stopped_at: '2025-10-01T14:00:00.000Z',
      billable: 0
    })

    const res = buildAnalyticsSummary(db, { year: 2025, month: 10 })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    // total hours include both billable + non-billable
    expect(res.data.month.hours).toBe(18000) // 5 h in seconds
    // revenue must only count the 2 billable hours: 2 * 85 €/h = 170 € = 17000 cents
    expect(res.data.month.revenue).toBe(17000)
  })

  // ── 14. Per-client revenue excludes non-billable entries (#104) ──────────

  it('excludes non-billable entries from per-client revenue breakdown', () => {
    // 1 hour billable for Acme (85 €/h) → 8500 cents
    addEntry(db, {
      client_id: 1,
      started_at: '2025-11-01T08:00:00.000Z',
      stopped_at: '2025-11-01T09:00:00.000Z',
      billable: 1
    })
    // 2 hours non-billable for Acme — must NOT add to rev
    addEntry(db, {
      client_id: 1,
      started_at: '2025-11-01T10:00:00.000Z',
      stopped_at: '2025-11-01T12:00:00.000Z',
      billable: 0
    })

    const res = buildAnalyticsSummary(db, { year: 2025, month: 11 })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const acme = res.data.byClient.find((c) => c.client_id === 1)
    expect(acme).toBeDefined()
    // only 1 billable hour: 85 €/h → 8500 cents
    expect(acme!.rev).toBe(8500)
  })
})

describe('buildAnalyticsSummary — worked time, rounded sub-line, fair comparison (PR 4)', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-analytics-pr4-'))
    db = makeDb(DatabaseImpl, tmpDir)
    db.prepare(
      `INSERT INTO clients (id, name, color, rate_cent) VALUES (1, 'Acme', '#8b7cf8', 8500)`
    ).run()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // Mid-day UTC: the same local day for any zone between UTC-9 and UTC+11.
  function add(day: string, startHm: string, stopHm: string, billable = 1): void {
    addEntry(db, {
      client_id: 1,
      started_at: `${day}T${startHm}:00.000Z`,
      stopped_at: `${day}T${stopHm}:00.000Z`,
      billable
    })
  }

  function step(minutes: number): void {
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('pdf_round_minutes', ?)`).run(
      String(minutes)
    )
  }

  function summary(year: number, month: number, now: Date): AnalyticsSummary {
    const r = buildAnalyticsSummary(db, { year, month }, now)
    if (!r.ok) throw new Error(r.error)
    return r.data
  }

  const OCT_22 = new Date(2026, 9, 22, 12)

  it('hours are worked time; the rounded month is its own field, per entry', () => {
    step(15)
    add('2026-09-10', '10:00', '10:10') // 10 min → 15 when rounded
    add('2026-09-11', '10:00', '10:50') // 50 min → 60
    const s = summary(2026, 9, OCT_22)
    expect(s.month.hours).toBe(3600)
    expect(s.month.hoursRounded).toBe(75 * 60)
    expect(s.byClient[0].h).toBe(3600)
    expect(s.months[11]).toMatchObject({ h: 3600, b: 3600, n: 0 })
    expect(s.weeks.reduce((sum, w) => sum + w.b + w.n, 0)).toBe(3600)
  })

  it('without a rounding step there is no rounded figure', () => {
    add('2026-09-10', '10:00', '10:10')
    expect(summary(2026, 9, OCT_22).month.hoursRounded).toBeNull()
  })

  it('months split billable and non-billable; weeks carry revenue', () => {
    add('2026-09-10', '10:00', '11:00') // billable, 85 €
    add('2026-09-11', '10:00', '10:30', 0) // non-billable
    const s = summary(2026, 9, OCT_22)
    expect(s.months[11]).toMatchObject({ h: 5400, b: 3600, n: 1800, r: 8500 })
    expect(s.weeks.reduce((sum, w) => sum + w.r, 0)).toBe(8500)
  })

  it('the current month is compared with the same days of the previous one (B2)', () => {
    add('2026-09-10', '10:00', '11:00') // inside 1–22 September
    add('2026-09-25', '10:00', '12:00') // after the 22nd: not compared
    add('2026-10-05', '10:00', '11:00')
    const s = summary(2026, 10, OCT_22)
    expect(s.month.comparison).toBe('samePeriod')
    expect(s.month.prevPeriodDays).toBe(22)
    expect(s.month.hoursPrev).toBe(3600)
    expect(s.month.revenuePrev).toBe(8500)
  })

  it('a past month is compared with the whole previous month', () => {
    add('2026-08-30', '10:00', '11:00')
    add('2026-09-10', '10:00', '11:00')
    const s = summary(2026, 9, OCT_22)
    expect(s.month.comparison).toBe('fullMonth')
    expect(s.month.prevPeriodDays).toBe(31)
    expect(s.month.hoursPrev).toBe(3600)
  })

  it('the weekday average is per calendar day over the last 90 completed days', () => {
    // now = Thu 22 Oct; the span is Fri 24 Jul … Wed 21 Oct: 12 Thursdays,
    // 13 of every other weekday.
    for (let i = 0; i < 4; i++) add('2026-10-19', '09:00', '11:00') // Mon: 4 × 2 h
    add('2026-10-17', '09:00', '14:00') // Sat: 5 h
    add('2026-10-15', '09:00', '15:00') // Thu: 6 h
    add('2026-10-22', '09:00', '12:00') // today: not counted
    const s = summary(2026, 10, OCT_22)
    const byDay = new Map(s.weekday.map((w) => [w.d, w.h]))
    expect(byDay.get('Mo')).toBe(Math.round((8 * 3600) / 13))
    expect(byDay.get('Sa')).toBe(Math.round((5 * 3600) / 13))
    expect(byDay.get('Do')).toBe((6 * 3600) / 12)
    expect(byDay.get('Di')).toBe(0)
  })

  it('byClient carries the billable seconds next to all seconds', () => {
    add('2026-09-10', '10:00', '11:00')
    add('2026-09-11', '10:00', '10:30', 0)
    expect(summary(2026, 9, OCT_22).byClient[0]).toMatchObject({ h: 5400, b: 3600 })
  })

  it('the compared span is clamped to the length of the previous month', () => {
    add('2026-02-27', '10:00', '11:00')
    const s = summary(2026, 3, new Date(2026, 2, 31, 12))
    expect(s.month.comparison).toBe('samePeriod')
    expect(s.month.prevPeriodDays).toBe(28)
    expect(s.month.hoursPrev).toBe(3600)
  })
})
