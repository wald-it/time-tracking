import type { Entry } from '../../../../shared/types'
import { entryShownSeconds, rowsBilledSeconds } from '../../../../shared/entryMoney'

/**
 * Billable revenue of a day in cents: the `fee_cent` of the billable rows
 * (#104), as the invoice bills it. The amount is not computed here; it comes
 * from the view (`billing_lines`) with the rate valid on the day, so a later
 * rate change does not move it. A running entry has no fee until it is
 * stopped (design section 7) and adds nothing. Shared by the calendar cell
 * and the day details so both show one number.
 */
export function dayRevenueCent(entries: Entry[]): number {
  let sum = 0
  for (const e of entries) {
    if (e.billable !== 1) continue
    sum += e.fee_cent ?? 0
  }
  return sum
}

/**
 * Day total as the invoice bills it: the billed minutes of the rows (a running
 * one ticks by the rule up to `nowMs`) as soon as one row's profile rounds,
 * else the raw time.
 */
export function dayBilledSeconds(entries: Entry[], nowMs: number): number {
  return (
    rowsBilledSeconds(entries, nowMs) ??
    entries.reduce((sum, e) => sum + entryShownSeconds(e, nowMs), 0)
  )
}
