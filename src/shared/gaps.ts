import type { Entry } from './types'
import type { WorkingHours } from './workingHours'

export type GapEntry = Pick<Entry, 'started_at' | 'stopped_at'> & Partial<Pick<Entry, 'deleted_at'>>

export interface Gap {
  startMs: number
  endMs: number
}

export const MIN_GAP_MS = 5 * 60 * 1000

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
