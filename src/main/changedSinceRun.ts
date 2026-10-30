import type Database from 'better-sqlite3'

export interface ChangedSinceRunRequest {
  clientId: number
  projectId?: number | null
  fromIso: string
  toIso: string
}

export interface ChangedSinceRunResult {
  lastRun: { id: number; number: string; createdAt: string } | null
  entries: { entryId: number; change: 'created' | 'changed'; changedAt: string }[]
}

/** Read the same completed, live entries as checkPeriod, once per logical entry. */
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
  const entries = db
    .prepare(
      `SELECT e.id AS entryId,
         CASE WHEN first.written_at > @createdAt THEN 'created' ELSE 'changed' END AS change,
         MAX(history.written_at) AS changedAt
       FROM entries e
       JOIN entry_version current ON current.id = e.version_id
       JOIN entry_version first ON first.entry_id = e.id AND first.version_no = 1
       JOIN entry_version history ON history.entry_id = e.id AND history.written_at > @createdAt
       WHERE e.client_id = @clientId AND e.deleted_at IS NULL
         AND e.stopped_at IS NOT NULL AND current.stopped_at IS NOT NULL
         AND e.segment_date BETWEEN @fromIso AND @toIso
         AND (@projectId IS NULL OR e.project_id = @projectId)
       GROUP BY e.id
       ORDER BY current.started_at, e.id`
    )
    .all({
      clientId: request.clientId,
      fromIso: request.fromIso,
      toIso: request.toIso,
      projectId: request.projectId ?? null,
      createdAt: lastRun.createdAt
    }) as ChangedSinceRunResult['entries']
  return { lastRun, entries }
}
