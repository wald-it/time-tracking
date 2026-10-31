import type Database from 'better-sqlite3'
import type { BillingPreview, BillingPreviewLine, ReviewSelection } from '../shared/billingPreview'

interface Source {
  entry_id: number
  project_id: number | null
  project_name: string | null
  rate_cent: number
  billed_minutes: number
  fee_cent: number
  segment_date: string
  description: string
  billed_run_id: number | null
}

/** Read the same candidates as createRun. Day totals also include locked segments. */
export function buildBillingPreview(db: Database.Database, req: ReviewSelection): BillingPreview {
  const candidates = db
    .prepare(
      `SELECT l.entry_id, l.project_id, p.name AS project_name, l.rate_cent,
        l.billed_minutes, l.fee_cent, l.segment_date, v.description, l.billed_run_id
      FROM billing_lines l JOIN entry_version v ON v.id = l.version_id
      LEFT JOIN projects p ON p.id = l.project_id
      WHERE l.client_id = ? AND l.stopped_at IS NOT NULL AND l.billable = 1
        AND l.segment_date BETWEEN ? AND ?
        AND (? IS NULL OR l.project_id = ?)
      ORDER BY l.started_at, l.entry_id, l.segment_seq`
    )
    .all(
      req.clientId,
      req.fromIso,
      req.toIso,
      req.projectId ?? null,
      req.projectId ?? null
    ) as Source[]
  const billedEntries = new Set<number>()
  const lines = new Map<string, BillingPreviewLine>()
  const days = new Map<string, { billedMinutes: number; descriptions: Set<string> }>()
  const totals = { billedMinutes: 0, feeCent: 0 }
  for (const row of candidates) {
    const day = days.get(row.segment_date) ?? { billedMinutes: 0, descriptions: new Set<string>() }
    day.billedMinutes += row.billed_minutes
    if (row.description.trim()) day.descriptions.add(row.description)
    days.set(row.segment_date, day)
    if (row.billed_run_id !== null) billedEntries.add(row.entry_id)
  }
  // Keep this filter identical to createRun, without its client short-code guard.
  const unbilled = candidates.filter((row) => row.billed_run_id === null)
  for (const row of unbilled) {
    const key = `${row.project_id}:${row.rate_cent}`
    const line = lines.get(key) ?? {
      projectId: row.project_id,
      projectName: row.project_name,
      rateCent: row.rate_cent,
      billedMinutes: 0,
      feeCent: 0,
      fromIso: row.segment_date,
      toIso: row.segment_date
    }
    line.billedMinutes += row.billed_minutes
    line.feeCent += row.fee_cent
    if (row.segment_date < line.fromIso) line.fromIso = row.segment_date
    if (row.segment_date > line.toIso) line.toIso = row.segment_date
    lines.set(key, line)
    totals.billedMinutes += row.billed_minutes
    totals.feeCent += row.fee_cent
  }
  return {
    lines: [...lines.values()].sort(
      (a, b) =>
        (a.projectName ?? '').localeCompare(b.projectName ?? '', 'de') ||
        a.rateCent - b.rateCent ||
        a.fromIso.localeCompare(b.fromIso)
    ),
    totals,
    billedEntriesCount: billedEntries.size,
    dayGrid: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, day]) => ({
        date,
        billedMinutes: day.billedMinutes,
        activity: [...day.descriptions].join('; ')
      }))
  }
}
