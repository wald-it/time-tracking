import { unexplainedGaps, type Gap, type GapEntry } from '../../../../shared/gaps'
import type { WorkingHours } from '../../../../shared/workingHours'

const MINUTE_MS = 60_000

/**
 * A gap as backfill-form defaults. The form works in whole minutes, so the
 * start rounds up and the end rounds down: a neighbour that stopped at
 * 10:00:37 must not be overlapped by a backfill starting at 10:00:00, which
 * the overlap check refuses for the same client. Gaps are at least 5 min, so
 * the range stays non-empty.
 */
export function gapFormRange(gap: Gap): { start: Date; end: Date } {
  return {
    start: new Date(Math.ceil(gap.startMs / MINUTE_MS) * MINUTE_MS),
    end: new Date(Math.floor(gap.endMs / MINUTE_MS) * MINUTE_MS)
  }
}

/** Own entries make today eligible; yesterday's carryovers only add coverage. */
export function todayGaps(entries: GapEntry[], now: Date, hours: WorkingHours): Gap[] {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const previousStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const ownEntries = entries.filter(
    (entry) => new Date(entry.started_at).toDateString() === dayStart.toDateString()
  )
  const carryovers = entries.filter((entry) => {
    const start = Date.parse(entry.started_at)
    return (
      start >= previousStart.getTime() &&
      start < dayStart.getTime() &&
      (entry.stopped_at === null ? now.getTime() : Date.parse(entry.stopped_at)) >
        dayStart.getTime()
    )
  })
  return ownEntries.length
    ? unexplainedGaps([...ownEntries, ...carryovers], dayStart, now, hours)
    : []
}
