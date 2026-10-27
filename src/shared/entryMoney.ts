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
  return rawSeconds(e, nowMs)
}

/** Raw whole seconds of a row, a running one counted up to `nowMs`. */
function rawSeconds(e: Entry, nowMs: number): number {
  const stop = e.stopped_at ? new Date(e.stopped_at).getTime() : nowMs
  return Math.max(0, Math.floor((stop - new Date(e.started_at).getTime()) / 1000))
}

/**
 * Seconds a set of rows adds up to as the invoice bills them, or undefined when
 * no row's profile rounds (then nothing is shown as "rounded"). Once one row
 * rounds, every row counts its billed minutes, also a row without a profile
 * (its raw time rounded up to whole minutes by billing_lines): a sum that mixed
 * raw seconds and billed minutes would differ from the PDF.
 */
export function rowsBilledSeconds(entries: Entry[], nowMs: number): number | undefined {
  if (!entries.some(entryRounds)) return undefined
  let minutes = 0
  for (const e of entries) {
    if (e.stopped_at === null) {
      minutes += billedMinutes(
        Math.max(0, nowMs - new Date(e.started_at).getTime()),
        e.interval_min ?? 0,
        e.min_unit_min ?? 0
      )
    } else {
      minutes += e.billed_minutes ?? billedMinutes(rawSeconds(e, nowMs) * 1000, 0, 0)
    }
  }
  return minutes * 60
}

/**
 * The interval to name in a "gerundet ... N-min-Takt" label: only when every
 * row has the same interval above 0 and none has a minimum unit. Otherwise
 * null, and the label says "gerundet" without claiming a uniform step.
 */
export function uniformStepMin(entries: Entry[]): number | null {
  if (entries.length === 0) return null
  const step = entries[0].interval_min ?? 0
  if (step <= 0) return null
  for (const e of entries) {
    if ((e.interval_min ?? 0) !== step || (e.min_unit_min ?? 0) > 0) return null
  }
  return step
}
