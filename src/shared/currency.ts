import type { BudgetStatus, Project } from './types'
import { localDateKey } from './dateRanges'

/**
 * Currency formatting and integer-cent arithmetic for the PDF pipeline.
 *
 * Rationale: rates and fees are stored as integer cents (`clients.rate_cent`)
 * to avoid float drift across the rate-times-minutes path. We never multiply
 * floats — minutes × cents stay integral until the final display step.
 */

/**
 * Compute fee in cents for `minutes` worked at `rateCent` per hour.
 * Half-up rounding to the nearest cent (the format users expect on invoices).
 *
 * `Math.round` follows banker-style on .5 in some JS engines for negative
 * numbers; we never have negatives here (rates >= 0, minutes >= 0), so
 * standard half-up applies.
 */
export function feeCent(minutes: number, rateCent: number): number {
  if (rateCent <= 0 || minutes <= 0) return 0
  // (minutes / 60) * rateCent => fractional cents
  return Math.round((minutes * rateCent) / 60)
}

/**
 * Format an integer cent amount as a German currency string with a
 * thousands separator and the EUR sign suffix. Matches the format users
 * see on every invoice they receive in DE: "1.234,56 €".
 */
export function formatEur(cent: number): string {
  const sign = cent < 0 ? '-' : ''
  const abs = Math.abs(cent)
  const euros = Math.floor(abs / 100).toString()
  const remainder = (abs % 100).toString().padStart(2, '0')
  // Insert thousand separators every 3 digits from the right.
  const withDots = euros.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${sign}${withDots},${remainder} €`
}

/**
 * Round a duration UP to the next multiple of `step` minutes (ceil).
 * Used by the PDF pipeline when `pdf_round_minutes` is non-zero — this is
 * the conventional billing rule: any started step is charged in full
 * ("angebrochene 15 Minuten werden voll berechnet"). A raw 1-minute entry
 * with step=15 becomes 15 minutes, not 0.
 *
 * Returns the input unchanged when `step <= 0` ("no rounding" sentinel).
 * Zero (or negative) input minutes always stay zero — we never invent
 * billable time for an entry that has none.
 */
export function roundMinutes(minutes: number, step: number): number {
  if (step <= 0) return minutes
  if (minutes <= 0) return 0
  return Math.ceil(minutes / step) * step
}

/**
 * THE billing rule (2.0 design section 7), the only place that rounds money
 * minutes. `rawMin` are the whole minutes of a segment, already rounded up
 * (0 stays 0). A minimum unit lifts a shorter segment, then the interval
 * rounds up to the next multiple; interval 0 means "off".
 */
export function billedMinutesRule(rawMin: number, intervalMin: number, minUnitMin: number): number {
  if (rawMin <= 0) return 0
  const lifted = Math.max(rawMin, minUnitMin)
  return intervalMin > 0 ? Math.ceil(lifted / intervalMin) * intervalMin : lifted
}

/**
 * Billed minutes for an entry of `rawMs` milliseconds: ceil to whole
 * minutes (a few-second entry counts as 1 minute, never vanishes to 0),
 * then `billedMinutesRule`. Shared by the PDF pipeline and the calendar's
 * day revenue so both bill the same minutes.
 */
export function billedMinutes(rawMs: number, step: number, minUnit = 0): number {
  const rawMin = rawMs > 0 ? Math.ceil(rawMs / 60000) : 0
  return billedMinutesRule(rawMin, step, minUnit)
}

/**
 * The hourly rate that applies to an entry (v1.13 #120): a project with a
 * rate of its own uses it, a project without one (null) inherits the client
 * rate. A project rate of 0 is a deliberate choice — goodwill work billed at
 * 0 € — and is never replaced by the client rate.
 */
export function effectiveRateCent(
  projectRateCent: number | null | undefined,
  clientRateCent: number
): number {
  return projectRateCent != null ? projectRateCent : clientRateCent
}

// ── SQL twins ──────────────────────────────────────────────────────────────
// Analytics and the MCP server sum revenue in SQLite. These fragments are the
// same rules as `billedMinutes`, `effectiveRateCent` and `feeCent`, so every
// surface reports the amount the invoice bills. `revenueSql.test.ts` runs both
// sides over the same entries; change one side and it turns red.

/** Effective rate for an entry joined as `p` (projects) and `c` (clients). */
export const EFFECTIVE_RATE_SQL = 'COALESCE(p.rate_cent, c.rate_cent, 0)'

/**
 * Whole minutes of the entry aliased `e`, like `billedMinutes`: whole
 * milliseconds (julianday, since strftime('%s') drops them), ceiled to
 * minutes.
 */
export function rawMinutesSql(startedAt: string, stoppedAt: string): string {
  const ms = `MAX(0, CAST(ROUND((julianday(${stoppedAt}) - julianday(${startedAt})) * 86400000) AS INTEGER))`
  return `((${ms} + 59999) / 60000)`
}

/**
 * SQL twin of `billedMinutesRule` over column expressions, because interval
 * and minimum unit differ per row once clients have a billing profile.
 */
export function billedMinutesRuleSql(raw: string, interval: string, minUnit: string): string {
  const lifted = `MAX(${raw}, ${minUnit})`
  return `CASE WHEN ${raw} <= 0 THEN 0
    WHEN ${interval} > 0 THEN ((${lifted} + ${interval} - 1) / ${interval} * ${interval})
    ELSE ${lifted} END`
}

/**
 * Billed minutes of the entry aliased `e` with a constant step (no minimum
 * unit): the 1.x shape, kept for tests that compare the twin to the rule.
 */
export function billedMinutesSql(step: number): string {
  return billedMinutesRuleSql(rawMinutesSql('e.started_at', 'e.stopped_at'), String(step), '0')
}

/** Fee in cents of the entry aliased `e`, like `feeCent`: rounded per entry. */
export function feeCentSql(step: number): string {
  return `ROUND(${EFFECTIVE_RATE_SQL} * ${billedMinutesSql(step)} / 60.0)`
}

/**
 * Budget consumption per project, one row per `project_id` with
 * Minutes and cents, over all time and in the supplied local calendar month.
 * Only completed, live, billable segments from the invoice's billing_lines.
 * Every budget reader (projects:getAll, projects:getBudgetStatus, MCP
 * list_projects) uses this one query.
 */
export function budgetUsageSql(): string {
  return `SELECT e.project_id AS project_id,
            COALESCE(SUM(e.billed_minutes), 0) AS used_minutes,
            COALESCE(SUM(e.fee_cent), 0) AS used_cent,
            COALESCE(SUM(CASE WHEN e.segment_date >= :monthStart AND e.segment_date < :nextMonthStart
              THEN e.billed_minutes ELSE 0 END), 0) AS month_used_minutes,
            COALESCE(SUM(CASE WHEN e.segment_date >= :monthStart AND e.segment_date < :nextMonthStart
              THEN e.fee_cent ELSE 0 END), 0) AS month_used_cent
          FROM billing_lines e
          WHERE e.stopped_at IS NOT NULL AND e.billable = 1
          GROUP BY e.project_id`
}

/** Local dates, not UTC instants: also correct just after midnight on the 1st. */
export function budgetMonthBounds(now = new Date()): {
  monthStart: string
  nextMonthStart: string
} {
  return {
    monthStart: localDateKey(new Date(now.getFullYear(), now.getMonth(), 1)),
    nextMonthStart: localDateKey(new Date(now.getFullYear(), now.getMonth() + 1, 1))
  }
}

/** Both list readers expose consumption for the project's chosen period. */
export function budgetPeriodUsageSql(): string {
  return `COALESCE(CASE WHEN p.budget_period = 'month' THEN bud.month_used_minutes ELSE bud.used_minutes END, 0) AS used_minutes,
    COALESCE(CASE WHEN p.budget_period = 'month' THEN bud.month_used_cent ELSE bud.used_cent END, 0) AS used_cent`
}

export function projectBudgetStatus(
  project: Pick<
    Project,
    | 'budget_kind'
    | 'budget_period'
    | 'budget_minutes'
    | 'budget_cent'
    | 'used_minutes'
    | 'used_cent'
  >
): BudgetStatus {
  const kind = project.budget_kind ?? 'hours'
  return {
    kind,
    period: project.budget_period ?? 'total',
    budget: (kind === 'eur' ? project.budget_cent : project.budget_minutes) ?? null,
    used: (kind === 'eur' ? project.used_cent : project.used_minutes) ?? 0
  }
}

/** A zero budget is set; any positive consumption exceeds it. */
export function budgetPercent(budget: number, used: number): number {
  return budget > 0 ? (used / budget) * 100 : used > 0 ? 100 : 0
}

export function formatBudgetAmount(value: number, kind: BudgetStatus['kind']): string {
  return kind === 'eur' ? formatEur(value) : `${(value / 60).toFixed(1)}h`
}

/**
 * Format a minute count as `H:MM` (two-digit minutes). Used for entry rows
 * and totals in the PDF. Examples: 84 → "1:24", 600 → "10:00", 5 → "0:05".
 */
/** Worked seconds → "H:MM" (a completed duration; seconds under a minute are dropped). */
export function formatSecondsHm(seconds: number): string {
  const sec = Number.isFinite(seconds) ? seconds : 0
  return formatHoursMinutes(Math.max(0, Math.floor(sec / 60)))
}

/** Cents → whole euros with thousands dots, no unit: "13.078" (half-up). */
export function formatEurWholeDigits(cents: number): string {
  const euros = Math.round((Number.isFinite(cents) ? cents : 0) / 100)
  const digits = Math.abs(euros)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${euros < 0 ? '-' : ''}${digits}`
}

/** Cents → "13.078 €" (whole euros, half-up). */
export function formatEurWhole(cents: number): string {
  return `${formatEurWholeDigits(cents)} €`
}

export function formatHoursMinutes(minutes: number): string {
  const sign = minutes < 0 ? '-' : ''
  const abs = Math.abs(minutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return `${sign}${h}:${m.toString().padStart(2, '0')}`
}
