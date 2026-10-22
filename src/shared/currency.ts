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
 * The hourly rate that applies to an entry (v1.13 #120): a project rate
 * overrides the client rate when it is set and positive; otherwise the
 * client rate applies. Returns 0 when neither has a rate.
 */
export function effectiveRateCent(
  projectRateCent: number | null | undefined,
  clientRateCent: number
): number {
  return projectRateCent != null && projectRateCent > 0 ? projectRateCent : clientRateCent
}

/**
 * Format a minute count as `H:MM` (two-digit minutes). Used for entry rows
 * and totals in the PDF. Examples: 84 → "1:24", 600 → "10:00", 5 → "0:05".
 */
export function formatHoursMinutes(minutes: number): string {
  const sign = minutes < 0 ? '-' : ''
  const abs = Math.abs(minutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return `${sign}${h}:${m.toString().padStart(2, '0')}`
}
