/**
 * Date helpers shared between main and renderer.
 *
 * All comparisons are intentionally LOCAL-time (`getYear/getMonth/getDate`)
 * so a 23:30→00:30 entry is correctly flagged as cross-midnight regardless
 * of the user's timezone. v1.2 rejects cross-midnight entries; v1.3 will
 * lift the restriction and split such entries.
 */

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
 * The stop of a form that edits one day: like `parseTimeToDate`, except that
 * a stop of 00:00 after a later start is the end of that day — midnight of
 * the next one (#334). That is how the first half of an entry across
 * midnight (20:00 to 00:00) reads. Any other stop before the start stays on
 * the same day, so the form still refuses it instead of making an overnight
 * entry out of a typo.
 */
export function parseStopToDate(dateISO: string | Date, startTime: string, stopTime: string): Date {
  const stop = parseTimeToDate(dateISO, stopTime)
  if (stopTime !== '00:00' || startTime === '00:00') return stop
  return new Date(stop.getFullYear(), stop.getMonth(), stop.getDate() + 1)
}
/** Format a date as "HH:MM" in the host's local timezone. */
export function formatTimeHHMM(date: string | Date): string {
  const d = toDate(date)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}
