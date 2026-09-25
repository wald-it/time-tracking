/**
 * Unit tests for the read-only MCP query layer.
 *
 * Same approach as ipc.test.ts: seed an in-memory DB with the real migrations
 * and exercise the query functions directly.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import {
  durationSeconds,
  monthWindow,
  listClients,
  listProjects,
  listEntries,
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
  const ins = db.prepare(
    `INSERT INTO entries
       (id, client_id, project_id, description, started_at, stopped_at, tags,
        reference, billable, private_note, deleted_at)
     VALUES (@id, @client_id, @project_id, @description, @started_at, @stopped_at,
        @tags, @reference, @billable, @private_note, @deleted_at)`
  )
  // 1h billable, project 10, tagged bug
  ins.run({
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
  ins.run({
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
  ins.run({
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
  ins.run({
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

describe('monthWindow', () => {
  it('builds a UTC month window with December rollover', () => {
    expect(monthWindow(2026, 12)).toEqual({
      start: '2026-12-01T00:00:00.000Z',
      end: '2027-01-01T00:00:00.000Z'
    })
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

  it('getAnalytics rounds per entry while listEntries stays raw (#205)', () => {
    db.prepare(`UPDATE settings SET value = '15' WHERE key = 'pdf_round_minutes'`).run()
    // 10 completed minutes → rounded up to one 15-minute step.
    db.prepare(
      `INSERT INTO entries (id, client_id, project_id, description, started_at, stopped_at,
                            tags, reference, billable, private_note)
       VALUES (104, 1, 10, 'Kurz', '2026-06-14T09:00:00.000Z', '2026-06-14T09:10:00.000Z',
               '', '', 1, '')`
    ).run()
    const a = getAnalytics(sdb, HIDE, 2026, 6)
    expect(a.rounding_minutes).toBe(15)
    // 60min + 30min + 15min(rounded from 10) = 105min
    expect(a.total_seconds).toBe(6300)
    // list_entries reports the unrounded wall-clock sum for the same window.
    const raw = listEntries(sdb, HIDE, { year: 2026, month: 6, summaryOnly: true }, 0)
    // 3600 + 1800 + 600; the running entry contributes 0 at nowMs 0.
    expect(raw.total_seconds).toBe(6000)
  })

  it('getAnalytics exposes revenue when rates enabled', () => {
    const a = getAnalytics(sdb, SHOW, 2026, 6)
    // entry 100: 1h on project 10 (rate 15000ct/h) → 15000ct revenue.
    expect(a.revenue_cent).toBe(15000)
    const acme = a.by_client.find((c) => c.client_id === 1)!
    expect(acme.revenue_cent).toBe(15000)
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
