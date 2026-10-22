/**
 * Entry queries over a local calendar range, free of Electron so the range
 * rule is testable on its own. Every range is the user's local month or days
 * (`shared/dateRanges`), compared against `started_at` as instants.
 *
 * Before, the calendar month started at 00:00Z and the CSV and iCal exports
 * cut with SQLite `date(started_at)`, which reads the stored UTC timestamp:
 * an entry at 00:30 on the first local day fell out, one at 00:30 on the day
 * after the range fell in.
 */
import type Database from 'better-sqlite3'
import { localDayRange, localMonthRange } from '../shared/dateRanges'
import type { Entry } from '../shared/types'

/** The calendar's month (`entries:getByMonth`): every client, running ones included. */
export function monthEntries(db: Database.Database, year: number, month: number): Entry[] {
  const { start, end } = localMonthRange(year, month)
  return db
    .prepare(
      `SELECT * FROM entries
         WHERE started_at >= ? AND started_at < ? AND deleted_at IS NULL
         ORDER BY started_at ASC`
    )
    .all(start, end) as Entry[]
}

/**
 * The entries a CSV or iCal export covers: one client, finished, not deleted,
 * optionally one project, started within the local days `fromIso`–`toIso`.
 */
export interface ExportRangeRequest {
  clientId: number
  /** Local calendar days, inclusive: '2026-04-01' to '2026-04-30'. */
  fromIso: string
  toIso: string
  projectId?: number | null
}

export function exportEntries(db: Database.Database, req: ExportRangeRequest): Entry[] {
  const { start, end } = localDayRange(req.fromIso, req.toIso)
  return db
    .prepare(
      `SELECT * FROM entries
         WHERE client_id = ?
           AND started_at >= ?
           AND started_at < ?
           AND (? IS NULL OR project_id = ?)
           AND deleted_at IS NULL
           AND stopped_at IS NOT NULL
         ORDER BY started_at ASC`
    )
    .all(req.clientId, start, end, req.projectId ?? null, req.projectId ?? null) as Entry[]
}
