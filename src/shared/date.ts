/**
 * Date helpers shared between main and renderer.
 *
 * All comparisons are intentionally LOCAL-time (`getYear/getMonth/getDate`)
 * so a 23:30→00:30 entry is correctly flagged as cross-midnight regardless
 * of the user's timezone. Entries across midnight are stored split at local
 * midnight (shared/midnightSplit); a form edits one of those halves.
 */

import { localMidnightAfter } from './midnightSplit'

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function toDate(input: string | Date): Date {
  return input instanceof Date ? input : new Date(input)
}

/**
 * True iff `a` and `b` fall on the same calendar day in the host's local
 * timezone. Uses local Y/M/D — DST transitions are handled correctly because
 * they shift the wall-clock hour, not the date.
 */
export function isSameLocalDay(a: string | Date, b: string | Date): boolean {
  const da = toDate(a)
  const db = toDate(b)
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}

/**
 * Combine an ISO date (or Date) with a "HH:MM" wall-clock time and return
 * a Date in the host's local timezone. Throws on malformed `time`.
 */
export function parseTimeToDate(dateISO: string | Date, time: string): Date {
  const m = TIME_RE.exec(time)
  if (!m) throw new Error(`Invalid time format (expected HH:MM): ${time}`)
  const base = toDate(dateISO)
  const out = new Date(base.getFullYear(), base.getMonth(), base.getDate())
  out.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0)
  return out
}

/**
 * The stop of a form that edits one day (#334): like `parseTimeToDate`, except
 * on an entry that ends at the next midnight (`untilMidnight`), where the time
 * of that midnight is that midnight. That is how the first half of an entry
 * across midnight (20:00 to 00:00) reads, and a whole day from 00:00 to
 * 00:00. The boundary is the one the split uses (`localMidnightAfter`), so it
 * also holds where the clock jumps from 00:00 to 01:00 and the form shows
 * 01:00 (there, a stop of 01:00 on such an entry always means the boundary,
 * since that time exists only once). A new entry, or any other stop, stays on
 * the same day, so a stop before the start is still refused instead of
 * becoming an overnight entry.
 */
export function parseStopToDate(
  dateISO: string | Date,
  stopTime: string,
  untilMidnight: boolean
): Date {
  const stop = parseTimeToDate(dateISO, stopTime)
  if (!untilMidnight) return stop
  const next = localMidnightAfter(stop)
  return formatTimeHHMM(next) === stopTime ? next : stop
}

/** True when `stop` is exactly the local midnight after the day of `start`. */
export function endsAtNextMidnight(start: string | Date, stop: string | Date): boolean {
  return toDate(stop).getTime() === localMidnightAfter(toDate(start)).getTime()
}
/** Format a date as "HH:MM" in the host's local timezone. */
export function formatTimeHHMM(date: string | Date): string {
  const d = toDate(date)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}
