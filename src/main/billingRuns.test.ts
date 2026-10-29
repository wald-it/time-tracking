import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import { listEntries } from '../mcp/queries'
import { entryShownSeconds, rowsBilledSeconds } from '../shared/entryMoney'
import type { Entry } from '../shared/types'
import { readEntry, updateManualEntry, writeEntry } from './entryMutations'
import {
  CLIENT_HAS_ENTRIES_ERROR,
  PROJECT_HAS_ENTRIES_ERROR,
  deleteClientGuarded,
  deleteProjectGuarded
} from './masterDataDelete'
import { buildPdfHtml, buildPdfPayload } from './pdf'
import { makeCtx } from '../test/bridgeKit'
import { handleRequest } from './mcpBridgeCore'
import { buildJsonExportPayload } from './jsonExport'
import {
  createRun,
  listRuns,
  openRunPdf,
  releaseRun,
  exportRunToFile,
  renderRunHtml,
  setInvoiceRef,
  verifyRunHtml
} from './billingRuns'

let Sqlite: DatabaseCtor
const databases: Database.Database[] = []
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
})
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const req = { clientId: 1, fromIso: '2026-10-01', toIso: '2026-10-31' }
const renderer = async (html: string): Promise<Buffer> => Buffer.from('PDF:' + html)
function setup(): Database.Database {
  const db = new Sqlite(':memory:')
  databases.push(db)
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  db.exec("INSERT INTO clients (id, name, rate_cent, short_code) VALUES (1, 'Client', 6000, 'ABC')")
  return db
}
function entry(db: Database.Database, id = 1): number {
  return seedEntry(db, {
    id,
    client_id: 1,
    started_at: '2026-10-27T0' + id + ':00:00.000Z',
    stopped_at: '2026-10-27T0' + id + ':04:00.000Z'
  })
}
const run = (db: Database.Database, request = req): ReturnType<typeof createRun> =>
  createRun(db, request, renderer, { logoDataUrl: 'data:image/png;base64,AAAA', appVersion: '2.0' })
const items = (db: Database.Database): unknown[] =>
  db.prepare('SELECT * FROM billing_run_item ORDER BY run_id, seq').all()
const patch = (
  db: Database.Database,
  fields: { description?: string; private_note?: string; started_at?: string; stopped_at?: string },
  reason?: string
): ReturnType<typeof writeEntry> =>
  writeEntry(
    db,
    { op: 'patch', id: 1, patch: fields },
    { source: 'app', reason, now: '2026-12-01T00:00:00.000Z' }
  )

describe('P6b billing run list', () => {
  it('reads client names and frozen item totals for active and released runs, newest first', async () => {
    const db = setup()
    expect(listRuns(db)).toEqual([])
    db.exec('INSERT INTO billing_profile (client_id, interval_min, min_unit_min) VALUES (1, 5, 0)')
    entry(db, 1)
    entry(db, 2)
    const first = await run(db)
    db.exec(
      "INSERT INTO clients (id, name, rate_cent, short_code) VALUES (2, 'Other client', 9000, 'DEF'); INSERT INTO billing_profile (client_id, interval_min, min_unit_min) VALUES (2, 0, 0)"
    )
    seedEntry(db, {
      id: 3,
      client_id: 2,
      started_at: '2026-10-27T10:00:00.000Z',
      stopped_at: '2026-10-27T10:07:00.000Z'
    })
    const other = await createRun(db, { ...req, clientId: 2 }, renderer)
    releaseRun(db, first.id, 'Correction')
    db.exec(
      "UPDATE billing_profile SET interval_min = 15 WHERE client_id = 1; UPDATE clients SET name = 'Renamed client', rate_cent = 12000 WHERE id = 1"
    )
    const replacement = await createRun(db, { ...req, replacesRunId: first.id }, renderer)
    const before = db.prepare('SELECT total_changes() AS n').get()
    const summaries = listRuns(db)
    expect(summaries.map((r) => r.id)).toEqual([replacement.id, other.id, first.id])
    expect(summaries[1]).toMatchObject({
      client_name: 'Other client',
      billed_minutes: 7,
      fee_cent: 1050,
      status: 'active'
    })
    expect(summaries[2]).toMatchObject({
      client_name: 'Renamed client',
      billed_minutes: 10,
      fee_cent: 1000,
      status: 'released',
      release_reason: 'Correction',
      released_at: expect.any(String)
    })
    expect(summaries[0].billed_minutes).toBe(30)
    expect(listRuns(db, 1).map((r) => r.id)).toEqual([replacement.id, first.id])
    expect(listRuns(db, 2).map((r) => r.id)).toEqual([other.id])
    expect(listRuns(db, 999)).toEqual([])
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
  })
})

describe('P5 billing run lifecycle (design 11.6)', () => {
  it('freezes rules, recipient, sender, logo, versions and both hashes with live controls', async () => {
    const db = setup()
    const today = (db.prepare("SELECT date('now', 'localtime') AS day").get() as { day: string })
      .day
    const invariantReq = { ...req, fromIso: today, toIso: today }
    const add = (id: number): number =>
      seedEntry(db, {
        id,
        client_id: 1,
        started_at: new Date(today + 'T' + (10 + id) + ':00:00').toISOString(),
        stopped_at: new Date(today + 'T' + (10 + id) + ':04:00').toISOString()
      })
    add(1)
    add(2)
    db.exec('INSERT INTO billing_profile (client_id, interval_min) VALUES (1, 5)')
    const created = await run(db, invariantReq)
    const before = items(db),
      archived = openRunPdf(db, created.id)
    add(3)
    const controlBefore = db
      .prepare('SELECT billed_minutes, rate_cent FROM billing_lines WHERE entry_id = 3')
      .get()
    db.exec(
      "UPDATE billing_profile SET interval_min = 15 WHERE client_id = 1; UPDATE clients SET rate_cent = 12000, billing_address_line1 = 'New address' WHERE id = 1; UPDATE settings SET value = 'New sender' WHERE key = 'company_name'"
    )
    expect(
      db.prepare('SELECT billed_minutes, rate_cent FROM billing_lines WHERE entry_id = 3').get()
    ).not.toEqual(controlBefore)
    expect(
      db.prepare('SELECT billed_minutes, rate_cent FROM billing_lines WHERE entry_id = 3').get()
    ).toEqual({ billed_minutes: 15, rate_cent: 12000 })
    expect(hash(buildPdfHtml(buildPdfPayload(db, invariantReq, '', created.created_at)))).not.toBe(
      created.html_sha256
    )
    expect(
      db
        .prepare('SELECT billed_minutes, rate_cent, fee_cent FROM billing_lines WHERE entry_id = 1')
        .get()
    ).toEqual({ billed_minutes: 5, rate_cent: 6000, fee_cent: 500 })
    expect(patch(db, { description: 'Corrected' }, 'Correction').ok).toBe(true)
    expect(
      db
        .prepare('SELECT billed_minutes, rate_cent, fee_cent FROM billing_lines WHERE entry_id = 1')
        .get()
    ).toEqual({ billed_minutes: 15, rate_cent: 12000, fee_cent: 3000 })
    expect(items(db)).toEqual(before)
    expect(hash(renderRunHtml(db, created.id))).toBe(created.html_sha256)
    expect(verifyRunHtml(db, created.id)).toBe(true)
    expect(hash(openRunPdf(db, created.id))).toBe(created.pdf_sha256)
    expect(openRunPdf(db, created.id)).toEqual(archived)
    expect(db.prepare('SELECT entry_id FROM billing_changes').all()).toEqual([{ entry_id: 1 }])
    expect(renderRunHtml(db, created.id)).toContain(created.number)
    expect(JSON.parse(created.rule_snapshot)).toMatchObject({
      snapshot_version: 1,
      appVersion: '2.0'
    })
  })

  it.each([undefined, '', '   '])(
    'requires a nonblank reason for patch/delete/undelete (%s)',
    async (reason) => {
      const db = setup()
      entry(db)
      const created = await run(db)
      expect(patch(db, { description: 'Changed' }, reason)).toMatchObject({
        ok: false,
        error: expect.stringContaining(created.number)
      })
      expect(writeEntry(db, { op: 'delete', id: 1 }, { source: 'app', reason }).ok).toBe(false)
      expect(writeEntry(db, { op: 'delete', id: 1 }, { source: 'app', reason: 'Mistake' }).ok).toBe(
        true
      )
      expect(writeEntry(db, { op: 'undelete', id: 1 }, { source: 'app', reason }).ok).toBe(false)
      expect(
        writeEntry(db, { op: 'undelete', id: 1 }, { source: 'app', reason: 'Restore' }).ok
      ).toBe(true)
    }
  )

  it('exempts only actual private note changes and no-ops', async () => {
    const db = setup()
    entry(db)
    await run(db)
    expect(readEntry(db, 1)?.billed).toBe(true)
    expect(patch(db, { private_note: 'Internal', description: '' }).ok).toBe(true)
    expect(patch(db, { private_note: 'Internal' }).ok).toBe(true)
    expect(readEntry(db, 1)?.version_no).toBe(2)
    expect(patch(db, { private_note: 'Next', description: 'External' }).ok).toBe(false)
  })

  it('releases as a unit, keeps the archive, re-bills with a new number', async () => {
    const db = setup()
    entry(db)
    const first = await run(db)
    await expect(createRun(db, { ...req, replacesRunId: first.id }, renderer)).rejects.toThrow(
      /gelöst/
    )
    expect(() => releaseRun(db, first.id, ' ')).toThrow(/Grund/)
    db.exec('INSERT INTO billing_profile (client_id, interval_min) VALUES (1, 30)')
    releaseRun(db, first.id, 'Correction')
    expect(readEntry(db, 1)?.billed).toBe(false)
    expect(db.prepare('SELECT billed_minutes, billed_run_id FROM billing_lines').get()).toEqual({
      billed_minutes: 30,
      billed_run_id: null
    })
    expect(db.prepare('SELECT active FROM billing_run_item').get()).toEqual({ active: 0 })
    expect(hash(openRunPdf(db, first.id))).toBe(first.pdf_sha256)
    const second = await createRun(db, { ...req, replacesRunId: first.id }, renderer)
    expect(first.number).toBe('SN-2026-10-ABC-01')
    expect(second.number).toBe('SN-2026-10-ABC-02')
    expect(second.replaces_run_id).toBe(first.id)
    expect(() => releaseRun(db, first.id, 'Again')).toThrow()
    expect(listRuns(db, 1)).toHaveLength(2)
  })

  it('excludes active segments with a count and enforces the partial unique index', async () => {
    const db = setup()
    entry(db)
    const first = await run(db)
    await expect(run(db)).rejects.toThrow(/keine.*Segmente/i)
    entry(db, 2)
    const second = await run(db)
    expect(second.excludedCount).toBe(1)
    expect(() =>
      db
        .prepare(
          'INSERT INTO billing_run_item SELECT ?, entry_id, version_id, seq, segment_date, billed_minutes, rate_cent, fee_cent, 1 FROM billing_run_item WHERE run_id = ?'
        )
        .run(second.id, first.id)
    ).toThrow(/UNIQUE/)
  })

  it('keeps invoice metadata editable without changing HTML, exports no bytes', async () => {
    const db = setup()
    entry(db)
    const created = await run(db)
    for (const released of [false, true]) {
      if (released) releaseRun(db, created.id, 'Reason')
      setInvoiceRef(db, created.id, 'INV-42')
      expect(hash(renderRunHtml(db, created.id))).toBe(created.html_sha256)
      expect(renderRunHtml(db, created.id)).not.toContain('INV-42')
    }
    const exported = buildJsonExportPayload(db, '2.0')
    expect(exported.billing_run).toHaveLength(1)
    expect(exported.billing_run_item).toHaveLength(1)
    expect(exported.billing_run_document[0]).toEqual({
      run_id: created.id,
      kind: 'pdf',
      byte_length: openRunPdf(db, created.id).length,
      sha256: created.pdf_sha256
    })
  })

  it('rejects missing/invalid/duplicate client codes and invalid ranges', async () => {
    const db = setup()
    entry(db)
    expect(() => db.exec("UPDATE clients SET short_code = 'lower'")).toThrow()
    expect(() =>
      db.exec("INSERT INTO clients (name, short_code) VALUES ('Other', 'ABC')")
    ).toThrow()
    db.exec('UPDATE clients SET short_code = NULL')
    await expect(run(db)).rejects.toThrow(/Kurzcode/)
    db.exec("UPDATE clients SET short_code = 'ABC'")
    await expect(run(db, { ...req, fromIso: '2026-10-32' })).rejects.toThrow()
    await expect(run(db, { ...req, fromIso: '2026-11-01' })).rejects.toThrow()
  })

  it('leaves no incomplete run on render failure or selection/number races', async () => {
    const db = setup()
    entry(db)
    await expect(
      createRun(db, req, async () => {
        throw new Error('Renderer failed')
      })
    ).rejects.toThrow('Renderer failed')
    expect(listRuns(db)).toHaveLength(0)
    await expect(
      createRun(db, req, async () => {
        expect(patch(db, { description: 'Concurrent edit' }).ok).toBe(true)
        return Buffer.from('pdf')
      })
    ).rejects.toThrow()
    expect(listRuns(db)).toHaveLength(0)
    await expect(
      createRun(db, req, async () => {
        await run(db)
        return Buffer.from('pdf')
      })
    ).rejects.toThrow()
    expect(listRuns(db)).toHaveLength(1)
  })

  it('seals database records against update/delete', async () => {
    const db = setup()
    entry(db)
    await run(db)
    for (const sql of [
      "UPDATE billing_run SET number = 'changed'",
      'DELETE FROM billing_run',
      'UPDATE billing_run_item SET fee_cent = 0',
      'DELETE FROM billing_run_item',
      "UPDATE billing_run_document SET sha256 = 'x'",
      'DELETE FROM billing_run_document'
    ])
      expect(() => db.exec(sql)).toThrow(/immutable/)
  })

  it('enforces one-way release in the database', async () => {
    const db = setup()
    entry(db)
    const first = await run(db)
    // Not yet released: no half-release, no item deactivation without the release.
    expect(() => db.exec("UPDATE billing_run SET released_at = 'x'")).toThrow(/CHECK/)
    expect(() => db.exec("UPDATE billing_run SET status = 'released'")).toThrow(/CHECK/)
    expect(() => db.exec('UPDATE billing_run_item SET active = 0')).toThrow(/follows the release/)
    releaseRun(db, first.id, 'Correction')
    for (const sql of [
      "UPDATE billing_run SET status = 'active', released_at = NULL, release_reason = NULL",
      "UPDATE billing_run SET status = 'active'",
      'UPDATE billing_run SET released_at = NULL',
      "UPDATE billing_run SET released_at = '2030-01-01T00:00:00.000Z'",
      'UPDATE billing_run SET release_reason = NULL',
      "UPDATE billing_run SET release_reason = 'other'",
      'UPDATE billing_run_item SET active = 1'
    ])
      expect(() => db.exec(sql), sql).toThrow(/one-way|CHECK/)
    // Inserts: a run starts active, items only join an active run and start active.
    expect(() =>
      db.exec(
        `INSERT INTO billing_run_item SELECT run_id, entry_id, version_id, seq, segment_date, billed_minutes, rate_cent, fee_cent, 1 FROM billing_run_item`
      )
    ).toThrow(/active run/)
    expect(() =>
      db.exec(
        `INSERT INTO billing_run (number, client_id, period_from, period_to, created_at, status, released_at, release_reason, rule_snapshot, html_sha256, pdf_sha256)
         VALUES ('X', 1, '2026-10-01', '2026-10-31', 'now', 'released', 'now', 'r', '{}', 'h', 'p')`
      )
    ).toThrow(/start active/)
    // Positive: invoice_ref stays editable, re-billing works, and the state is untouched.
    db.exec("UPDATE billing_run SET invoice_ref = 'RE-1'")
    const second = await createRun(db, { ...req, replacesRunId: first.id }, renderer)
    expect(second.status).toBe('active')
    expect(
      db
        .prepare(
          'SELECT status, active FROM billing_run r JOIN billing_run_item i ON i.run_id = r.id ORDER BY r.id'
        )
        .all()
    ).toEqual([
      { status: 'released', active: 0 },
      { status: 'active', active: 1 }
    ])
  })

  it('detects corrupt archived bytes before returning them', async () => {
    const db = setup()
    entry(db)
    const created = await run(db)
    db.exec(
      "DROP TRIGGER trg_billing_run_document_update; UPDATE billing_run_document SET bytes = X'00'"
    )
    expect(() => openRunPdf(db, created.id)).toThrow(/SHA-256/)
  })

  it('tracks deleted entries and days removed by a correction', async () => {
    const db = setup()
    seedEntry(db, {
      id: 1,
      client_id: 1,
      segments: [
        {
          segment_date: '2026-10-24',
          started_at: '2026-10-24T21:00:00Z',
          stopped_at: '2026-10-24T23:00:00Z'
        },
        {
          segment_date: '2026-10-25',
          started_at: '2026-10-24T23:00:00Z',
          stopped_at: '2026-10-25T01:00:00Z'
        }
      ]
    })
    await run(db)
    expect(patch(db, { stopped_at: '2026-10-24T22:00:00Z' }, 'Remove day').ok).toBe(true)
    expect(
      db.prepare('SELECT segment_date FROM billing_changes ORDER BY segment_date').all()
    ).toHaveLength(2)
    expect(writeEntry(db, { op: 'delete', id: 1 }, { source: 'app', reason: 'Delete' }).ok).toBe(
      true
    )
    expect(db.prepare('SELECT * FROM billing_changes').all()).toHaveLength(2)
  })
})

it('bills a midnight pair in one run and separates month-boundary halves', async () => {
  const db = setup()
  seedEntry(db, {
    id: 1,
    client_id: 1,
    segments: [
      {
        segment_date: '2026-10-24',
        started_at: '2026-10-24T21:00:00Z',
        stopped_at: '2026-10-24T22:00:00Z'
      },
      {
        segment_date: '2026-10-25',
        started_at: '2026-10-24T22:00:00Z',
        stopped_at: '2026-10-25T01:00:00Z'
      }
    ]
  })
  const october = await run(db)
  expect(items(db)).toHaveLength(2)
  expect(db.prepare('SELECT run_id FROM billing_run_item').all()).toEqual([
    { run_id: october.id },
    { run_id: october.id }
  ])
  releaseRun(db, october.id, 'Test')
  seedEntry(db, {
    id: 2,
    client_id: 1,
    segments: [
      {
        segment_date: '2026-10-31',
        started_at: '2026-10-31T22:00:00Z',
        stopped_at: '2026-10-31T23:00:00Z'
      },
      {
        segment_date: '2026-11-01',
        started_at: '2026-10-31T23:00:00Z',
        stopped_at: '2026-11-01T01:00:00Z'
      }
    ]
  })
  const oct = await run(db, { ...req, fromIso: '2026-10-31' })
  const nov = await run(db, { ...req, fromIso: '2026-11-01', toIso: '2026-11-30' })
  expect(
    db
      .prepare(
        'SELECT run_id, segment_date FROM billing_run_item WHERE entry_id = 2 ORDER BY segment_date'
      )
      .all()
  ).toEqual([
    { run_id: oct.id, segment_date: '2026-10-31' },
    { run_id: nov.id, segment_date: '2026-11-01' }
  ])
  expect(nov.number).toBe('SN-2026-11-ABC-01')
})

it('locks by day when a correction inserts a day before the billed one', async () => {
  const db = setup()
  seedEntry(db, {
    id: 1,
    client_id: 1,
    started_at: '2026-11-01T01:00:00.000Z',
    stopped_at: '2026-11-01T02:00:00.000Z'
  })
  const nov = await run(db, { ...req, fromIso: '2026-11-01', toIso: '2026-11-30' })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
  try {
    expect(patch(db, { started_at: '2026-10-31T22:00:00.000Z' }, 'Extend').ok).toBe(true)
    const oct = await run(db)
    expect(oct.excludedCount).toBe(0)
    expect(
      db
        .prepare(
          'SELECT segment_date, billed_run_id, billed_version_id, version_id FROM billing_lines ORDER BY segment_date'
        )
        .all()
    ).toEqual([
      expect.objectContaining({ segment_date: '2026-10-31', billed_run_id: oct.id }),
      expect.objectContaining({
        segment_date: '2026-11-01',
        billed_run_id: nov.id,
        billed_version_id: 1
      })
    ])
    expect(db.prepare('SELECT run_id FROM billing_changes').all()).toEqual([{ run_id: nov.id }])
    await expect(run(db, { ...req, fromIso: '2026-11-01', toIso: '2026-11-30' })).rejects.toThrow(
      /Keine/
    )
  } finally {
    vi.useRealTimers()
  }
})

it('freezes resolved project profiles, names, contacts, grouping and options', async () => {
  const db = setup()
  db.exec(
    "INSERT INTO projects (id, client_id, name, contact_person) VALUES (1, 1, 'Alpha', 'Person A'), (2, 1, 'Beta', 'Person B'); INSERT INTO billing_profile (client_id, interval_min, min_unit_min) VALUES (1, 5, 0); INSERT INTO billing_profile (project_id, interval_min, alignment) VALUES (1, 30, 'grid'), (2, 15, 'none')"
  )
  for (const project_id of [1, 2])
    seedEntry(db, {
      id: project_id,
      client_id: 1,
      project_id,
      started_at: '2026-10-20T09:01:00Z',
      stopped_at: '2026-10-20T09:05:00Z',
      tags: ',one,',
      reference: 'T-1'
    })
  for (const groupBy of ['project', 'tag', 'reference', 'none'] as const) {
    const created = await createRun(
      db,
      { ...req, groupBy, hideFeeColumn: true, includeSignatures: true },
      renderer
    )
    const snapshot = JSON.parse(created.rule_snapshot)
    expect(snapshot.projectProfiles['1']).toMatchObject({
      interval_min: 30,
      min_unit_min: 0,
      alignment: 'grid'
    })
    expect(snapshot.projectProfiles['2']).toMatchObject({ interval_min: 15, alignment: 'none' })
    const html = renderRunHtml(db, created.id)
    expect(hash(html)).toBe(created.html_sha256)
    expect(html).toContain('Alpha')
    expect(html).toContain('Beta')
    releaseRun(db, created.id, 'Next format')
  }
  const filtered = await createRun(db, { ...req, projectId: 1 }, renderer)
  expect(renderRunHtml(db, filtered.id)).toContain('Person A')
  db.exec(
    "UPDATE projects SET name = 'Renamed' || id, contact_person = 'New contact'; UPDATE billing_profile SET interval_min = 60 WHERE project_id IS NOT NULL"
  )
  expect(hash(renderRunHtml(db, filtered.id))).toBe(filtered.html_sha256)
  expect(
    db.prepare('SELECT COUNT(*) AS n FROM billing_run_item WHERE run_id = ?').get(filtered.id)
  ).toEqual({ n: 1 })
})

it('lists all active run numbers on MCP entries, including a removed billed day', async () => {
  const db = setup()
  entry(db)
  const created = await run(db)
  const privacy = { exposeRates: false, exposePrivateNotes: false }
  const listed = listEntries(db, privacy, {}, Date.now())
  expect('entries' in listed && listed.entries?.[0].billed).toEqual([created.number])
  releaseRun(db, created.id, 'Correction')
  const released = listEntries(db, privacy, {}, Date.now())
  expect('entries' in released && released.entries?.[0].billed).toBe(null)
})

it('rejects replacement for a different client and increments past 99 without filling holes', async () => {
  const db = setup()
  entry(db)
  const first = await run(db)
  releaseRun(db, first.id, 'Reason')
  db.exec("INSERT INTO clients (id, name, short_code) VALUES (2, 'Other', 'OTHER')")
  await expect(
    createRun(db, { ...req, clientId: 2, replacesRunId: first.id }, renderer)
  ).rejects.toThrow(/selben Kunden/)
  const archive = openRunPdf(db, first.id)
  for (let i = 2; i <= 100; i++) {
    const next = await run(db)
    expect(next.number).toBe('SN-2026-10-ABC-' + String(i).padStart(2, '0'))
    releaseRun(db, next.id, 'Next')
  }
  expect(openRunPdf(db, first.id)).toEqual(archive)
})

it('passes an existing reason contract through UpdateEntryInput and the actual MCP bridge', async () => {
  const db = setup()
  entry(db)
  await run(db)
  expect(
    updateManualEntry(db, { id: 1, description: 'App correction', reason: 'App reason' }).ok
  ).toBe(true)
  expect(readEntry(db, 1)?.reason).toBe('App reason')
  const { ctx } = makeCtx(db)
  const result = await handleRequest(ctx, {
    v: 1,
    token: 'secret',
    op: 'update_entry_fields',
    args: { id: 1, description: 'Bridge correction', reason: 'Bridge reason' }
  })
  expect(result.ok).toBe(true)
  expect(readEntry(db, 1)?.reason).toBe('Bridge reason')
  const refused = await handleRequest(ctx, {
    v: 1,
    token: 'secret',
    op: 'update_entry_fields',
    args: { id: 1, description: 'Without reason' }
  })
  expect(refused.ok).toBe(false)
})

it('names the billed run in the MCP preview and the confirmation before the owner answers', async () => {
  const db = setup()
  entry(db)
  const created = await run(db)
  const shown: string[] = []
  const { ctx } = makeCtx(db)
  const asking = {
    ...ctx,
    confirm: async (summary: string): Promise<boolean> => {
      shown.push(summary)
      return false
    }
  }
  const args = { id: 1, description: 'Correction' }
  const preview = await handleRequest(asking, {
    v: 1,
    token: 'secret',
    op: 'update_entry_fields',
    args,
    preview: true
  })
  expect(preview.ok && (preview.data as { billed?: unknown }).billed).toEqual({
    runs: [created.number]
  })
  await handleRequest(asking, { v: 1, token: 'secret', op: 'update_entry_fields', args })
  await handleRequest(asking, {
    v: 1,
    token: 'secret',
    op: 'update_entry_fields',
    args: { ...args, reason: 'Fixing' }
  })
  expect(shown[0]).toContain(created.number)
  expect(shown[0]).toMatch(/Ohne Grund/)
  expect(shown[1]).toContain(created.number)
  expect(shown[1]).toContain('Fixing')
})

it('keeps the origin of a billed rate after the project falls back to inheritance', async () => {
  const db = setup()
  db.exec("INSERT INTO projects (id, client_id, name, rate_cent) VALUES (1, 1, 'Goodwill', 0)")
  seedEntry(db, {
    id: 1,
    client_id: 1,
    project_id: 1,
    started_at: '2026-10-27T08:00:00.000Z',
    stopped_at: '2026-10-27T08:04:00.000Z'
  })
  const created = await run(db)
  const column = (): unknown =>
    db.prepare('SELECT rate_cent, rate_is_project FROM billing_lines WHERE entry_id = 1').get()
  expect(column()).toEqual({ rate_cent: 0, rate_is_project: 1 })
  const html = renderRunHtml(db, created.id),
    archive = openRunPdf(db, created.id)
  expect(html).toContain('0,00')
  // The project hands its rate back to the client from before the entry's
  // day. Not through `UPDATE projects`: its trigger dates the change to
  // today's date, which made this test pass only on the day it was written.
  db.exec("INSERT INTO rate (project_id, rate_cent, valid_from) VALUES (1, NULL, '2026-10-01')")
  expect(column()).toEqual({ rate_cent: 0, rate_is_project: 1 })
  expect(db.prepare('SELECT rate_is_project FROM entries WHERE id = 1').get()).toEqual({
    rate_is_project: 1
  })
  expect(renderRunHtml(db, created.id)).toBe(html)
  expect(verifyRunHtml(db, created.id)).toBe(true)
  expect(openRunPdf(db, created.id)).toEqual(archive)
  releaseRun(db, created.id, 'Released')
  expect(column()).toEqual({ rate_cent: 6000, rate_is_project: 0 })
})

describe('writing the export file after the run is committed', () => {
  it('names the run and keeps it archived when the file cannot be written', async () => {
    const db = setup()
    entry(db)
    const failure = (): never => {
      throw new Error('EACCES: disk full')
    }
    const error = await exportRunToFile(
      db,
      req,
      renderer,
      { appVersion: '2.0' },
      'X:/nope.pdf',
      failure
    ).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    const [stored] = listRuns(db)
    expect(stored).toBeDefined()
    const message = (error as Error).message
    expect(message).toContain(`ID ${stored.id}`)
    expect(message).toContain(stored.number)
    expect(message).toContain('angelegt und archiviert')
    expect(message).toContain('erneut öffnen')
    expect(message).toContain('EACCES')
    expect(readEntry(db, 1)?.billed).toBe(true)
    expect(hash(openRunPdf(db, stored.id))).toBe(stored.pdf_sha256)
  })

  it('writes the archived bytes and returns the run id on success', async () => {
    const db = setup()
    entry(db)
    let written: Buffer | undefined
    const result = await exportRunToFile(db, req, renderer, {}, 'x.pdf', (_p, bytes) => {
      written = bytes
    })
    expect(written).toEqual(openRunPdf(db, result.runId))
    expect(result.excludedCount).toBe(0)
  })
})

it('keeps the profile a run billed with (interval, minimum unit, alignment) after the profile changes', async () => {
  const db = setup()
  db.exec(
    "INSERT INTO billing_profile (client_id, interval_min, min_unit_min, alignment) VALUES (1, 15, 30, 'grid')"
  )
  entry(db)
  const created = await run(db)
  const view = (): unknown =>
    db
      .prepare(
        'SELECT billed_minutes, interval_min, min_unit_min, alignment FROM billing_lines WHERE entry_id = 1'
      )
      .get()
  const frozen = { billed_minutes: 30, interval_min: 15, min_unit_min: 30, alignment: 'grid' }
  expect(view()).toEqual(frozen)
  db.exec(
    "UPDATE billing_profile SET interval_min = 0, min_unit_min = 0, alignment = 'none' WHERE client_id = 1"
  )
  expect(view()).toEqual(frozen)
  const row = db.prepare('SELECT * FROM entries WHERE id = 1').get() as Entry
  expect(row).toMatchObject({ interval_min: 15, min_unit_min: 30, billed_minutes: 30 })
  const now = Date.parse('2026-12-01T00:00:00Z')
  expect(entryShownSeconds(row, now)).toBe(30 * 60)
  expect(rowsBilledSeconds([row], now)).toBe(30 * 60)
  expect(verifyRunHtml(db, created.id)).toBe(true)
  releaseRun(db, created.id, 'Released')
  expect(view()).toEqual({ billed_minutes: 4, interval_min: 0, min_unit_min: 0, alignment: 'none' })
})

it('keeps a project profile snapshot for a billed row while the project override changes', async () => {
  const db = setup()
  db.exec(
    "INSERT INTO projects (id, client_id, name) VALUES (1, 1, 'P'); INSERT INTO billing_profile (project_id, interval_min) VALUES (1, 15)"
  )
  seedEntry(db, {
    id: 1,
    client_id: 1,
    project_id: 1,
    started_at: '2026-10-27T08:00:00.000Z',
    stopped_at: '2026-10-27T08:04:00.000Z'
  })
  await run(db)
  db.exec('UPDATE billing_profile SET interval_min = 5 WHERE project_id = 1')
  expect(
    db.prepare('SELECT billed_minutes, interval_min FROM billing_lines WHERE entry_id = 1').get()
  ).toEqual({ billed_minutes: 15, interval_min: 15 })
})

it.each(['active', 'released'] as const)(
  'refuses to delete the client or project of a %s billing run',
  async (state) => {
    const db = setup()
    db.exec("INSERT INTO projects (id, client_id, name) VALUES (1, 1, 'P')")
    seedEntry(db, {
      id: 1,
      client_id: 1,
      project_id: 1,
      started_at: '2026-10-27T08:00:00.000Z',
      stopped_at: '2026-10-27T08:04:00.000Z'
    })
    const created = await run(db, { ...req, projectId: 1 } as typeof req)
    if (state === 'released') releaseRun(db, created.id, 'Released')
    const snapshot = (): unknown[] => [
      db.prepare('SELECT * FROM billing_run').all(),
      items(db),
      db.prepare('SELECT * FROM clients').all(),
      db.prepare('SELECT * FROM projects').all()
    ]
    const before = snapshot()
    expect(deleteProjectGuarded(db, 1)).toEqual({ ok: false, error: PROJECT_HAS_ENTRIES_ERROR })
    expect(deleteClientGuarded(db, 1)).toEqual({ ok: false, error: CLIENT_HAS_ENTRIES_ERROR })
    expect(snapshot()).toEqual(before)
  }
)
