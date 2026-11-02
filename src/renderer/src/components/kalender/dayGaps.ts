import { localDateKey } from '../../../../shared/dateRanges'
import { unexplainedGaps, type Gap, type GapEntry } from '../../../../shared/gaps'
import type { WorkingHours } from '../../../../shared/workingHours'

/** Own entries decide eligibility; previous-day carryovers only add coverage. */
export function dayGaps(
  byDay: ReadonlyMap<string, GapEntry[]>,
  day: Date,
  now: Date,
  hours: WorkingHours
): Gap[] {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate())
  const ownEntries = byDay.get(localDateKey(dayStart)) ?? []
  if (ownEntries.length === 0) return []
  const previousDay = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1)
  const carryovers = (byDay.get(localDateKey(previousDay)) ?? []).filter(
    (entry) =>
      (entry.stopped_at === null ? now.getTime() : Date.parse(entry.stopped_at)) >
      dayStart.getTime()
  )
  return unexplainedGaps([...ownEntries, ...carryovers], dayStart, now, hours)
}
