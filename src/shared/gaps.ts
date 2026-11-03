import type { Entry } from './types'
import type { WorkingHours } from './workingHours'

export type GapEntry = Pick<Entry, 'started_at' | 'stopped_at'> & Partial<Pick<Entry, 'deleted_at'>>

export interface Gap {
  startMs: number
  endMs: number
}

export const MIN_GAP_MS = 5 * 60 * 1000

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

/** The current trailing gap, only inside today's half-open working window. */
export function unexplainedSinceMs(
  gaps: Gap[],
  now: Date,
  running: boolean,
  hours: WorkingHours
): number | null {
  const [hour, minute] = hours.end.split(':').map(Number)
  const windowEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute)
  if (running || now.getTime() >= windowEnd.getTime()) return null
  const last = gaps.at(-1)
  return last?.endMs === now.getTime() ? last.startMs : null
}

/** Uncovered working time on a local workday with at least one live entry. */
export function unexplainedGaps(
  entries: GapEntry[],
  dayStartLocal: Date,
  now: Date,
  hours: WorkingHours
): Gap[] {
  if (!hours.days.includes(dayStartLocal.getDay())) return []
  const year = dayStartLocal.getFullYear()
  const month = dayStartLocal.getMonth()
  const day = dayStartLocal.getDate()
  const dayStartMs = new Date(year, month, day).getTime()
  const dayEndMs = new Date(year, month, day + 1).getTime()
  const localTimeMs = (time: string): number => {
    const [hour, minute] = time.split(':').map(Number)
    return new Date(year, month, day, hour, minute).getTime()
  }
  const startMs = localTimeMs(hours.start)
  const endMs = Math.min(localTimeMs(hours.end), now.getTime())
  if (endMs <= startMs) return []

  const spans = entries
    .filter((entry) => entry.deleted_at == null)
    .map((entry) => ({
      startMs: Date.parse(entry.started_at),
      endMs: entry.stopped_at === null ? now.getTime() : Date.parse(entry.stopped_at)
    }))
    .filter(
      (span) => span.startMs < span.endMs && span.startMs < dayEndMs && span.endMs > dayStartMs
    )
  if (spans.length === 0) return []

  const covered = spans
    .map((span) => ({
      startMs: Math.max(startMs, span.startMs),
      endMs: Math.min(endMs, span.endMs)
    }))
    .filter((span) => span.startMs < span.endMs)
    .sort((a, b) => a.startMs - b.startMs)
  const gaps: Gap[] = []
  let cursor = startMs
  for (const span of covered) {
    if (span.startMs - cursor >= MIN_GAP_MS) gaps.push({ startMs: cursor, endMs: span.startMs })
    cursor = Math.max(cursor, span.endMs)
  }
  if (endMs - cursor >= MIN_GAP_MS) gaps.push({ startMs: cursor, endMs })
  return gaps
}

export function unexplainedMs(gaps: Gap[]): number {
  return gaps.reduce((total, gap) => total + gap.endMs - gap.startMs, 0)
}
