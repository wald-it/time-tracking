import { describe, expect, it } from 'vitest'
import { todayGaps } from './todayGaps'
import { DEFAULT_WORKING_HOURS } from '../../../../shared/workingHours'
import type { GapEntry } from '../../../../shared/gaps'

// Local dates, as in SummaryColumn.unexplained.test.tsx; no runtime TZ mutation.
const local = (day: number, hour: number): Date => new Date(2026, 7, day, hour)
const entry = (day: number, start: number, end: number | null): GapEntry => ({
  started_at: local(day, start).toISOString(),
  stopped_at: end === null ? null : local(day, end).toISOString()
})
const gap = (start: number, end: number): { startMs: number; endMs: number } => ({
  startMs: local(10, start).getTime(),
  endMs: local(10, end).getTime()
})

describe('todayGaps', () => {
  it('uses own entries for eligibility and includes the leading and trailing gaps', () => {
    expect(todayGaps([entry(10, 9, 10)], local(10, 12), DEFAULT_WORKING_HOURS)).toEqual([
      gap(8, 9),
      gap(10, 12)
    ])
  })

  it.each([
    ['no entries', 10, []],
    ['weekend', 15, [entry(15, 9, 10)]],
    ['fully covered', 10, [entry(10, 8, 12)]],
    ['only a running carryover', 10, [entry(9, 23, null)]],
    [
      'only a stopped carryover',
      10,
      [{ started_at: local(9, 23).toISOString(), stopped_at: local(10, 9).toISOString() }]
    ]
  ])('returns no gaps for %s', (_label, day, entries) => {
    expect(todayGaps(entries, local(day, 12), DEFAULT_WORKING_HOURS)).toEqual([])
  })

  it('uses a stopped carryover only as coverage when today has an own entry', () => {
    const carryover = {
      started_at: local(9, 23).toISOString(),
      stopped_at: local(10, 9).toISOString()
    }
    expect(todayGaps([carryover, entry(10, 10, 11)], local(10, 12), DEFAULT_WORKING_HOURS)).toEqual(
      [gap(9, 10), gap(11, 12)]
    )
  })

  it('uses a running carryover as coverage when today has an own entry', () => {
    expect(
      todayGaps([entry(9, 23, null), entry(10, 10, 11)], local(10, 12), DEFAULT_WORKING_HOURS)
    ).toEqual([])
  })

  it('keeps older carryovers outside the existing yesterday-only policy', () => {
    expect(
      todayGaps([entry(8, 23, null), entry(10, 9, 10)], local(10, 12), DEFAULT_WORKING_HOURS)
    ).toEqual([gap(8, 9), gap(10, 12)])
  })

  it('uses the configured window and caps its end at now or the window end', () => {
    const hours = { start: '10:00', end: '16:00', days: [1] }
    expect(todayGaps([entry(10, 10, 11)], local(10, 12), hours)).toEqual([gap(11, 12)])
    expect(todayGaps([entry(10, 10, 11)], local(10, 19), hours)).toEqual([gap(11, 16)])
  })
})
