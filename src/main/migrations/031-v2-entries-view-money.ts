import type { Migration } from './index'
import { ENTRIES_VIEW_MONEY_SQL } from '../entryLifecycle/billingLines'

/**
 * 2.0 (P4 renderer part, #374): the view `entries` gains the money columns of
 * `billing_lines` (`billed_minutes`, `rate_cent`, `fee_cent`, `rate_is_project`)
 * and the profile values they were computed with (`interval_min`,
 * `min_unit_min`), so the calendar, Heute and the other readers of the view
 * show what the invoice bills instead of recomputing it. The definition lives
 * in `billingLines.ts` next to the view it joins.
 *
 * Every database that reaches 031 has `billing_lines` from 030. Dropping the
 * view drops its three INSTEAD OF triggers, which the shared definition
 * creates again.
 */
export const migration031: Migration = {
  version: 31,
  name: 'v2-entries-view-money',
  up: `DROP VIEW IF EXISTS entries;
${ENTRIES_VIEW_MONEY_SQL}`
}
