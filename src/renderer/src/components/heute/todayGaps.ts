import { unexplainedGaps, type Gap, type GapEntry } from '../../../../shared/gaps'
import type { WorkingHours } from '../../../../shared/workingHours'

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
