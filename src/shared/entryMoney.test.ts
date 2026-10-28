import { describe, expect, it } from 'vitest'
import type { Entry } from './types'
import {
  entryBilledMinutes,
  entryRounds,
  entryShownSeconds,
  rowsBilledSeconds,
  uniformRoundingRule
} from './entryMoney'

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

describe('rowsBilledSeconds', () => {
  it('is undefined when no row rounds', () => {
    expect(rowsBilledSeconds([row({ interval_min: 0, billed_minutes: 5 })], T0)).toBeUndefined()
  })

  it('sums billed minutes throughout: a row without a profile counts its billed minutes, not raw seconds', () => {
    // 3:01 raw, no interval: billing_lines bills 4 minutes. Next to it 15 billed.
    const plain = row({
      stopped_at: new Date(T0 + 181_000).toISOString(),
      interval_min: 0,
      min_unit_min: 0,
      billed_minutes: 4
    })
    const rounded = row({ interval_min: 15, billed_minutes: 15 })
    expect(rowsBilledSeconds([plain, rounded], T0)).toBe(19 * 60)
  })

  it('a finished row without money columns next to a rounding row counts its time rounded up', () => {
    const bare = row({ stopped_at: new Date(T0 + 181_000).toISOString() })
    const rounded = row({ interval_min: 15, billed_minutes: 15 })
    expect(rowsBilledSeconds([bare, rounded], T0)).toBe(19 * 60)
  })

  it('a plain running row ticks to whole minutes', () => {
    const rounded = row({ interval_min: 15, billed_minutes: 15 })
    const live = row({ stopped_at: null, interval_min: 0, min_unit_min: 0 })
    expect(rowsBilledSeconds([rounded, live], T0 + 61_000)).toBe((15 + 2) * 60)
  })
})

describe('uniformRoundingRule', () => {
  it('names a pure minimum shared by all rows', () => {
    expect(
      uniformRoundingRule([
        { interval_min: 0, min_unit_min: 30 },
        { interval_min: 0, min_unit_min: 30 }
      ])
    ).toEqual({ kind: 'minimum', minutes: 30 })
  })

  it('names the interval when every row has the same interval and no minimum unit', () => {
    const a = row({ interval_min: 15, min_unit_min: 0 })
    expect(uniformRoundingRule([a, row({ interval_min: 15, min_unit_min: 0 })])).toEqual({
      kind: 'interval',
      minutes: 15
    })
  })

  it('names nothing for combined rules, mixed intervals, or a row without rounding', () => {
    expect(uniformRoundingRule([row({ interval_min: 15, min_unit_min: 30 })])).toBeNull()
    expect(uniformRoundingRule([row({ interval_min: 15 }), row({ interval_min: 10 })])).toBeNull()
    expect(uniformRoundingRule([row({ interval_min: 15 }), row({ interval_min: 0 })])).toBeNull()
    expect(uniformRoundingRule([row({ min_unit_min: 30 }), row({ min_unit_min: 15 })])).toBeNull()
    expect(uniformRoundingRule([row({ min_unit_min: 30 }), row({})])).toBeNull()
    expect(uniformRoundingRule([])).toBeNull()
  })
})
