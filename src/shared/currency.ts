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
 * Billed minutes for an entry of `rawMs` milliseconds: ceil to whole
 * minutes (a few-second entry counts as 1 minute, never vanishes to 0),
 * then round up to `step` via `roundMinutes`. Shared by the PDF pipeline
 * and the calendar's day revenue so both bill the same minutes.
 */
export function billedMinutes(rawMs: number, step: number): number {
  const rawMin = rawMs > 0 ? Math.ceil(rawMs / 60000) : 0
  return roundMinutes(rawMin, step)
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
 * Billed minutes of the entry aliased `e`, like `billedMinutes`: whole
 * milliseconds (julianday, since strftime('%s') drops them), ceiled to
 * minutes, then up to `step`.
 */
export function billedMinutesSql(step: number): string {
  const ms = `MAX(0, CAST(ROUND((julianday(e.stopped_at) - julianday(e.started_at)) * 86400000) AS INTEGER))`
  const min = `((${ms} + 59999) / 60000)`
  return step > 0 ? `((${min} + ${step} - 1) / ${step} * ${step})` : min
}

/** Fee in cents of the entry aliased `e`, like `feeCent`: rounded per entry. */
export function feeCentSql(step: number): string {
  return `ROUND(${EFFECTIVE_RATE_SQL} * ${billedMinutesSql(step)} / 60.0)`
}

/**
 * Budget consumption per project, one row per `project_id` with
 * `used_minutes` (#285): what the invoice bills — completed, live, billable
 * entries, each rounded by `billedMinutes` — over all time. Computed from the
 * timestamps, not the stored `rounded_min`, which the timer never writes.
 * Every budget reader (projects:getAll, projects:getBudgetStatus, MCP
 * list_projects) uses this one query.
 */
export function budgetUsedMinutesSql(step: number): string {
  return `SELECT e.project_id AS project_id,
            COALESCE(SUM(${billedMinutesSql(step)}), 0) AS used_minutes
          FROM entries e
          WHERE e.deleted_at IS NULL AND e.stopped_at IS NOT NULL AND e.billable = 1
          GROUP BY e.project_id`
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
