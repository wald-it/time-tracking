import { describe, expect, it } from 'vitest'
import { todayGaps, unexplainedSinceMs, type GapEntry } from './gaps'
import { DEFAULT_WORKING_HOURS } from './workingHours'

const local = (hour: number, minute = 0, second = 0, day = 2): Date =>
  new Date(2026, 10, day, hour, minute, second)
const entry = (start: Date, end: Date | null): GapEntry => ({
  started_at: start.toISOString(),
  stopped_at: end?.toISOString() ?? null
})
const since = (entries: GapEntry[], now: Date, running = false): number | null =>
  unexplainedSinceMs(
    todayGaps(entries, now, DEFAULT_WORKING_HOURS),
    now,
    running,
    DEFAULT_WORKING_HOURS
  )

describe('unexplained since', () => {
  it('starts exactly five minutes after stopping', () => {
    const entries = [entry(local(9), local(13))]
    expect(since(entries, local(13, 4, 59))).toBeNull()
    expect(since(entries, local(13, 5))).toBe(local(13).getTime())
  })

  it('ends at the half-open working-window boundary', () => {
    const entries = [entry(local(9), local(13))]
    expect(since(entries, local(17, 59))).toBe(local(13).getTime())
    expect(since(entries, local(18))).toBeNull()
    expect(since(entries, local(19))).toBeNull()
  })

  it('requires an own entry, even with a carryover from yesterday', () => {
    expect(since([], local(11))).toBeNull()
    expect(since([entry(local(23, 0, 0, 1), local(9))], local(11))).toBeNull()
  })

  it('stays absent on a Saturday with entries', () => {
    expect(since([entry(local(9, 0, 0, 7), local(10, 0, 0, 7))], local(11, 0, 0, 7))).toBeNull()
  })

  it('uses the window start when the only entry ended before it', () => {
    expect(since([entry(local(6), local(7))], local(11))).toBe(local(8).getTime())
  })

  it('ignores trailing gaps while the timer runs', () => {
    expect(since([entry(local(9), local(10))], local(11), true)).toBeNull()
  })

  it('combines carryover coverage with an own entry', () => {
    const entries = [entry(local(23, 0, 0, 1), local(9)), entry(local(9), local(10))]
    expect(since(entries, local(11))).toBe(local(10).getTime())
  })

  it('does not use an internal gap while the current time is covered', () => {
    expect(since([entry(local(9), local(10)), entry(local(11), local(12))], local(12))).toBeNull()
  })
})
