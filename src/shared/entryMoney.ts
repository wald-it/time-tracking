import { billedMinutes } from './currency'
import type { Entry } from './types'

/**
 * What a reader of the view `entries` shows for the time and money of a row
 * (2.0 P4, #374). Finished segments carry the numbers of `billing_lines`
 * (`billed_minutes`, `fee_cent`); nothing here rounds or prices a finished
 * segment itself. Only a running segment is ticked, by the one rule of
 * `currency.ts` and the profile values the row carries, because the stored
 * value is as old as the last read.
 */

/** True when the row's profile rounds: an interval or a minimum unit above 0. */
export function entryRounds(e: Entry): boolean {
  return (e.interval_min ?? 0) > 0 || (e.min_unit_min ?? 0) > 0
}

/**
 * Minutes the invoice bills for the row, or null when the profile does not
 * round (the row then shows its raw time) or the row carries no money columns.
 * A running segment counts up to `nowMs`.
 */
export function entryBilledMinutes(e: Entry, nowMs: number): number | null {
  if (!entryRounds(e)) return null
  if (e.stopped_at === null) {
    const rawMs = Math.max(0, nowMs - new Date(e.started_at).getTime())
    return billedMinutes(rawMs, e.interval_min ?? 0, e.min_unit_min ?? 0)
  }
  return e.billed_minutes ?? null
}

/** Seconds of a row as the day total shows them: billed when the profile rounds, else raw. */
export function entryShownSeconds(e: Entry, nowMs: number): number {
  const billed = entryBilledMinutes(e, nowMs)
  if (billed !== null) return billed * 60
  const stop = e.stopped_at ? new Date(e.stopped_at).getTime() : nowMs
  return Math.max(0, Math.floor((stop - new Date(e.started_at).getTime()) / 1000))
}
