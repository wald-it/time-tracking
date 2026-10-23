/**
 * Cross-midnight auto-split (v1.3 PR B).
 *
 * Returns one segment per local-time day the entry covers. For a single-day
 * entry that's a one-element array (no split needed); for an entry that
 * starts at 23:30 and stops at 01:15 the next day, it returns two segments
 * meeting exactly at local midnight. Multi-day spans (≥3 segments) are
 * supported but the IPC validator caps duration at 24 h, so in practice
 * splits never produce more than 2 segments.
 *
 * "Local midnight" matters: a user in CEST sees 00:00 as the day boundary,
 * not UTC midnight. We compute boundaries via `Date` constructors that
 * honour the host TZ, which is correct for desktop usage. DST transitions
 * are handled implicitly — the boundary is whichever local-time wall-clock
 * 00:00 occurs between `start` and `stop`.
 */
export interface Segment {
  start: Date
  stop: Date
}

export function splitAtMidnight(start: Date, stop: Date): Segment[] {
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    throw new Error('start must be a valid Date')
  }
  if (!(stop instanceof Date) || Number.isNaN(stop.getTime())) {
    throw new Error('stop must be a valid Date')
  }
  if (stop.getTime() <= start.getTime()) {
    throw new Error('stop must be after start')
  }

  const segments: Segment[] = []
  let cursor = start
  while (true) {
    const nextMidnight = localMidnightAfter(cursor)
    if (nextMidnight.getTime() >= stop.getTime()) {
      segments.push({ start: cursor, stop })
      break
    }
    segments.push({ start: cursor, stop: nextMidnight })
    cursor = nextMidnight
  }
  return segments
}

/**
 * The local wall-clock 00:00 of the day AFTER `d`. We construct a Date with
 * `d.getFullYear()/Month/Date + 1` so DST transitions move with the host
 * clock automatically (no UTC arithmetic).
 */
export function localMidnightAfter(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0)
}
