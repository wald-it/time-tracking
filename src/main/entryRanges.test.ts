/**
 * One local month, every path: the calendar (`entries:getByMonth`), MCP
 * `list_entries` with year+month, the PDF attachment and the CSV/iCal export
 * must cover the same entries. Pinned to Europe/Berlin (CI runs on UTC, where
 * a UTC cut and a local cut coincide); the boundaries are computed in JS, so
 * the zone set here is the one that counts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { exportEntries, monthEntries } from './entryRanges'
import { buildPdfPayload } from './pdf'
import { listEntries } from '../mcp/queries'
import { handleCsvExport } from './csvExport'
import { handleIcalExport } from './icalExport'

// The export handlers ask for a target file; answer with one in the temp dir.
let saveTargetPath = ''
vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: saveTargetPath })) }
}))

let DatabaseImpl: DatabaseCtor
const previousTz = process.env.TZ

beforeAll(async () => {
  process.env.TZ = 'Europe/Berlin'
  DatabaseImpl = await loadSqlite()
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

/** Local wall-clock time in the pinned zone → stored UTC instant. */
function at(y: number, m: number, d: number, h: number, min: number): string {
  return new Date(y, m - 1, d, h, min).toISOString()
}

const HIDE = { exposeRates: false, exposePrivateNotes: false }

describe('local month boundaries are the same on every path', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-ranges-'))
    db = new DatabaseImpl(join(tmpDir, 'test.sqlite'))
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    db.prepare(
      `INSERT INTO clients (id, name, color, rate_cent) VALUES (1, 'Acme', '#6366f1', 6000)`
    ).run()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function add(label: string, startIso: string): void {
    const stop = new Date(Date.parse(startIso) + 20 * 60 * 1000).toISOString()
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, billable)
         VALUES (1, ?, ?, ?, 1)`
    ).run(label, startIso, stop)
  }

  /** Which of the labels the written export file mentions. */
  async function written(
    run: () => Promise<{ ok: boolean }>,
    file: string,
    labels: string[]
  ): Promise<string[]> {
    saveTargetPath = join(tmpDir, file)
    expect((await run()).ok).toBe(true)
    const text = readFileSync(saveTargetPath, 'utf8')
    return labels.filter((l) => text.includes(l))
  }

  /** The descriptions each path returns for the local month, sorted. */
  async function everyPath(
    year: number,
    month: number,
    fromIso: string,
    toIso: string,
    labels: string[]
  ): Promise<Record<string, string[]>> {
    const sorted = (xs: string[]): string[] => [...xs].sort()
    const req = { clientId: 1, fromIso, toIso }
    return {
      csvFile: sorted(await written(() => handleCsvExport(db, req), 'out.csv', labels)),
      icalFile: sorted(await written(() => handleIcalExport(db, req), 'out.ics', labels)),
      calendar: sorted(monthEntries(db, year, month).map((e) => e.description)),
      mcp: sorted(
        listEntries(db, HIDE, { year, month }, Date.now()).entries!.map((e) => e.description)
      ),
      pdf: sorted(
        buildPdfPayload(db, { clientId: 1, fromIso, toIso }, '').rows.map((r) => r.description)
      ),
      export: sorted(exportEntries(db, { clientId: 1, fromIso, toIso }).map((e) => e.description))
    }
  }

  it('October (clocks go back on the 25th): 00:30 on the 1st and 23:30 on the 31st are in', async () => {
    add('before-30-sep', at(2026, 9, 30, 23, 30))
    add('first-1-oct', at(2026, 10, 1, 0, 30))
    add('dst-25-oct', at(2026, 10, 25, 2, 30))
    add('last-31-oct', at(2026, 10, 31, 23, 30))
    add('after-1-nov', at(2026, 11, 1, 0, 30))

    const labels = ['before-30-sep', 'first-1-oct', 'dst-25-oct', 'last-31-oct', 'after-1-nov']
    const expected = ['dst-25-oct', 'first-1-oct', 'last-31-oct']
    const paths = await everyPath(2026, 10, '2026-10-01', '2026-10-31', labels)
    for (const [path, got] of Object.entries(paths)) expect(got, path).toEqual(expected)
  })

  it('March (clocks go forward on the 29th): the same on every path', async () => {
    add('before-28-feb', at(2026, 2, 28, 23, 30))
    add('first-1-mar', at(2026, 3, 1, 0, 30))
    add('last-31-mar', at(2026, 3, 31, 23, 30))
    add('after-1-apr', at(2026, 4, 1, 0, 30))

    const labels = ['before-28-feb', 'first-1-mar', 'last-31-mar', 'after-1-apr']
    const expected = ['first-1-mar', 'last-31-mar']
    const paths = await everyPath(2026, 3, '2026-03-01', '2026-03-31', labels)
    for (const [path, got] of Object.entries(paths)) expect(got, path).toEqual(expected)
  })
})
