import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import type { PdfRequest } from './pdf'

let db: Database.Database
let pdf: typeof import('./pdf')
let runs: typeof import('./billingRuns')
const previousTz = process.env.TZ
const req: PdfRequest = { clientId: 1, fromIso: '2026-10-01', toIso: '2026-10-31' }
const render = async (html: string): Promise<Buffer> => Buffer.from(html)

beforeAll(async () => {
  process.env.TZ = 'UTC'
  vi.resetModules()
  pdf = await import('./pdf')
  runs = await import('./billingRuns')
})
beforeEach(async () => {
  const Sqlite = await loadSqlite()
  db = new Sqlite(':memory:')
  applyMigrations(db)
  db.exec(`INSERT INTO clients (id, name, rate_cent, short_code) VALUES (1, 'Client', 6000, 'ABC');
    INSERT INTO projects (id, client_id, name) VALUES (1, 1, 'Project')`)
  seedEntry(db, {
    id: 1,
    client_id: 1,
    project_id: 1,
    description: 'Work',
    reference: 'REF',
    started_at: '2026-10-20T09:00:00.000Z',
    stopped_at: '2026-10-20T10:00:00.000Z'
  })
})
afterEach(() => {
  db.close()
  vi.useRealTimers()
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
  vi.resetModules()
})

function profile(language: 'de' | 'en', fee: 'auto' | 'on' | 'off' = 'auto'): void {
  db.prepare('INSERT INTO billing_profile (client_id, language, fee_column) VALUES (1, ?, ?)').run(
    language,
    fee
  )
}
const html = (request: PdfRequest = req): string =>
  pdf.buildPdfHtml(pdf.buildPdfPayload(db, request, '', '2026-10-30T12:00:00.000Z'))

it('keeps German auto HTML byte-identical to the pre-423 renderer', () => {
  profile('de')
  const actual = html({ ...req, groupBy: 'reference', includeSignatures: true })
  expect(Buffer.from(actual)).toEqual(readFileSync('src/main/__fixtures__/pdf-language-de.html'))
})

it('translates every English PDF label and formats dates, times, amounts and durations', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'))
  profile('en')
  db.exec(`UPDATE clients SET rate_cent = 123456, vat_id = 'VAT', contact_person = 'Pat' WHERE id = 1;
    UPDATE rate SET rate_cent = 123456 WHERE client_id = 1;
    UPDATE settings SET value = 'TAX' WHERE key = 'pdf_tax_id'`)
  const request = { ...req, includeSignatures: true, invoiceRef: 'INV-1' }
  const run = await runs.createRun(db, request, render)
  const rendered = runs.renderRunHtml(db, run.id)
  for (const label of [
    '<html lang="en">',
    '<title>Timesheet</title>',
    `Timesheet No. ${run.number} · for invoice no. INV-1`,
    '>Client<',
    '>Period<',
    '>Date</th>',
    '>From</th>',
    '>To</th>',
    '>Activity</th>',
    '>Duration</th>',
    '>Fee</th>',
    'Project: Project',
    'Tax no.: TAX',
    'VAT ID VAT',
    'Attn. Pat',
    'Date, Contractor',
    'Date, Client',
    'Created on 30/10/2026',
    ' with TimeTrack.',
    '20/10/2026',
    '>09:00<',
    '>10:00<',
    '€1,234.56',
    '>1:00<',
    '>Total<'
  ])
    expect(rendered).toContain(label)
  expect(html({ ...req, projectId: 1 })).toContain(
    '<div class="project-label">Project: Project</div>'
  )
  expect(html({ ...req, fromIso: '2025-01-01', toIso: '2025-01-31' })).toContain(
    'No entries in the selected period.'
  )
})

it.each(['tag', 'project', 'reference'] as const)(
  'translates English %s groups and totals',
  (groupBy) => {
    profile('en')
    seedEntry(db, {
      id: 2,
      client_id: 1,
      project_id: null,
      description: 'Other',
      tags: ',tag,',
      started_at: '2026-10-21T09:00:00.000Z',
      stopped_at: '2026-10-21T10:00:00.000Z'
    })
    const result = html({ ...req, groupBy })
    expect(result).toContain(
      `class="col-group">${{ tag: 'No tag', project: 'No project', reference: 'Other' }[groupBy]}</td>`
    )
    expect(result).toContain('Subtotal ')
    expect(result).toContain('Grand total')
    if (groupBy === 'project') expect(result).toContain('Project: Project')
  }
)

for (const rate of [0, 6000])
  for (const hide of [false, true]) {
    it.each(['auto', 'on', 'off'] as const)(
      `applies fee %s with rate ${rate} and hide ${hide} in live and frozen runs`,
      async (fee) => {
        profile('de', fee)
        db.prepare('UPDATE clients SET rate_cent = ? WHERE id = 1').run(rate)
        db.prepare('UPDATE rate SET rate_cent = ? WHERE client_id = 1').run(rate)
        const request = { ...req, hideFeeColumn: hide, groupBy: 'reference' as const }
        const shown = fee === 'on' || (fee === 'auto' && rate > 0 && !hide)
        const run = await runs.createRun(db, request, render)
        expect(JSON.parse(run.rule_snapshot).options.fee_column).toBe(fee)
        for (const result of [html(request), runs.renderRunHtml(db, run.id)]) {
          expect(result.includes('>Honorar</th>')).toBe(shown)
          expect(result.includes('<td class="col-fee">')).toBe(shown)
          if (shown && rate === 0) expect(result).toContain('0,00 €')
        }
        db.exec(`UPDATE billing_profile SET fee_column = 'off'`)
        expect(runs.verifyRunHtml(db, run.id)).toBe(true)
      }
    )
  }

it.each([
  ['en', 'de', undefined, 'en'],
  ['de', 'en', 1, 'en'],
  ['en', 'de', 1, 'de'],
  ['en', null, 1, 'en']
] as const)(
  'resolves client %s / project %s / filter %s to %s and freezes it',
  async (client, project, projectId, expected) => {
    profile(client)
    if (project)
      db.prepare(
        'INSERT INTO billing_profile (project_id, language, fee_column) VALUES (1, ?, ?)'
      ).run(project, 'on')
    const request = { ...req, projectId, hideFeeColumn: true }
    expect(html(request)).toContain(`<html lang="${expected}">`)
    const run = await runs.createRun(db, request, render)
    const snapshot = JSON.parse(run.rule_snapshot)
    expect(snapshot.options.language).toBe(expected)
    expect(snapshot.options.fee_column).toBe(projectId && project ? 'on' : 'auto')
    const original = runs.renderRunHtml(db, run.id)
    db.exec(`UPDATE billing_profile SET language = 'de', fee_column = 'off'`)
    expect(runs.renderRunHtml(db, run.id)).toBe(original)
    expect(runs.verifyRunHtml(db, run.id)).toBe(true)
  }
)

it('verifies the original hash without new options even when snapshot profiles and context say en/off', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'))
  profile('de')
  const run = await runs.createRun(db, { ...req, groupBy: 'reference' }, render)
  const originalHash = '1bb5a5fc5f1ce328cb13bf0d0cc470e888a2ae6c897576712c151d602d9d75d5'
  expect(run.html_sha256).toBe(originalHash)
  const snapshot = JSON.parse(run.rule_snapshot)
  delete snapshot.options.language
  delete snapshot.options.fee_column
  snapshot.clientProfile.language = 'en'
  snapshot.clientProfile.fee_column = 'off'
  snapshot.projectProfiles['1'] = { ...snapshot.clientProfile }
  snapshot.context.language = 'en'
  snapshot.context.fee_column = 'off'
  db.exec('DROP TRIGGER trg_billing_run_update')
  db.prepare('UPDATE billing_run SET rule_snapshot = ? WHERE id = ?').run(
    JSON.stringify(snapshot),
    run.id
  )
  expect(runs.verifyRunHtml(db, run.id)).toBe(true)
})
