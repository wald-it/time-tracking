import { describe, expect, it } from 'vitest'
import { localDateKey } from '../../../../shared/dateRanges'
import type { GapEntry } from '../../../../shared/gaps'
import { DEFAULT_WORKING_HOURS } from '../../../../shared/workingHours'
import { dayGaps } from './dayGaps'

// Local dates use the runner's zone, as in CalendarView.test.tsx.
const local = (day: number, hour = 0): Date => new Date(2026, 7, day, hour)
const entry = (day: number, start: number, end: number | null): GapEntry => ({
  started_at: local(day, start).toISOString(),
  stopped_at: end === null ? null : local(day, end).toISOString()
})
function grouped(entries: GapEntry[]): Map<string, GapEntry[]> {
  const result = new Map<string, GapEntry[]>()
  for (const row of entries) {
    const key = localDateKey(new Date(row.started_at))
    result.set(key, [...(result.get(key) ?? []), row])
  }
  return result
}
const gap = (start: number, end: number): { startMs: number; endMs: number } => ({
  startMs: local(10, start).getTime(),
  endMs: local(10, end).getTime()
})

describe('dayGaps', () => {
  it('uses own entries for eligibility and returns gaps in time order', () => {
    expect(
      dayGaps(grouped([entry(10, 9, 10)]), local(10), local(17, 12), DEFAULT_WORKING_HOURS)
    ).toEqual([gap(8, 9), gap(10, 18)])
  })

  it.each([
    ['no own entries', 10, []],
    ['only a running carryover', 10, [entry(9, 23, null)]],
    ['only a stopped carryover', 10, [entry(9, 23, 33)]],
    ['weekend', 15, [entry(15, 9, 10)]],
    ['future day', 18, [entry(18, 9, 10)]]
  ])('returns no gaps for %s', (_label, day, entries) => {
    expect(dayGaps(grouped(entries), local(day), local(17, 12), DEFAULT_WORKING_HOURS)).toEqual([])
  })

  it('adds stopped carryover coverage only when the day has own entries', () => {
    expect(
      dayGaps(
        grouped([entry(9, 23, 33), entry(10, 10, 18)]),
        local(10),
        local(17, 12),
        DEFAULT_WORKING_HOURS
      )
    ).toEqual([gap(9, 10)])
  })

  it('adds running carryover coverage', () => {
    expect(
      dayGaps(
        grouped([entry(9, 23, null), entry(10, 10, 18)]),
        local(10),
        local(17, 12),
        DEFAULT_WORKING_HOURS
      )
    ).toEqual([])
  })

  it('caps today at now, including when the selected date has a time of day', () => {
    expect(
      dayGaps(
        grouped([entry(9, 23, 33), entry(10, 10, 11)]),
        local(10, 12),
        local(10, 12),
        DEFAULT_WORKING_HOURS
      )
    ).toEqual([gap(9, 10), gap(11, 12)])
  })
})
