import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import { monthEntries } from './entryRanges'
import { readTodayEntries } from './dashboardTotals'
import { buildPdfPayload } from './pdf'
import { dayBilledSeconds, dayRevenueCent } from '../renderer/src/components/kalender/dayRevenue'

let DatabaseImpl: DatabaseCtor
let db: Database.Database
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})
beforeEach(() => {
  db = new DatabaseImpl(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  db.exec("INSERT INTO clients (id, name, color, rate_cent) VALUES (1, 'History', '#123456', 6000)")
})
afterEach(() => db.close())

describe('calendar and PDF money agreement (#374)', () => {
  it('keeps the historical amount for an old hour after a rate increase', () => {
    seedEntry(db, {
      client_id: 1,
      started_at: '2025-10-10T10:00:00.000Z',
      stopped_at: '2025-10-10T11:00:00.000Z'
    })
    db.exec('UPDATE clients SET rate_cent = 12000 WHERE id = 1')
    const pdf = buildPdfPayload(db, { clientId: 1, fromIso: '2025-10-01', toIso: '2025-10-31' }, '')
    const entries = monthEntries(db, 2025, 10)
    expect(pdf.totals.feeCent).toBe(6000)
    expect(dayRevenueCent(entries)).toBe(pdf.totals.feeCent)
  })

  it('shows 15 billed minutes for a 3-minute entry with a 15-minute minimum, like the PDF', () => {
    db.exec(
      'UPDATE billing_profile SET interval_min = 0, min_unit_min = 15 WHERE client_id IS NULL AND project_id IS NULL'
    )
    seedEntry(db, {
      client_id: 1,
      started_at: '2025-10-10T10:00:00.000Z',
      stopped_at: '2025-10-10T10:03:00.000Z'
    })
    const pdf = buildPdfPayload(db, { clientId: 1, fromIso: '2025-10-01', toIso: '2025-10-31' }, '')
    const entries = monthEntries(db, 2025, 10)
    expect(pdf.totals.minutes).toBe(15)
    expect(entries[0].billed_minutes).toBe(pdf.totals.minutes)
    // The calendar's day total goes through the renderer's own function.
    expect(dayBilledSeconds(entries, Date.now())).toBe(pdf.totals.minutes * 60)
  })

  it('hands the money columns and the profile values to Heute as well', () => {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 1, 0, 0)
    seedEntry(db, {
      client_id: 1,
      started_at: start.toISOString(),
      stopped_at: new Date(start.getTime() + 60 * 60000).toISOString()
    })
    const [row] = readTodayEntries(db)
    expect(row).toMatchObject({ billed_minutes: 60, rate_cent: 6000, fee_cent: 6000 })
    expect(row).toMatchObject({ interval_min: 0, min_unit_min: 0 })
  })
})
