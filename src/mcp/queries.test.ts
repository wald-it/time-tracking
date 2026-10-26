/**
 * Unit tests for the read-only MCP query layer.
 *
 * Same approach as ipc.test.ts: seed an in-memory DB with the real migrations
 * and exercise the query functions directly.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import {
  durationSeconds,
  listClients,
  listProjects,
  listEntries,
  getEntryHistory,
  getRunningTimer,
  getAnalytics,
  getSetting,
  readStoredPrivacy,
  type SqliteDb
} from './queries'
import { resolvePrivacy, type PrivacyConfig } from './privacy'

const HIDE: PrivacyConfig = { exposeRates: false, exposePrivateNotes: false }
const SHOW: PrivacyConfig = { exposeRates: true, exposePrivateNotes: true }

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

function seed(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  applyMigrations(db)

  // Clients: 1 active (with rate), 2 archived.
  db.prepare(
    `INSERT INTO clients (id, name, color, active, rate_cent, vat_id, contact_person)
     VALUES (1, 'Acme', '#111111', 1, 12000, 'DE123', 'Alice'),
            (2, 'Zeta', '#222222', 0, 0, NULL, NULL)`
  ).run()

  // Projects: active + archived for client 1.
  db.prepare(
    `INSERT INTO projects
       (id, client_id, name, color, rate_cent, active, status, budget_minutes,
        external_project_number)
     VALUES (10, 1, 'Website', '#333333', 15000, 1, 'active', 600, 'EXT-42'),
            (11, 1, 'Altprojekt', '#444444', NULL, 0, 'archived', NULL, NULL)`
  ).run()

  // Entries in June 2026: two completed (client 1), one non-billable, one
  // soft-deleted (must be ignored), plus a running timer.
  const ins = (e: {
    id: number
    client_id: number
    project_id: number | null
    description: string
    started_at: string
    stopped_at: string | null
    tags: string
    reference: string
    billable: number
    private_note: string
    deleted_at: string | null
  }): void => {
    seedEntry(db, e)
  }
  // 1h billable, project 10, tagged bug
  ins({
    id: 100,
    client_id: 1,
    project_id: 10,
    description: 'Feature A',
    started_at: '2026-06-10T09:00:00.000Z',
    stopped_at: '2026-06-10T10:00:00.000Z',
    tags: ',bug,ux,',
    reference: 'JIRA-1',
    billable: 1,
    private_note: 'geheim',
    deleted_at: null
  })
  // 30m non-billable, no project
  ins({
    id: 101,
    client_id: 1,
    project_id: null,
    description: 'Call',
    started_at: '2026-06-11T09:00:00.000Z',
    stopped_at: '2026-06-11T09:30:00.000Z',
    tags: '',
    reference: '',
    billable: 0,
    private_note: '',
    deleted_at: null
  })
  // soft-deleted — must never appear
  ins({
    id: 102,
    client_id: 1,
    project_id: 10,
    description: 'Deleted',
    started_at: '2026-06-12T09:00:00.000Z',
    stopped_at: '2026-06-12T11:00:00.000Z',
    tags: '',
    reference: '',
    billable: 1,
    private_note: '',
    deleted_at: '2026-06-12T12:00:00.000Z'
  })
  // running (no stopped_at)
  ins({
    id: 103,
    client_id: 1,
    project_id: null,
    description: 'Running',
    started_at: '2026-06-13T09:00:00.000Z',
    stopped_at: null,
    tags: '',
    reference: '',
    billable: 1,
    private_note: '',
    deleted_at: null
  })
}

describe('durationSeconds (pure)', () => {
  it('measures completed entries', () => {
    expect(durationSeconds('2026-06-10T09:00:00.000Z', '2026-06-10T10:00:00.000Z', 0)).toBe(3600)
  })
  it('measures running entries against now', () => {
    const now = Date.parse('2026-06-10T09:30:00.000Z')
    expect(durationSeconds('2026-06-10T09:00:00.000Z', null, now)).toBe(1800)
  })
  it('never returns negative', () => {
    expect(durationSeconds('2026-06-10T10:00:00.000Z', '2026-06-10T09:00:00.000Z', 0)).toBe(0)
  })
})

describe('query layer', () => {
  let db: Database.Database
  let sdb: SqliteDb

  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
    sdb = db
  })

  it('listClients hides archived and rates by default', () => {
    const clients = listClients(sdb, HIDE)
    expect(clients).toHaveLength(1)
    expect(clients[0].name).toBe('Acme')
    expect(clients[0].active).toBe(true)
    expect(clients[0].rate_cent).toBeUndefined()
    expect(clients[0].vat_id).toBe('DE123')
  })

  it('listClients includes archived and rates when asked', () => {
    const clients = listClients(sdb, SHOW, { includeArchived: true })
    expect(clients).toHaveLength(2)
    expect(clients.find((c) => c.name === 'Acme')?.rate_cent).toBe(12000)
  })

  it('listProjects excludes archived by default and reports usage', () => {
    const projects = listProjects(sdb, HIDE, { clientId: 1 })
    expect(projects).toHaveLength(1)
    expect(projects[0].name).toBe('Website')
    // project 10 has entry 100 (live) + 102 (soft-deleted, excluded) → 1
    expect(projects[0].entry_count).toBe(1)
  })

  it('listProjects entry_count excludes soft-deleted entries', () => {
    const projects = listProjects(sdb, HIDE, { clientId: 1, includeArchived: true })
    const website = projects.find((p) => p.id === 10)!
    // entries 100 (live) counts; 102 is soft-deleted → excluded.
    expect(website.entry_count).toBe(1)
    expect(website.rate_cent).toBeUndefined() // hidden
  })

  // #285: used_minutes is what the invoice bills — billable entries, rounded
  // per entry with pdf_round_minutes — not a sum of the stored rounded_min,
  // which the seed (like the timer) never writes.
  it('listProjects used_minutes counts like the invoice', () => {
    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('pdf_round_minutes', '15')`
    ).run()
    // Non-billable 20 minutes on the same project: not billed, not counted.
    seedEntry(db, {
      client_id: 1,
      project_id: 10,
      started_at: '2026-06-14T09:00:00.000Z',
      stopped_at: '2026-06-14T09:20:00.000Z',
      billable: 0
    })
    // Billable 7:40 → 8 started minutes → 15.
    seedEntry(db, {
      client_id: 1,
      project_id: 10,
      started_at: '2026-06-15T09:00:00.000Z',
      stopped_at: '2026-06-15T09:07:40.000Z',
      billable: 1
    })
    const website = listProjects(sdb, HIDE, { clientId: 1 }).find((p) => p.id === 10)!
    // Entry 100 (1 h) + 15; entry 102 is soft-deleted, 103 runs on no project.
    expect(website.used_minutes).toBe(75)
  })

  it('listEntries by month returns live entries with totals', () => {
    const now = Date.parse('2026-06-13T09:30:00.000Z') // running at 30m
    const res = listEntries(sdb, HIDE, { year: 2026, month: 6 }, now)
    // 100, 101, 103 — NOT the soft-deleted 102
    expect(res.count).toBe(3)
    expect(res.entries!.map((e) => e.id).sort()).toEqual([100, 101, 103])
    // 3600 + 1800 + 1800(running) = 7200
    expect(res.total_seconds).toBe(7200)
    const running = res.entries!.find((e) => e.id === 103)!
    expect(running.running).toBe(true)
    expect(running.stopped_at).toBeNull()
  })

  describe('one item per entry (OQ7, 2.0 P3)', () => {
    // 20:00 to 04:00 local across 20/21 June, plus an entry across the month
    // boundary 30 June 22:00 to 1 July 02:00 (local, whatever the zone).
    const local = (m: number, d: number, h: number): string =>
      new Date(2026, m - 1, d, h, 0, 0).toISOString()
    const nowMs = Date.parse('2026-08-01T00:00:00.000Z')

    it('a midnight entry is one item with the whole range, its version, source and segments', () => {
      const id = seedEntry(db, {
        client_id: 1,
        description: 'Nachtschicht',
        source: 'mcp',
        segments: [
          { started_at: local(6, 20, 20), stopped_at: local(6, 21, 0) },
          { started_at: local(6, 21, 0), stopped_at: local(6, 21, 4) }
        ]
      })
      const res = listEntries(sdb, HIDE, { from: local(6, 20, 0), to: local(6, 22, 0) }, nowMs)
      const items = res.entries!.filter((e) => e.id === id)
      expect(items).toHaveLength(1)
      const item = items[0]
      expect(item.started_at).toBe(local(6, 20, 20))
      expect(item.stopped_at).toBe(local(6, 21, 4))
      expect(item.duration_seconds).toBe(8 * 3600)
      expect(item.version).toBe(1)
      expect(item.source).toBe('mcp')
      expect(item.billed).toBeNull()
      expect(typeof item.created_at).toBe('string')
      expect(item.segments).toEqual([
        {
          seq: 0,
          segment_date: '2026-06-20',
          started_at: local(6, 20, 20),
          stopped_at: local(6, 21, 0),
          duration_seconds: 4 * 3600
        },
        {
          seq: 1,
          segment_date: '2026-06-21',
          started_at: local(6, 21, 0),
          stopped_at: local(6, 21, 4),
          duration_seconds: 4 * 3600
        }
      ])
    })

    it('a single-day entry has no segments array', () => {
      const res = listEntries(sdb, HIDE, { year: 2026, month: 6 }, nowMs)
      expect(res.entries!.find((e) => e.id === 100)!.segments).toBeUndefined()
    })

    it('counts an entry once and keeps the whole range when only its second day is in the window', () => {
      const id = seedEntry(db, {
        client_id: 1,
        segments: [
          { started_at: local(6, 20, 20), stopped_at: local(6, 21, 0) },
          { started_at: local(6, 21, 0), stopped_at: local(6, 21, 4) }
        ]
      })
      const res = listEntries(sdb, HIDE, { from: local(6, 21, 0), to: local(6, 22, 0) }, nowMs)
      const items = res.entries!.filter((e) => e.id === id)
      expect(items).toHaveLength(1)
      expect(items[0].started_at).toBe(local(6, 20, 20))
      expect(items[0].stopped_at).toBe(local(6, 21, 4))
      // Only the day inside the window counts towards the total.
      expect(res.total_seconds).toBe(4 * 3600)
      expect(res.count).toBe(1)
    })

    it('an entry over a month boundary shows in both months; each month totals its own part', () => {
      const id = seedEntry(db, {
        client_id: 1,
        segments: [
          { started_at: local(6, 30, 22), stopped_at: local(7, 1, 0) },
          { started_at: local(7, 1, 0), stopped_at: local(7, 1, 2) }
        ]
      })
      const june = listEntries(sdb, HIDE, { year: 2026, month: 6, clientId: 1 }, nowMs)
      const july = listEntries(sdb, HIDE, { year: 2026, month: 7 }, nowMs)
      expect(june.entries!.filter((e) => e.id === id)).toHaveLength(1)
      expect(july.entries!.filter((e) => e.id === id)).toHaveLength(1)
      expect(july.count).toBe(1)
      expect(july.total_seconds).toBe(2 * 3600)
      expect(june.entries!.find((e) => e.id === id)!.duration_seconds).toBe(4 * 3600)
    })

    it('a running entry has one segment and no money, as before', () => {
      const res = listEntries(
        sdb,
        HIDE,
        { year: 2026, month: 6 },
        Date.parse('2026-06-13T09:30:00.000Z')
      )
      const running = res.entries!.find((e) => e.id === 103)!
      expect(running.segments).toBeUndefined()
      expect(running.version).toBe(1)
    })
  })

  it('listEntries hides private_note by default, exposes when enabled', () => {
    const now = Date.now()
    const hidden = listEntries(sdb, HIDE, { year: 2026, month: 6 }, now)
    expect(hidden.entries!.find((e) => e.id === 100)?.private_note).toBeUndefined()
    const shown = listEntries(sdb, SHOW, { year: 2026, month: 6 }, now)
    expect(shown.entries!.find((e) => e.id === 100)?.private_note).toBe('geheim')
  })

  it('listEntries filters by tag (exact match)', () => {
    const res = listEntries(sdb, HIDE, { year: 2026, month: 6, tag: 'bug' }, Date.now())
    expect(res.entries!.map((e) => e.id)).toEqual([100])
    expect(res.entries![0].tags).toEqual(['bug', 'ux'])
  })

  it('listEntries filters by project', () => {
    const res = listEntries(sdb, HIDE, { year: 2026, month: 6, projectId: 10 }, Date.now())
    expect(res.entries!.map((e) => e.id)).toEqual([100])
  })

  it('listEntries caps entries at limit but counts the full match (#205)', () => {
    const now = Date.parse('2026-06-13T09:30:00.000Z')
    const res = listEntries(sdb, HIDE, { year: 2026, month: 6, limit: 1 }, now)
    // Only the earliest entry is returned…
    expect(res.entries!.map((e) => e.id)).toEqual([100])
    // …but the totals still cover all three matches.
    expect(res.count).toBe(3)
    expect(res.total_seconds).toBe(7200)
  })

  it('listEntries summary_only returns totals without entries (#205)', () => {
    const now = Date.parse('2026-06-13T09:30:00.000Z')
    const res = listEntries(sdb, HIDE, { year: 2026, month: 6, summaryOnly: true }, now)
    expect(res.entries).toBeUndefined()
    expect(res.count).toBe(3)
    expect(res.total_seconds).toBe(7200)
  })

  it('listEntries compares from/to as instants, whatever the offset (#228)', () => {
    // Entry 100 runs 09:00–10:00Z, i.e. 11:00–12:00 at +02:00. A sub-day
    // window with an offset must select it exactly like the same window in Z.
    const now = Date.parse('2026-06-13T09:30:00.000Z')
    const ids = (from: string, to: string): number[] =>
      listEntries(sdb, HIDE, { from, to }, now).entries!.map((e) => e.id)

    expect(ids('2026-06-10T08:30:00Z', '2026-06-10T09:30:00Z')).toEqual([100])
    expect(ids('2026-06-10T10:30:00+02:00', '2026-06-10T11:30:00+02:00')).toEqual([100])
    expect(ids('2026-06-10T04:30:00-04:30', '2026-06-10T05:30:00-04:30')).toEqual([100])
    // An offset window that lies before the entry as an instant must stay
    // empty, even though its local hour (09:xx) matches the stored UTC hour.
    expect(ids('2026-06-10T09:00:00+02:00', '2026-06-10T09:59:00+02:00')).toEqual([])
  })

  it('listEntries treats a boundary without milliseconds as the same instant (#228)', () => {
    // '…09:00:00Z' sorts after the stored '…09:00:00.000Z' as text; as an
    // instant it is equal, so the inclusive start must still match.
    const res = listEntries(
      sdb,
      HIDE,
      { from: '2026-06-10T09:00:00Z', to: '2026-06-10T09:00:01Z' },
      0
    )
    expect(res.entries!.map((e) => e.id)).toEqual([100])
  })

  it('listEntries keeps the date-only and offset-less forms on UTC (#228)', () => {
    expect(
      listEntries(sdb, HIDE, { from: '2026-06-10', to: '2026-06-11' }, 0).entries!.map((e) => e.id)
    ).toEqual([100])
    expect(
      listEntries(
        sdb,
        HIDE,
        { from: '2026-06-10T08:30:00', to: '2026-06-10T09:30:00' },
        0
      ).entries!.map((e) => e.id)
    ).toEqual([100])
  })

  it('listEntries treats a lowercase t separator like T (#228)', () => {
    // The pattern is case-insensitive, so the no-zone check must be too —
    // otherwise Date.parse reads '…t08:30:00' as local time. That is only
    // visible off UTC, so pin a non-UTC zone (CI runs on UTC).
    // Restored to the resolved system zone, not by `delete process.env.TZ`:
    // deleting does not reset Node's zone, and this file runs more tests after.
    const restoreTz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    process.env.TZ = 'Asia/Kolkata'
    try {
      expect(
        listEntries(
          sdb,
          HIDE,
          { from: '2026-06-10t08:30:00', to: '2026-06-10t09:30:00' },
          0
        ).entries!.map((e) => e.id)
      ).toEqual([100])
    } finally {
      process.env.TZ = restoreTz
    }
  })

  it('listEntries rejects impossible calendar dates instead of rolling them over (#228)', () => {
    // Date.parse turns 2026-02-30 into 2026-03-02 without complaint.
    expect(() => listEntries(sdb, HIDE, { from: '2026-02-30' }, 0)).toThrow(/from/)
    expect(() => listEntries(sdb, HIDE, { from: '2026-02-30T10:00:00Z' }, 0)).toThrow(/from/)
    expect(() => listEntries(sdb, HIDE, { to: '2026-02-29' }, 0)).toThrow(/to/)
    expect(() => listEntries(sdb, HIDE, { to: '2026-04-31T00:00:00+02:00' }, 0)).toThrow(/to/)
    // Leap day, and a valid local date whose UTC date is the day before: the
    // calendar check reads the date as written, not the converted instant.
    expect(() => listEntries(sdb, HIDE, { from: '2028-02-29' }, 0)).not.toThrow()
    expect(
      listEntries(
        sdb,
        HIDE,
        { from: '2026-06-10T01:00:00+02:00', to: '2026-06-10T12:00:00+02:00' },
        0
      ).entries!.map((e) => e.id)
    ).toEqual([100])
  })

  it('listEntries rejects a from/to that is not an ISO timestamp (#228)', () => {
    expect(() => listEntries(sdb, HIDE, { from: 'yesterday' }, 0)).toThrow(/from/)
    expect(() => listEntries(sdb, HIDE, { to: '2026-13-01' }, 0)).toThrow(/to/)
  })

  it('listClients filters by name and contact person (#205)', () => {
    // Substring, case-insensitive; archived clients need include_archived.
    expect(listClients(sdb, HIDE, { name: 'acm' }).map((c) => c.name)).toEqual(['Acme'])
    expect(
      listClients(sdb, HIDE, { name: 'zet', includeArchived: true }).map((c) => c.name)
    ).toEqual(['Zeta'])
    expect(listClients(sdb, HIDE, { contactPerson: 'alice' }).map((c) => c.name)).toEqual(['Acme'])
    expect(listClients(sdb, HIDE, { name: 'nix' })).toHaveLength(0)
  })

  it('listClients treats wildcard characters in filters as literals (#205)', () => {
    // No client name contains a literal '%' — a filter passed through to SQL
    // LIKE unescaped would match everything.
    expect(listClients(sdb, HIDE, { name: '%' })).toHaveLength(0)
    expect(listClients(sdb, HIDE, { name: '_' })).toHaveLength(0)
  })

  it('list filters match umlauts case-insensitively (#205)', () => {
    // SQLite's LIKE folds ASCII only — the filters must not inherit that.
    db.prepare(
      `INSERT INTO clients (id, name, color, active, rate_cent, vat_id, contact_person)
       VALUES (3, 'MÜLLER GmbH', '#555555', 1, 0, NULL, 'Jürgen Ößterreicher')`
    ).run()
    expect(listClients(sdb, HIDE, { name: 'müller' }).map((c) => c.name)).toEqual(['MÜLLER GmbH'])
    expect(listClients(sdb, HIDE, { contactPerson: 'ößt' }).map((c) => c.name)).toEqual([
      'MÜLLER GmbH'
    ])
  })

  it('listProjects filters by name and external project number (#205)', () => {
    expect(listProjects(sdb, HIDE, { name: 'web' }).map((p) => p.id)).toEqual([10])
    expect(listProjects(sdb, HIDE, { externalProjectNumber: 'ext-4' }).map((p) => p.id)).toEqual([
      10
    ])
    expect(listProjects(sdb, HIDE, { name: 'nix' })).toHaveLength(0)
  })

  it('getRunningTimer returns the open entry', () => {
    const entry = getRunningTimer(sdb, HIDE, Date.now())
    expect(entry?.id).toBe(103)
    expect(entry?.running).toBe(true)
  })

  it('getAnalytics sums completed entries and hides revenue by default', () => {
    const a = getAnalytics(sdb, HIDE, 2026, 6)
    // completed billable: 100 (3600). 101 non-billable (1800). 103 running excluded.
    expect(a.total_seconds).toBe(5400) // 3600 + 1800
    expect(a.billable_seconds).toBe(3600)
    expect(a.rounding_minutes).toBe(0)
    expect(a.revenue_cent).toBeUndefined()
    expect(a.by_client.every((c) => c.revenue_cent === undefined)).toBe(true)
  })

  it('getAnalytics carries client_id in by_project and counts distinct clients (#205)', () => {
    const a = getAnalytics(sdb, HIDE, 2026, 6)
    expect(a.distinct_client_count).toBe(1)
    // Sorted by seconds descending; the project row carries its client.
    expect(a.by_project).toEqual([
      { project_id: 10, client_id: 1, name: 'Website', seconds: 3600 },
      { project_id: null, client_id: null, name: '(kein Projekt)', seconds: 1800 }
    ])
    expect(a.by_client.map((c) => c.seconds)).toEqual([5400])
  })

  it('getAnalytics reports worked seconds like listEntries, the invoice figure as rounded_seconds', () => {
    // Owner decision 2026-10-22 (HANDOFF §2.2) supersedes #205: seconds are
    // worked time everywhere; the per-entry rounded figure has its own field.
    db.prepare(`UPDATE settings SET value = '15' WHERE key = 'pdf_round_minutes'`).run()
    // 10 completed minutes → rounded up to one 15-minute step.
    seedEntry(db, {
      id: 104,
      client_id: 1,
      project_id: 10,
      description: 'Kurz',
      started_at: '2026-06-14T09:00:00.000Z',
      stopped_at: '2026-06-14T09:10:00.000Z'
    })
    const a = getAnalytics(sdb, HIDE, 2026, 6)
    expect(a.rounding_minutes).toBe(15)
    // 60min + 30min + 10min, raw — the same as list_entries for the window.
    expect(a.total_seconds).toBe(6000)
    const raw = listEntries(sdb, HIDE, { year: 2026, month: 6, summaryOnly: true }, 0)
    // 3600 + 1800 + 600; the running entry contributes 0 at nowMs 0.
    expect(raw.total_seconds).toBe(6000)
    // per entry like the invoice: 60 + 30 + 15 (from 10) = 105min
    expect(a.rounded_seconds).toBe(6300)
  })

  it('getAnalytics exposes revenue when rates enabled', () => {
    const a = getAnalytics(sdb, SHOW, 2026, 6)
    // entry 100: 1h on project 10 (rate 15000ct/h) → 15000ct revenue.
    expect(a.revenue_cent).toBe(15000)
    const acme = a.by_client.find((c) => c.client_id === 1)!
    expect(acme.revenue_cent).toBe(15000)
  })

  it('getAnalytics keeps a client whose only time is a sub-second entry that bills a minute', () => {
    // Zeta (client 2) gets a rate and a 400 ms entry: no whole second, but the
    // invoice bills one minute, so the breakdown must not drop it.
    db.prepare(`UPDATE clients SET rate_cent = 6000 WHERE id = 2`).run()
    seedEntry(db, {
      id: 105,
      client_id: 2,
      description: 'Blitz',
      started_at: '2026-06-15T09:00:00.000Z',
      stopped_at: '2026-06-15T09:00:00.400Z'
    })
    const a = getAnalytics(sdb, SHOW, 2026, 6)
    const zeta = a.by_client.find((c) => c.client_id === 2)
    expect(zeta?.seconds).toBe(0)
    expect(zeta?.revenue_cent).toBe(100)
  })

  it('migration 018 seeds MCP flags to off; readStoredPrivacy reflects them', () => {
    expect(getSetting(sdb, 'mcp_expose_rates')).toBe('0')
    expect(getSetting(sdb, 'mcp_expose_private_notes')).toBe('0')
    expect(getSetting(sdb, 'mcp_write_enabled')).toBe('0')
    expect(readStoredPrivacy(sdb)).toEqual({ exposeRates: false, exposePrivateNotes: false })

    db.prepare(`UPDATE settings SET value = '1' WHERE key = 'mcp_expose_rates'`).run()
    expect(readStoredPrivacy(sdb)).toEqual({ exposeRates: true, exposePrivateNotes: false })
  })
})

describe('getEntryHistory (2.0 P3)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
  })

  it('returns every version of a trashed entry, oldest first, with source and written_at', () => {
    const id = seedEntry(db, {
      client_id: 1,
      description: 'Konzept',
      private_note: 'intern',
      source: 'mcp',
      started_at: '2026-06-02T08:00:00.000Z',
      stopped_at: '2026-06-02T09:00:00.000Z',
      deleted_at: '2026-06-03T10:00:00.000Z'
    })
    const h = getEntryHistory(db, HIDE, id)!
    expect(h.id).toBe(id)
    expect(h.versions.map((v) => [v.version, v.deleted])).toEqual([
      [1, false],
      [2, true]
    ])
    expect(h.versions[0].source).toBe('mcp')
    expect(h.versions[0].description).toBe('Konzept')
    expect(typeof h.versions[0].written_at).toBe('string')
    expect(h.versions[0].reason).toBeNull()
    expect(h.versions[0].private_note).toBeUndefined()
  })

  it('shows the private note only when the privacy gate is open', () => {
    const id = seedEntry(db, {
      client_id: 1,
      private_note: 'intern',
      started_at: '2026-06-02T08:00:00.000Z',
      stopped_at: '2026-06-02T09:00:00.000Z'
    })
    const open = { exposeRates: false, exposePrivateNotes: true }
    expect(getEntryHistory(db, open, id)!.versions[0].private_note).toBe('intern')
  })

  it('resolves a 1.x id through entry_legacy_id and returns null for an unknown id', () => {
    const id = seedEntry(db, {
      client_id: 1,
      started_at: '2026-06-02T08:00:00.000Z',
      stopped_at: '2026-06-02T09:00:00.000Z'
    })
    db.prepare(`INSERT INTO entry_legacy_id (legacy_id, entry_id) VALUES (?, ?)`).run(9001, id)
    expect(getEntryHistory(db, HIDE, 9001)!.id).toBe(id)
    expect(getEntryHistory(db, HIDE, 424242)).toBeNull()
  })
})

describe('resolvePrivacy (stored + env)', () => {
  it('exposes when the stored flag is on', () => {
    expect(resolvePrivacy({ exposeRates: true, exposePrivateNotes: false }, {})).toEqual({
      exposeRates: true,
      exposePrivateNotes: false
    })
  })

  it('env var can enable even when stored is off', () => {
    const env = { TIMETRACK_MCP_EXPOSE_PRIVATE_NOTES: '1' } as NodeJS.ProcessEnv
    expect(resolvePrivacy({ exposeRates: false, exposePrivateNotes: false }, env)).toEqual({
      exposeRates: false,
      exposePrivateNotes: true
    })
  })

  it('defaults to hidden when neither source enables', () => {
    expect(resolvePrivacy({}, {})).toEqual({ exposeRates: false, exposePrivateNotes: false })
  })
})
