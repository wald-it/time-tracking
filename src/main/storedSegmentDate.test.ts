/**
 * Design 12 (P4 part): the day an entry's time belongs to is stored with the
 * segment when it is written, and every money reader takes the stored value
 * instead of working it out again from the time zone. The comparison with the
 * month of a billing run needs runs and belongs to P5.
 *
 * Simulated with stored values: the entry starts on 31 Oct (midday UTC) but its
 * segment says 1 Nov, as if it had been cut in a zone further east. Readers
 * that recomputed the date would put it in October.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { buildAnalyticsSummary } from './analyticsHandlers'
import { getAnalytics } from '../mcp/queries'
import { writeEntry } from './entryMutations'
import { buildPdfPayload } from './pdf'
import { exportEntries } from './entryRanges'
import { seedEntry } from '../test/entryFixtures'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

const SHOW = { exposeRates: true, exposePrivateNotes: false }

describe('segment_date is stored and read back', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    db.prepare(
      `INSERT INTO clients (id, name, color, rate_cent) VALUES (1, 'A', '#111', 6000)`
    ).run()
    db.prepare(
      `INSERT INTO rate (client_id, rate_cent, valid_from) VALUES (1, 12000, '2026-11-01')`
    ).run()
  })
  afterEach(() => db.close())

  it('writeEntry stores the local date of the start with the segment', () => {
    const r = writeEntry(
      db,
      {
        op: 'create',
        fields: {
          client_id: 1,
          description: 'x',
          started_at: new Date(2026, 5, 10, 9).toISOString(),
          stopped_at: new Date(2026, 5, 10, 10).toISOString()
        }
      },
      { source: 'app' }
    )
    if (!r.ok) throw new Error(r.error)
    const seg = db
      .prepare(
        `SELECT segment_date FROM entry_segment WHERE version_id IN (SELECT current_version_id FROM entry WHERE id = ?)`
      )
      .get(r.data.id) as { segment_date: string }
    expect(seg.segment_date).toBe('2026-06-10')
  })

  it('billing_lines, Auswertung and get_analytics follow the stored date', () => {
    seedEntry(db, {
      id: 1,
      client_id: 1,
      started_at: '2026-10-31T10:00:00.000Z',
      stopped_at: '2026-10-31T11:00:00.000Z',
      segments: [
        {
          started_at: '2026-10-31T10:00:00.000Z',
          stopped_at: '2026-10-31T11:00:00.000Z',
          segment_date: '2026-11-01'
        }
      ]
    })
    // The rate of 1 Nov applies, not the one of 31 Oct.
    const line = db
      .prepare(`SELECT rate_cent, fee_cent FROM billing_lines WHERE entry_id = 1`)
      .get() as { rate_cent: number; fee_cent: number }
    expect(line).toEqual({ rate_cent: 12000, fee_cent: 12000 })

    const month = (y: number, m: number): number => {
      const a = buildAnalyticsSummary(db, { year: y, month: m }, new Date(2026, 11, 15, 12))
      if (!a.ok) throw new Error(a.error)
      return a.data.month.revenue
    }
    expect(month(2026, 10)).toBe(0)
    expect(month(2026, 11)).toBe(12000)
    expect(getAnalytics(db, SHOW, 2026, 10).revenue_cent).toBe(0)
    expect(getAnalytics(db, SHOW, 2026, 11).revenue_cent).toBe(12000)
  })

  it('PDF and CSV select by the stored date, like the analytics', () => {
    seedEntry(db, {
      id: 2,
      client_id: 1,
      started_at: '2026-10-31T10:00:00.000Z',
      stopped_at: '2026-10-31T11:00:00.000Z',
      segments: [
        {
          started_at: '2026-10-31T10:00:00.000Z',
          stopped_at: '2026-10-31T11:00:00.000Z',
          segment_date: '2026-11-01'
        }
      ]
    })
    const nov = { clientId: 1, fromIso: '2026-11-01', toIso: '2026-11-30' }
    const oct = { clientId: 1, fromIso: '2026-10-01', toIso: '2026-10-31' }
    expect(buildPdfPayload(db, nov, '').totals.feeCent).toBe(12000)
    expect(buildPdfPayload(db, oct, '').totals.feeCent).toBe(0)
    expect(exportEntries(db, nov).map((e) => e.id)).toEqual([2])
    expect(exportEntries(db, oct)).toEqual([])
    expect(buildPdfPayload(db, nov, '').rows[0].date).toBe('01.11.2026')
  })
})
