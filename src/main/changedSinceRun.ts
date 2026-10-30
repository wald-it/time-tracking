import type Database from 'better-sqlite3'
import { entriesForReview, type RuleCheckRequest } from './ruleCheck'

export type ChangedSinceRunRequest = RuleCheckRequest

export interface ChangedSinceRunResult {
  lastRun: { id: number; number: string; createdAt: string } | null
  entries: { entryId: number; change: 'created' | 'changed'; changedAt: string }[]
}

/** Narrow the review list (entriesForReview) to entries written after the client's last run. */
export function changedSinceLastRun(
  db: Database.Database,
  request: ChangedSinceRunRequest
): ChangedSinceRunResult {
  const lastRun = db
    .prepare(
      `SELECT id, number, created_at AS createdAt FROM billing_run
       WHERE client_id = ? AND status = 'active'
       ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(request.clientId) as ChangedSinceRunResult['lastRun'] | undefined
  if (!lastRun) return { lastRun: null, entries: [] }

  // Creating/releasing a billing run only writes billing tables, never entry
  // versions. There are no billing-generated versions to exclude here.
  const writesAfter = db.prepare(
    `SELECT MIN(version_no) AS firstNo, MAX(written_at) AS changedAt FROM entry_version
     WHERE entry_id = ? AND written_at > ?`
  )
  const entries: ChangedSinceRunResult['entries'] = []
  for (const row of entriesForReview(db, request)) {
    const w = writesAfter.get(row.id, lastRun.createdAt) as {
      firstNo: number | null
      changedAt: string | null
    }
    if (w.firstNo === null || w.changedAt === null) continue
    entries.push({
      entryId: row.id,
      change: w.firstNo === 1 ? 'created' : 'changed',
      changedAt: w.changedAt
    })
  }
  return { lastRun, entries }
}
