/**
 * Tests for the PDF payload assembler + HTML template renderer.
 * No Electron, no I/O — operates on an in-memory SQLite + checks
 * the produced HTML string with structural assertions (we deliberately
 * avoid pixel snapshots; printToPDF rendering varies across Chromium
 * point releases).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { buildPdfPayload, buildPdfHtml } from './pdf'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

describe('buildPdfPayload', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-pdf-'))
    db = new DatabaseImpl(join(tmpDir, 'test.sqlite'))
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    db.prepare(
      `INSERT INTO clients (id, name, color, rate_cent) VALUES (1, 'Acme', '#6366f1', 8500)`
    ).run()
    db.prepare(
      `INSERT INTO clients (id, name, color, rate_cent) VALUES (2, 'Pro Bono', '#10b981', 0)`
    ).run()
  })

  afterEach(() => {
    if (!db) return
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('throws when client does not exist', () => {
    expect(() =>
      buildPdfPayload(db, { clientId: 999, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    ).toThrow(/Kunde/)
  })

  it('returns empty rows + zero totals when no entries match', () => {
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.rows).toEqual([])
    expect(p.totals.minutes).toBe(0)
    // Client has rate 8500 — totals.feeCent stays 0, not null, because
    // the "no fee column" decision is rate-based not entry-based.
    expect(p.totals.feeCent).toBe(0)
  })

  it('omits fee column for clients with rate_cent = 0', () => {
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at)
       VALUES (2, '2026-04-15T08:00:00.000Z', '2026-04-15T09:30:00.000Z')`
    ).run()
    const p = buildPdfPayload(db, { clientId: 2, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.totals.feeCent).toBeNull()
    expect(p.rows[0].feeCent).toBeNull()
  })

  it('aggregates minutes and fee for paid clients', () => {
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at)
       VALUES (1, 'work', '2026-04-15T08:00:00.000Z', '2026-04-15T09:30:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at)
       VALUES (1, 'more work', '2026-04-16T10:00:00.000Z', '2026-04-16T11:00:00.000Z')`
    ).run()
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.rows).toHaveLength(2)
    expect(p.totals.minutes).toBe(150) // 90 + 60
    // 150 min × 8500 cent/h ÷ 60 = 21250 cent
    expect(p.totals.feeCent).toBe(21250)
  })

  it('respects pdf_round_minutes setting', () => {
    db.prepare(`UPDATE settings SET value='15' WHERE key='pdf_round_minutes'`).run()
    db.prepare(
      // 23 minutes raw — should round to 30 with step=15
      `INSERT INTO entries (client_id, description, started_at, stopped_at)
       VALUES (1, 'short task', '2026-04-15T08:00:00.000Z', '2026-04-15T08:23:00.000Z')`
    ).run()
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.rows[0].minutes).toBe(30)
    expect(p.totals.minutes).toBe(30)
  })

  it('aligns displayed Von/Bis with the rounded duration (step=30)', () => {
    // The recipient must never see a row like "18:54 – 19:18 → 0:30" where
    // the visible times disagree with the duration column. Rule:
    //   displayedStart = round(rawStart) to nearest step
    //   displayedStop  = displayedStart + roundedMinutes
    db.prepare(`UPDATE settings SET value='30' WHERE key='pdf_round_minutes'`).run()
    // Local 18:54 → 19:18 (raw 24 min, rounds to 30 with step=30) → 19:00 – 19:30
    const a1 = new Date(2026, 3, 24, 18, 54, 0).toISOString()
    const a2 = new Date(2026, 3, 24, 19, 18, 0).toISOString()
    // Local 18:55 → 19:25 (raw 30 min, stays 30 with step=30) → 19:00 – 19:30
    const b1 = new Date(2026, 3, 25, 18, 55, 0).toISOString()
    const b2 = new Date(2026, 3, 25, 19, 25, 0).toISOString()
    db.prepare(`INSERT INTO entries (client_id, started_at, stopped_at) VALUES (1, ?, ?)`).run(
      a1,
      a2
    )
    db.prepare(`INSERT INTO entries (client_id, started_at, stopped_at) VALUES (1, ?, ?)`).run(
      b1,
      b2
    )
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.rows[0].startTime).toBe('19:00')
    expect(p.rows[0].stopTime).toBe('19:30')
    expect(p.rows[0].minutes).toBe(30)
    expect(p.rows[1].startTime).toBe('19:00')
    expect(p.rows[1].stopTime).toBe('19:30')
    expect(p.rows[1].minutes).toBe(30)
  })

  it('aligns displayed Von/Bis with rounding step=5', () => {
    db.prepare(`UPDATE settings SET value='5' WHERE key='pdf_round_minutes'`).run()
    // 18:54 → 19:18 (raw 24 min, rounds to 25 with step=5) → 18:55 – 19:20
    const a1 = new Date(2026, 3, 24, 18, 54, 0).toISOString()
    const a2 = new Date(2026, 3, 24, 19, 18, 0).toISOString()
    db.prepare(`INSERT INTO entries (client_id, started_at, stopped_at) VALUES (1, ?, ?)`).run(
      a1,
      a2
    )
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.rows[0].startTime).toBe('18:55')
    expect(p.rows[0].stopTime).toBe('19:20')
    expect(p.rows[0].minutes).toBe(25)
  })

  it('keeps raw Von/Bis when rounding is disabled', () => {
    // pdf_round_minutes default is '0'
    const a1 = new Date(2026, 3, 24, 18, 54, 0).toISOString()
    const a2 = new Date(2026, 3, 24, 19, 18, 0).toISOString()
    db.prepare(`INSERT INTO entries (client_id, started_at, stopped_at) VALUES (1, ?, ?)`).run(
      a1,
      a2
    )
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.rows[0].startTime).toBe('18:54')
    expect(p.rows[0].stopTime).toBe('19:18')
    expect(p.rows[0].minutes).toBe(24)
  })

  it('excludes soft-deleted entries', () => {
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at, deleted_at)
       VALUES (1, '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z', '2026-04-15T10:00:00.000Z')`
    ).run()
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.rows).toHaveLength(0)
  })

  it('excludes running entries (stopped_at IS NULL)', () => {
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at)
       VALUES (1, '2026-04-15T08:00:00.000Z', NULL)`
    ).run()
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.rows).toHaveLength(0)
  })

  it('range is inclusive — captures entries on the last LOCAL day, not the day after', () => {
    // 22:00–23:00 local on 30 Apr is in; 00:30 local on 1 May is not. (The
    // old fixture used 22:00Z, which is already 1 May in Berlin.)
    const insert = db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at) VALUES (1, ?, ?)`
    )
    insert.run(
      new Date(2026, 3, 30, 22, 0).toISOString(),
      new Date(2026, 3, 30, 23, 0).toISOString()
    )
    insert.run(new Date(2026, 4, 1, 0, 30).toISOString(), new Date(2026, 4, 1, 1, 0).toISOString())
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.rows).toHaveLength(1)
  })

  it('includes cross-midnight halves as separate rows (link_id preserved by data layer)', () => {
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at, link_id)
       VALUES (1, '2026-04-24T22:00:00.000Z', '2026-04-25T00:00:00.000Z', 'aaa')`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at, link_id)
       VALUES (1, '2026-04-25T00:00:00.000Z', '2026-04-25T01:30:00.000Z', 'aaa')`
    ).run()
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-24', toIso: '2026-04-25' }, '')
    expect(p.rows).toHaveLength(2)
  })

  it('uses settings for sender block + accent color', () => {
    db.prepare(`UPDATE settings SET value='Robin GmbH' WHERE key='company_name'`).run()
    db.prepare(
      `UPDATE settings SET value='Musterstr. 1\n12345 Berlin' WHERE key='pdf_sender_address'`
    ).run()
    db.prepare(`UPDATE settings SET value='DE12345' WHERE key='pdf_tax_id'`).run()
    db.prepare(`UPDATE settings SET value='#ff0000' WHERE key='pdf_accent_color'`).run()
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.sender.name).toBe('Robin GmbH')
    expect(p.sender.address).toContain('Musterstr')
    expect(p.sender.taxId).toBe('DE12345')
    expect(p.accentColor).toBe('#ff0000')
  })

  // v1.12 #105 — project contact person overrides client contact person
  it('uses project.contact_person when set (overrides client)', () => {
    db.prepare(
      `INSERT INTO projects (id, client_id, name, color, status, contact_person)
       VALUES (10, 1, 'Alpha', '#6366f1', 'active', 'Projekt-AP')`
    ).run()
    db.prepare(`UPDATE clients SET contact_person = 'Kunden-AP' WHERE id = 1`).run()
    const p = buildPdfPayload(
      db,
      { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30', projectId: 10 },
      ''
    )
    expect(p.effectiveContactPerson).toBe('Projekt-AP')
  })

  it('falls back to client.contact_person when project has none', () => {
    db.prepare(
      `INSERT INTO projects (id, client_id, name, color, status) VALUES (11, 1, 'Beta', '#6366f1', 'active')`
    ).run()
    db.prepare(`UPDATE clients SET contact_person = 'Kunden-AP' WHERE id = 1`).run()
    const p = buildPdfPayload(
      db,
      { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30', projectId: 11 },
      ''
    )
    expect(p.effectiveContactPerson).toBe('Kunden-AP')
  })

  it('uses client.contact_person when no project filter is set', () => {
    db.prepare(`UPDATE clients SET contact_person = 'Kunden-AP' WHERE id = 1`).run()
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.effectiveContactPerson).toBe('Kunden-AP')
  })

  // ── v1.13 #120: billable filter + project rate override ─────────────────

  it('excludes non-billable entries (billable = 0)', () => {
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, billable)
       VALUES (1, 'billable', '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z', 1)`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, billable)
       VALUES (1, 'non-billable', '2026-04-16T08:00:00.000Z', '2026-04-16T09:00:00.000Z', 0)`
    ).run()
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.rows).toHaveLength(1)
    expect(p.rows[0].description).toBe('billable')
    expect(p.totals.minutes).toBe(60)
    expect(p.totals.feeCent).toBe(8500)
  })

  it('uses project rate_cent when set (overrides client rate)', () => {
    db.prepare(
      `INSERT INTO projects (id, client_id, name, color, status, rate_cent)
       VALUES (20, 1, 'BigDeal', '#6366f1', 'active', 12000)`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, project_id, description, started_at, stopped_at)
       VALUES (1, 20, 'project work', '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z')`
    ).run()
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    // 60 min × 12000 cent/h ÷ 60 = 12000 cent — client rate (8500) is ignored
    expect(p.rows[0].feeCent).toBe(12000)
    expect(p.totals.feeCent).toBe(12000)
  })

  it('falls back to client rate when project has no rate', () => {
    db.prepare(
      `INSERT INTO projects (id, client_id, name, color, status, rate_cent)
       VALUES (21, 1, 'NoRate', '#6366f1', 'active', NULL)`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, project_id, description, started_at, stopped_at)
       VALUES (1, 21, 'fallback', '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z')`
    ).run()
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.rows[0].feeCent).toBe(8500)
  })

  it('mixes project- and client-rate rows in the same export', () => {
    db.prepare(
      `INSERT INTO projects (id, client_id, name, color, status, rate_cent)
       VALUES (22, 1, 'Premium', '#6366f1', 'active', 12000)`
    ).run()
    // Row A: uses project rate
    db.prepare(
      `INSERT INTO entries (client_id, project_id, started_at, stopped_at)
       VALUES (1, 22, '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z')`
    ).run()
    // Row B: no project → client rate
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at)
       VALUES (1, '2026-04-16T08:00:00.000Z', '2026-04-16T09:00:00.000Z')`
    ).run()
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.rows).toHaveLength(2)
    expect(p.rows[0].feeCent).toBe(12000)
    expect(p.rows[1].feeCent).toBe(8500)
    expect(p.totals.feeCent).toBe(20500)
  })

  it('shows fee column for free clients when a project rate yields fees', () => {
    // Client 2 has rate_cent = 0 (Pro Bono). Add a project with a real rate.
    db.prepare(
      `INSERT INTO projects (id, client_id, name, color, status, rate_cent)
       VALUES (23, 2, 'PaidGig', '#10b981', 'active', 9000)`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, project_id, started_at, stopped_at)
       VALUES (2, 23, '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z')`
    ).run()
    const p = buildPdfPayload(db, { clientId: 2, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.rows[0].feeCent).toBe(9000)
    expect(p.totals.feeCent).toBe(9000)
  })

  it('bills a goodwill project (rate 0) at 0 €, not the client rate', () => {
    db.prepare(
      `INSERT INTO projects (id, client_id, name, color, status, rate_cent)
       VALUES (24, 1, 'Kulanz', '#10b981', 'active', 0)`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, project_id, started_at, stopped_at)
       VALUES (1, 24, '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z')`
    ).run()
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.rows[0].feeCent).toBe(0)
    expect(p.totals.feeCent).toBe(0)
  })

  it('keeps the fee column for goodwill work of a client without a rate', () => {
    // Client 2 has rate_cent = 0; a goodwill project still shows "0,00 €".
    db.prepare(
      `INSERT INTO projects (id, client_id, name, color, status, rate_cent)
       VALUES (25, 2, 'Kulanz', '#10b981', 'active', 0)`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, project_id, started_at, stopped_at)
       VALUES (2, 25, '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z')`
    ).run()
    const p = buildPdfPayload(db, { clientId: 2, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.rows[0].feeCent).toBe(0)
    expect(p.totals.feeCent).toBe(0)
  })

  // ── v1.13 #118: grouping dropdown ────────────────────────────────────────

  it('legacy groupByTag still coerces to groupBy=tag', () => {
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at, tags)
       VALUES (1, '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z', ',bug,')`
    ).run()
    const p = buildPdfPayload(
      db,
      { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30', groupByTag: true },
      ''
    )
    expect(p.groups).not.toBeNull()
    expect(p.groups![0].label).toBe('#bug')
  })

  it('groupBy=project groups rows by project name, "Ohne Projekt" last', () => {
    db.prepare(
      `INSERT INTO projects (id, client_id, name, color, status, rate_cent)
       VALUES (30, 1, 'Alpha', '#6366f1', 'active', 0)`
    ).run()
    db.prepare(
      `INSERT INTO projects (id, client_id, name, color, status, rate_cent)
       VALUES (31, 1, 'Bravo', '#6366f1', 'active', 0)`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, project_id, started_at, stopped_at)
       VALUES (1, 30, '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, project_id, started_at, stopped_at)
       VALUES (1, 31, '2026-04-16T08:00:00.000Z', '2026-04-16T09:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at)
       VALUES (1, '2026-04-17T08:00:00.000Z', '2026-04-17T09:00:00.000Z')`
    ).run()
    const p = buildPdfPayload(
      db,
      { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30', groupBy: 'project' },
      ''
    )
    expect(p.groups).not.toBeNull()
    expect(p.groups!.map((g) => g.label)).toEqual([
      'Projekt: Alpha',
      'Projekt: Bravo',
      'Ohne Projekt'
    ])
    expect(p.groups![0].totalMinutes).toBe(60)
  })

  it('groupBy=reference groups rows by entry reference, "Sonstiges" last', () => {
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at, reference)
       VALUES (1, '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z', 'JIRA-1')`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at, reference)
       VALUES (1, '2026-04-16T08:00:00.000Z', '2026-04-16T09:00:00.000Z', 'JIRA-2')`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at, reference)
       VALUES (1, '2026-04-17T08:00:00.000Z', '2026-04-17T09:00:00.000Z', '')`
    ).run()
    const p = buildPdfPayload(
      db,
      { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30', groupBy: 'reference' },
      ''
    )
    expect(p.groups).not.toBeNull()
    expect(p.groups!.map((g) => g.label)).toEqual(['JIRA-1', 'JIRA-2', 'Sonstiges'])
  })

  it('groupBy=none keeps groups null even with tagged rows', () => {
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at, tags)
       VALUES (1, '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z', ',bug,')`
    ).run()
    const p = buildPdfPayload(
      db,
      { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30', groupBy: 'none' },
      ''
    )
    expect(p.groups).toBeNull()
  })

  // ── v1.13 #118: hideFeeColumn ────────────────────────────────────────────

  it('hideFeeColumn=true propagates to payload', () => {
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at)
       VALUES (1, '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z')`
    ).run()
    const p = buildPdfPayload(
      db,
      { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30', hideFeeColumn: true },
      ''
    )
    expect(p.hideFeeColumn).toBe(true)
    // Row-level feeCent is still computed — the renderer is responsible for hiding.
    expect(p.rows[0].feeCent).toBe(8500)
  })

  // ── v1.13 #118: per-row project name ─────────────────────────────────────

  it('populates row.projectName when export spans multiple projects', () => {
    db.prepare(
      `INSERT INTO projects (id, client_id, name, color, status, rate_cent)
       VALUES (40, 1, 'Alpha', '#6366f1', 'active', 0)`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, project_id, started_at, stopped_at)
       VALUES (1, 40, '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at)
       VALUES (1, '2026-04-16T08:00:00.000Z', '2026-04-16T09:00:00.000Z')`
    ).run()
    const p = buildPdfPayload(db, { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30' }, '')
    expect(p.rows[0].projectName).toBe('Alpha')
    expect(p.rows[1].projectName).toBeUndefined()
  })

  it('omits row.projectName when filtering by projectId', () => {
    db.prepare(
      `INSERT INTO projects (id, client_id, name, color, status, rate_cent)
       VALUES (41, 1, 'Alpha', '#6366f1', 'active', 0)`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, project_id, started_at, stopped_at)
       VALUES (1, 41, '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z')`
    ).run()
    const p = buildPdfPayload(
      db,
      { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30', projectId: 41 },
      ''
    )
    expect(p.rows[0].projectName).toBeUndefined()
  })

  it('omits row.projectName when grouping by project (header would duplicate)', () => {
    db.prepare(
      `INSERT INTO projects (id, client_id, name, color, status, rate_cent)
       VALUES (42, 1, 'Alpha', '#6366f1', 'active', 0)`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, project_id, started_at, stopped_at)
       VALUES (1, 42, '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z')`
    ).run()
    const p = buildPdfPayload(
      db,
      { clientId: 1, fromIso: '2026-04-01', toIso: '2026-04-30', groupBy: 'project' },
      ''
    )
    expect(p.rows[0].projectName).toBeUndefined()
  })
})

describe('buildPdfHtml', () => {
  function makePayload(
    overrides: Partial<Parameters<typeof buildPdfHtml>[0]> = {}
  ): Parameters<typeof buildPdfHtml>[0] {
    return {
      client: { id: 1, name: 'Acme', rate_cent: 8500 },
      sender: { name: 'Robin GmbH', address: 'Musterstr. 1\n12345 Berlin', taxId: 'DE12345' },
      fromIso: '2026-04-01',
      toIso: '2026-04-30',
      rows: [
        {
          date: '15.04.2026',
          startTime: '08:00',
          stopTime: '09:30',
          description: 'Work',
          minutes: 90,
          feeCent: 12750
        }
      ],
      totals: { minutes: 90, feeCent: 12750 },
      accentColor: '#4f46e5',
      footerText: 'Bitte überweisen Sie bis zum 15.05.',
      logoDataUrl: '',
      roundMinutes: 0,
      generatedAtIso: '2026-04-24T12:00:00.000Z',
      groups: null,
      ...overrides
    }
  }

  it('produces a self-contained HTML document', () => {
    const html = buildPdfHtml(makePayload())
    expect(html).toMatch(/^<!doctype html>/)
    expect(html).toContain('<title>Stundennachweis</title>')
    expect(html).toContain('Acme')
    expect(html).toContain('15.04.2026')
    expect(html).toContain('127,50 €') // formatted fee
  })

  it('includes a Content-Security-Policy meta tag (locks down to inline CSS + data: images)', () => {
    const html = buildPdfHtml(makePayload())
    expect(html).toMatch(/Content-Security-Policy.*default-src 'none'/)
  })

  it('escapes user-controlled strings (XSS hardening)', () => {
    const html = buildPdfHtml(
      makePayload({
        client: { id: 1, name: '<script>alert(1)</script>', rate_cent: 8500 },
        sender: { name: '"><img>', address: '', taxId: '' }
      })
    )
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&quot;&gt;&lt;img&gt;')
  })

  it('falls back to indigo accent on malformed color input', () => {
    const html = buildPdfHtml(makePayload({ accentColor: 'javascript:alert(1)' }))
    expect(html).toContain('#4f46e5')
    expect(html).not.toContain('javascript:')
  })

  it('omits the fee column when totals.feeCent is null', () => {
    const html = buildPdfHtml(
      makePayload({
        client: { id: 1, name: 'Pro Bono', rate_cent: 0 },
        rows: [
          {
            date: '15.04.2026',
            startTime: '08:00',
            stopTime: '09:00',
            description: 'Help',
            minutes: 60,
            feeCent: null
          }
        ],
        totals: { minutes: 60, feeCent: null }
      })
    )
    expect(html).not.toContain('Honorar')
    expect(html).not.toContain('€')
  })

  it('shows an empty-state row when there are no entries', () => {
    const html = buildPdfHtml(makePayload({ rows: [], totals: { minutes: 0, feeCent: 0 } }))
    expect(html).toContain('Keine Einträge im gewählten Zeitraum.')
  })

  it('embeds logo as a data URL when provided', () => {
    const html = buildPdfHtml(makePayload({ logoDataUrl: 'data:image/png;base64,iVBORw0K' }))
    expect(html).toContain('data:image/png;base64,iVBORw0K')
    expect(html).toContain('class="logo"')
  })

  it('never reveals the rounding to the recipient (no visible hint)', () => {
    // The displayed Von/Bis times are aligned with the rounded duration
    // in the payload builder; the recipient should see internally
    // consistent rows but no "rounded to X minutes" disclosure.
    expect(buildPdfHtml(makePayload({ roundMinutes: 0 }))).not.toMatch(/gerundet|rounded/i)
    expect(buildPdfHtml(makePayload({ roundMinutes: 15 }))).not.toMatch(/gerundet|rounded/i)
    expect(buildPdfHtml(makePayload({ roundMinutes: 30 }))).not.toMatch(/gerundet|rounded/i)
  })

  it('renders entry-ref div when reference is non-empty', () => {
    const html = buildPdfHtml(
      makePayload({
        rows: [
          {
            date: '15.04.2026',
            startTime: '08:00',
            stopTime: '09:30',
            description: 'Work',
            minutes: 90,
            feeCent: 12750,
            reference: 'JIRA-123'
          }
        ]
      })
    )
    expect(html).toContain('class="entry-ref"')
    expect(html).toContain('JIRA-123')
  })

  it('omits entry-ref div when reference is empty or absent', () => {
    const htmlEmpty = buildPdfHtml(
      makePayload({
        rows: [
          {
            date: '15.04.2026',
            startTime: '08:00',
            stopTime: '09:30',
            description: 'Work',
            minutes: 90,
            feeCent: 12750,
            reference: ''
          }
        ]
      })
    )
    expect(htmlEmpty).not.toContain('class="entry-ref"')

    const htmlAbsent = buildPdfHtml(makePayload())
    expect(htmlAbsent).not.toContain('class="entry-ref"')
  })

  // v1.12 #105 — effectiveContactPerson in recipient block
  it('renders z.Hd. line when effectiveContactPerson is set', () => {
    const html = buildPdfHtml(makePayload({ effectiveContactPerson: 'Max Mustermann' }))
    expect(html).toContain('z.Hd. Max Mustermann')
  })

  it('omits z.Hd. line when effectiveContactPerson is absent', () => {
    const html = buildPdfHtml(makePayload())
    expect(html).not.toContain('z.Hd.')
  })

  it('omits z.Hd. line when effectiveContactPerson is null', () => {
    const html = buildPdfHtml(makePayload({ effectiveContactPerson: null }))
    expect(html).not.toContain('z.Hd.')
  })

  // ── v1.13 #118 ─────────────────────────────────────────────────────────────

  it('hideFeeColumn=true removes Honorar header, fee cells, and euro symbol', () => {
    const html = buildPdfHtml(makePayload({ hideFeeColumn: true }))
    expect(html).not.toContain('Honorar')
    expect(html).not.toContain('€')
  })

  it('renders entry-project div when row.projectName is set', () => {
    const html = buildPdfHtml(
      makePayload({
        rows: [
          {
            date: '15.04.2026',
            startTime: '08:00',
            stopTime: '09:30',
            description: 'Work',
            minutes: 90,
            feeCent: 12750,
            projectName: 'Alpha'
          }
        ]
      })
    )
    expect(html).toContain('class="entry-project"')
    expect(html).toContain('Projekt: Alpha')
  })

  it('escapes projectName for XSS', () => {
    const html = buildPdfHtml(
      makePayload({
        rows: [
          {
            date: '15.04.2026',
            startTime: '08:00',
            stopTime: '09:30',
            description: 'Work',
            minutes: 90,
            feeCent: 12750,
            projectName: '<script>x</script>'
          }
        ]
      })
    )
    expect(html).not.toContain('<script>x')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
  })

  it('renders group label verbatim (no #-prefix for non-tag groups)', () => {
    const html = buildPdfHtml(
      makePayload({
        groups: [
          {
            label: 'Projekt: Alpha',
            rows: [
              {
                date: '15.04.2026',
                startTime: '08:00',
                stopTime: '09:00',
                description: 'W',
                minutes: 60,
                feeCent: 8500
              }
            ],
            totalMinutes: 60,
            totalFeeCent: 8500
          }
        ]
      })
    )
    expect(html).toContain('Projekt: Alpha')
    expect(html).toContain('Zwischensumme Projekt: Alpha')
  })
})
