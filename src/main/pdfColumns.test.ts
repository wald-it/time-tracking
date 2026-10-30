import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

function profile(client: string | null, project: string | null): void {
  db.prepare('INSERT INTO billing_profile (client_id, columns) VALUES (1, ?)').run(client)
  if (project !== null)
    db.prepare('INSERT INTO billing_profile (project_id, columns) VALUES (1, ?)').run(project)
}
function hasTimes(html: string, expected: boolean): void {
  expect(html.includes('<th class="col-time">Von</th>')).toBe(expected)
  expect(html.includes('<th class="col-time">Bis</th>')).toBe(expected)
  expect(html.includes('<td class="col-time">09:00</td>')).toBe(expected)
  expect(html.includes('<td class="col-time">10:00</td>')).toBe(expected)
}

describe('PDF column sets (#422)', () => {
  it.each(['fee', 'hidden', 'no rate'] as const)('renders both column sets with %s', (fee) => {
    if (fee === 'no rate')
      db.exec(
        'UPDATE clients SET rate_cent = 0 WHERE id = 1; UPDATE rate SET rate_cent = 0 WHERE client_id = 1'
      )
    for (const columns of ['times', 'no_times'] as const) {
      const request = {
        ...req,
        columns,
        groupBy: 'reference' as const,
        hideFeeColumn: fee === 'hidden'
      }
      const payload = pdf.buildPdfPayload(db, request, '')
      const html = pdf.buildPdfHtml(payload)
      const span = columns === 'times' ? 4 : 2
      hasTimes(html, columns === 'times')
      for (const header of ['Datum', 'Tätigkeit', 'Dauer'])
        expect(html).toContain(`>${header}</th>`)
      expect(html.includes('>Honorar</th>')).toBe(fee === 'fee')
      expect(html).toContain('<td class="col-desc">Work<div class="entry-ref">REF</div>')
      expect(html).toContain('<td class="col-dur">1:00</td>')
      expect(html).toContain(
        `<td colspan="${span + (fee === 'fee' ? 2 : 1)}" class="col-group">REF</td>`
      )
      expect(html).toContain(`<td colspan="${span}">Zwischensumme REF</td>`)
      expect(html).toContain(`<td colspan="${span}">Gesamtsumme</td>`)
      expect(pdf.buildPdfHtml({ ...payload, groups: null })).toContain(
        `<td colspan="${span}">Summe</td>`
      )
      expect(pdf.buildPdfHtml({ ...payload, groups: null, rows: [] })).toContain(
        `<td colspan="${span + (fee === 'fee' ? 2 : 1)}">Keine Einträge`
      )
    }
  })

  const cases = [
    {
      name: 'request over project',
      client: 'times',
      project: 'times',
      projectId: 1,
      columns: 'no_times',
      expected: false
    },
    {
      name: 'project over client',
      client: 'times',
      project: 'no_times',
      projectId: 1,
      expected: false
    },
    {
      name: 'project times over client no_times',
      client: 'no_times',
      project: 'times',
      projectId: 1,
      expected: true
    },
    {
      name: 'client without project filter',
      client: 'no_times',
      project: 'times',
      expected: false
    },
    {
      name: 'client inherited by project',
      client: 'no_times',
      project: null,
      projectId: 1,
      expected: false
    },
    {
      name: 'global default inherited by client and project',
      client: null,
      project: null,
      projectId: 1,
      expected: false
    }
  ] as const
  for (const mode of ['live', 'run'] as const) {
    it.each(cases)(`${mode}: $name`, async (c) => {
      profile(c.client, c.project)
      if (c.client === null)
        db.exec(
          `UPDATE billing_profile SET columns = 'no_times' WHERE client_id IS NULL AND project_id IS NULL`
        )
      const request: PdfRequest = {
        ...req,
        projectId: 'projectId' in c ? c.projectId : undefined,
        columns: 'columns' in c ? c.columns : undefined
      }
      if (mode === 'live') {
        hasTimes(pdf.buildPdfHtml(pdf.buildPdfPayload(db, request, '')), c.expected)
        hasTimes(
          pdf.buildPdfHtml(pdf.buildPdfPayload(db, { ...request, columns: 'no_times' }, '')),
          false
        )
        hasTimes(
          pdf.buildPdfHtml(pdf.buildPdfPayload(db, { ...request, columns: 'times' }, '')),
          true
        )
      } else {
        const created = await runs.createRun(db, request, render)
        const html = runs.renderRunHtml(db, created.id)
        hasTimes(html, c.expected)
        expect(JSON.parse(created.rule_snapshot).options.columns).toBe(
          c.expected ? 'times' : 'no_times'
        )
        expect(JSON.parse(created.rule_snapshot).snapshot_version).toBe(1)
        db.exec(`UPDATE billing_profile SET columns = 'times'`)
        expect(runs.renderRunHtml(db, created.id)).toBe(html)
        expect(runs.verifyRunHtml(db, created.id)).toBe(true)
        runs.releaseRun(db, created.id, 'Test replacement')
        db.exec(`UPDATE billing_profile SET columns = 'no_times'`)
        const override = await runs.createRun(db, { ...request, columns: 'times' }, render)
        hasTimes(runs.renderRunHtml(db, override.id), true)
        expect(runs.verifyRunHtml(db, override.id)).toBe(true)
        runs.releaseRun(db, override.id, 'Test override')
        const withoutTimes = await runs.createRun(db, { ...request, columns: 'no_times' }, render)
        hasTimes(runs.renderRunHtml(db, withoutTimes.id), false)
      }
    })
  }

  it.each(['times', 'no_times'] as const)(
    'verifies the original HTML hash of a version 1 run without options.columns (profile %s)',
    async (legacyColumns) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'))
      profile('times', null)
      const created = await runs.createRun(db, { ...req, groupBy: 'reference' }, render)
      const snapshot = JSON.parse(created.rule_snapshot)
      expect(snapshot.options.columns).toBe('times')
      // Captured from the pre-#422 renderer, with UTC pinned before module loading.
      const originalHash = '1bb5a5fc5f1ce328cb13bf0d0cc470e888a2ae6c897576712c151d602d9d75d5'
      expect(created.html_sha256).toBe(originalHash)
      // A snapshot written before #422: no columns in options or context. Its profile may
      // already say no_times (settable since #421), which the old renderer ignored.
      db.exec('DROP TRIGGER trg_billing_run_update')
      delete snapshot.options.columns
      delete snapshot.context.columns
      snapshot.clientProfile.columns = legacyColumns
      db.prepare('UPDATE billing_run SET rule_snapshot = ?, html_sha256 = ? WHERE id = ?').run(
        JSON.stringify(snapshot),
        originalHash,
        created.id
      )
      db.exec(`UPDATE billing_profile SET columns = 'no_times'`)
      expect(runs.verifyRunHtml(db, created.id)).toBe(true)
    }
  )
})
