import type Database from 'better-sqlite3'
import { formatHoursMinutes } from '../shared/currency'
import { parseTimeToDate } from '../shared/date'
import { localDateKey } from '../shared/dateRanges'
import { splitAtMidnight, type Segment } from '../shared/midnightSplit'
import { parseFeedbackRules } from '../shared/feedbackRules'
import { parseRuleCheck, type RuleCheckFinding, type RuleCheckId } from '../shared/ruleCheck'
import { checkFeedbackText, readMasterNames } from './feedbackRules'

export interface RuleCheckRequest {
  clientId: number
  projectId?: number | null
  fromIso: string
  toIso: string
}

interface CheckedRow {
  id: number
  description: string
  project_id: number | null
  billable: number
  rate_cent: number | null
  entry_start: string
  entry_stop: string
}

// Messages show durations as h:mm like the timesheet, never as a raw fraction.
function hoursText(hours: number): string {
  return formatHoursMinutes(Math.round(hours * 60))
}

function dayParts(start: Date, stop: Date): Segment[] {
  // Migration preserves zero-length legacy entries; they still have text to check.
  return start.getTime() === stop.getTime() ? [{ start, stop }] : splitAtMidnight(start, stop)
}

/**
 * Advisory only. Select by stored segment date, like the PDF, but include
 * non-billable entries too. Check each selected logical entry once, including
 * its whole duration when the period contains only one of its segments.
 * Read rates through entries/billing_lines, including frozen billing rates.
 */
export function checkPeriod(db: Database.Database, request: RuleCheckRequest): RuleCheckFinding[] {
  const settings = Object.fromEntries(
    (
      db
        .prepare("SELECT key, value FROM settings WHERE key IN ('rule_check', 'feedback_rules')")
        .all() as { key: string; value: string }[]
    ).map(({ key, value }) => [key, value])
  )
  const rules = parseRuleCheck(settings.rule_check)
  const feedback = parseFeedbackRules(settings.feedback_rules)
  const names = readMasterNames(db)
  const rows = db
    .prepare(
      `
    SELECT e.id, e.description, e.project_id, e.billable, e.rate_cent,
           v.started_at AS entry_start, v.stopped_at AS entry_stop
    FROM entries e JOIN entry_version v ON v.id = e.version_id
    WHERE e.client_id = ? AND e.deleted_at IS NULL
      AND e.stopped_at IS NOT NULL AND v.stopped_at IS NOT NULL
      AND e.segment_date BETWEEN ? AND ?
      AND (? IS NULL OR e.project_id = ?)
    ORDER BY v.started_at, e.id, e.segment_seq
  `
    )
    .all(
      request.clientId,
      request.fromIso,
      request.toIso,
      request.projectId ?? null,
      request.projectId ?? null
    ) as CheckedRow[]
  if (!rows.length) return []

  const entries = new Map<number, CheckedRow[]>()
  for (const row of rows) entries.set(row.id, [...(entries.get(row.id) ?? []), row])
  const days = new Set<string>()
  for (const [row] of entries.values()) {
    for (const part of dayParts(new Date(row.entry_start), new Date(row.entry_stop)))
      days.add(localDateKey(part.start))
  }
  const sortedDays = [...days].sort()
  const first = new Date(`${sortedDays[0]}T00:00:00`)
  const last = new Date(`${sortedDays[sortedDays.length - 1]}T00:00:00`)
  last.setDate(last.getDate() + 1)
  // No client/project/billable filter: working time belongs to the whole day.
  const all = db
    .prepare(
      `
    SELECT e.started_at, e.stopped_at FROM entries e
    JOIN entry_version v ON v.id = e.version_id
    WHERE e.deleted_at IS NULL AND e.stopped_at IS NOT NULL AND v.stopped_at IS NOT NULL
      AND e.started_at < ? AND e.stopped_at > ?
  `
    )
    .all(last.toISOString(), first.toISOString()) as { started_at: string; stopped_at: string }[]
  const totals = new Map<string, number>()
  for (const row of all) {
    for (const part of dayParts(new Date(row.started_at), new Date(row.stopped_at))) {
      const day = localDateKey(part.start)
      totals.set(day, (totals.get(day) ?? 0) + (part.stop.getTime() - part.start.getTime()))
    }
  }

  const findings: RuleCheckFinding[] = []
  for (const segments of entries.values()) {
    const row = segments[0]
    const add = (rule: RuleCheckId, params: RuleCheckFinding['params'] = {}): void => {
      findings.push({ entryId: row.id, rule, params })
    }
    if (!row.description.trim()) add('missing_description')
    if (row.project_id === null) add('missing_project')
    if (row.billable && segments.some((segment) => !segment.rate_cent)) add('billable_without_rate')
    if (!row.billable) add('not_billable')
    const start = new Date(row.entry_start)
    const stop = new Date(row.entry_stop)
    const hours = (stop.getTime() - start.getTime()) / 3_600_000
    if (hours > rules.entryMaxHours)
      add('entry_over_threshold', { hours: hoursText(hours), threshold: rules.entryMaxHours })
    if (row.description.length > rules.maxDescriptionLength)
      add('too_long', { length: row.description.length, threshold: rules.maxDescriptionLength })
    let outside = false
    let weekend = false
    for (const part of dayParts(start, stop)) {
      const day = localDateKey(part.start)
      const dayHours = (totals.get(day) ?? 0) / 3_600_000
      if (dayHours > rules.dayMaxHours)
        add('day_over_threshold', {
          day,
          hours: hoursText(dayHours),
          threshold: rules.dayMaxHours
        })
      if (
        part.start < parseTimeToDate(part.start, rules.windowStart) ||
        part.stop > parseTimeToDate(part.start, rules.windowEnd)
      )
        outside = true
      if ([0, 6].includes(part.start.getDay())) weekend = true
    }
    if (outside) add('outside_window', { start: rules.windowStart, end: rules.windowEnd })
    if (rules.weekend && weekend) add('weekend')
    for (const finding of checkFeedbackText(row.description, feedback, names))
      add(`format_${finding.kind}`, {
        [finding.kind === 'name' ? 'name' : 'field']: finding.detail
      })
  }
  return findings.sort((a, b) => {
    const startA = entries.get(a.entryId)![0].entry_start
    const startB = entries.get(b.entryId)![0].entry_start
    return startA.localeCompare(startB) || a.rule.localeCompare(b.rule) || a.entryId - b.entryId
  })
}
