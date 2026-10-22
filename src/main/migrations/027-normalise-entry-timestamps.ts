import type Database from 'better-sqlite3'
import type { Migration } from './index'

/**
 * Entry timestamps in one form: UTC with milliseconds and `Z`
 * (`2026-09-30T22:30:00.000Z`), as every write path stores them.
 *
 * Day and month ranges compare `started_at` as text against such instants
 * (local month bounds). `startTimer` used to store the start as sent, so an
 * MCP `start_timer` could leave `2026-10-01T00:30:00+02:00`, a value without
 * a zone, or a bare date. The app always read these with `new Date(…)`, so
 * that is what the rewrite uses too — the stored instant stays the one the
 * app showed and billed: an offset or `Z` as given, a date-time without a
 * zone as local time (the earlier of the two on the night the clocks go
 * back), a bare date as UTC midnight. SQL cannot reproduce those rules
 * exactly (Codex, rounds 3 and 4), hence a code migration.
 *
 * Rows already in canonical form are skipped; a value `new Date` cannot read
 * stays untouched.
 */
const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const COLUMNS = ['started_at', 'stopped_at', 'heartbeat_at'] as const

/** The canonical form of a stored timestamp, or null if it cannot be read. */
export function canonicalTimestamp(value: string): string | null {
  if (CANONICAL.test(value)) return value
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

function normaliseEntryTimestamps(db: Database.Database): void {
  for (const column of COLUMNS) {
    const rows = db
      .prepare(
        `SELECT id, ${column} AS value FROM entries
          WHERE ${column} IS NOT NULL
            AND ${column} NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'`
      )
      .all() as Array<{ id: number; value: string }>
    const update = db.prepare(`UPDATE entries SET ${column} = ? WHERE id = ?`)
    for (const row of rows) {
      const canonical = canonicalTimestamp(row.value)
      if (canonical !== null && canonical !== row.value) update.run(canonical, row.id)
    }
  }
}

export const migration027: Migration = {
  version: 27,
  name: 'normalise-entry-timestamps',
  up: '-- data only, see run',
  run: normaliseEntryTimestamps
}
