import { describe, expect, it } from 'vitest'
import type { Entry } from './types'
import { entryBilledMinutes, entryRounds, entryShownSeconds } from './entryMoney'

const T0 = Date.UTC(2026, 9, 21, 9, 0, 0)
function row(over: Partial<Entry>): Entry {
  return {
    id: 1,
    client_id: 1,
    description: '',
    started_at: new Date(T0).toISOString(),
    stopped_at: new Date(T0 + 5 * 60000).toISOString(),
    heartbeat_at: null,
    rounded_min: null,
    deleted_at: null,
    created_at: new Date(T0).toISOString(),
    link_id: null,
    tags: '',
    reference: '',
    billable: 1,
    private_note: '',
    ...over
  }
}

describe('entryMoney', () => {
  it('a row rounds when its interval or its minimum unit is above 0', () => {
    expect(entryRounds(row({ interval_min: 15 }))).toBe(true)
    expect(entryRounds(row({ min_unit_min: 15 }))).toBe(true)
    expect(entryRounds(row({ interval_min: 0, min_unit_min: 0 }))).toBe(false)
    expect(entryRounds(row({}))).toBe(false)
  })

  it('a finished row takes the billed minutes from the view, it computes nothing', () => {
    // The stored value wins over what the profile values would give.
    const e = row({ interval_min: 15, billed_minutes: 45 })
    expect(entryBilledMinutes(e, T0 + 999 * 60000)).toBe(45)
  })

  it('a row that does not round has no billed minutes to show', () => {
    expect(entryBilledMinutes(row({ interval_min: 0, billed_minutes: 5 }), T0)).toBeNull()
  })

  it('a running row ticks by the rule: minimum unit lifts, interval rounds up', () => {
    const running = (over: Partial<Entry>): Entry => row({ stopped_at: null, ...over })
    // 3 minutes in with a 15-minute minimum unit and no interval.
    expect(entryBilledMinutes(running({ min_unit_min: 15 }), T0 + 3 * 60000)).toBe(15)
    // 16 minutes in with a 15-minute interval: next multiple.
    expect(entryBilledMinutes(running({ interval_min: 15 }), T0 + 16 * 60000)).toBe(30)
    // A few seconds count as one minute, never 0.
    expect(entryBilledMinutes(running({ interval_min: 5 }), T0 + 4000)).toBe(5)
  })

  it('shown seconds: billed when rounding, raw otherwise', () => {
    expect(entryShownSeconds(row({ interval_min: 15, billed_minutes: 15 }), T0)).toBe(900)
    expect(entryShownSeconds(row({ interval_min: 0 }), T0)).toBe(300)
  })
})
