import type { Entry } from './types'

/** Missing or invalid values use six hours; out-of-range values are not clamped. */
export function parseLongRunThresholdHours(raw: string | undefined): number {
  const value = Number(raw)
  return raw?.trim() && Number.isInteger(value) && value >= 1 && value <= 24 ? value : 6
}

export function shouldAskLongRun(
  entry: Pick<Entry, 'id' | 'started_at' | 'stopped_at'> | null,
  nowMs: number,
  thresholdHours: number,
  asked: ReadonlySet<number>
): boolean {
  return (
    !!entry &&
    entry.stopped_at === null &&
    !asked.has(entry.id) &&
    nowMs - Date.parse(entry.started_at) >= thresholdHours * 3_600_000
  )
}
