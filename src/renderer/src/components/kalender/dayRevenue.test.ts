import { describe, expect, it } from 'vitest'
import type { Entry } from '../../../../shared/types'
import { dayBilledSeconds, dayRevenueCent } from './dayRevenue'

const at = (h: number, m = 0, s = 0): number => new Date(2026, 9, 21, h, m, s, 0).getTime()
const iso = (ms: number): string => new Date(ms).toISOString()

let nextId = 1
function entry(start: number, stop: number | null, over: Partial<Entry> = {}): Entry {
  return {
    id: nextId++,
    client_id: 1,
    description: '',
    started_at: iso(start),
    stopped_at: stop === null ? null : iso(stop),
    heartbeat_at: null,
    rounded_min: null,
    deleted_at: null,
    created_at: iso(start),
    link_id: null,
    tags: '',
    reference: '',
    billable: 1,
    private_note: '',
    project_id: null,
    ...over
  }
}

describe('dayRevenueCent', () => {
  it('adds up the fee of the rows as the view delivers it', () => {
    const a = entry(at(9), at(10), { billed_minutes: 60, rate_cent: 6000, fee_cent: 6000 })
    const b = entry(at(11), at(11, 5), { billed_minutes: 15, rate_cent: 12000, fee_cent: 3000 })
    expect(dayRevenueCent([a, b])).toBe(9000)
  })

  it('a goodwill row (fee 0) adds nothing', () => {
    const e = entry(at(9), at(10), { billed_minutes: 60, rate_cent: 0, fee_cent: 0 })
    expect(dayRevenueCent([e])).toBe(0)
  })

  it('leaves non-billable entries out', () => {
    const e = entry(at(9), at(10), {
      billable: 0,
      billed_minutes: 60,
      rate_cent: 6000,
      fee_cent: 6000
    })
    expect(dayRevenueCent([e])).toBe(0)
  })

  it('a running entry has no fee until it is stopped and adds nothing', () => {
    const e = entry(at(9), null, { billed_minutes: 30, rate_cent: null, fee_cent: null })
    expect(dayRevenueCent([e])).toBe(0)
  })
})

describe('dayBilledSeconds', () => {
  it('shows the billed minutes of a row whose profile rounds', () => {
    // 5 minutes at a 15-minute step: the view says 15.
    const e = entry(at(9), at(9, 5), { billed_minutes: 15, interval_min: 15, min_unit_min: 0 })
    expect(dayBilledSeconds([e], at(12))).toBe(15 * 60)
  })

  it('shows the raw time when the profile does not round', () => {
    const e = entry(at(9), at(9, 5, 30), { billed_minutes: 6, interval_min: 0, min_unit_min: 0 })
    expect(dayBilledSeconds([e], at(12))).toBe(5 * 60 + 30)
  })

  it('ticks a running row by the rule with the profile of the row', () => {
    // 7 minutes in, 15-minute minimum unit: 15 billed.
    const e = entry(at(9), null, { billed_minutes: 15, interval_min: 0, min_unit_min: 15 })
    expect(dayBilledSeconds([e], at(9, 7))).toBe(15 * 60)
    // 16 minutes in: the minimum no longer lifts it.
    expect(dayBilledSeconds([e], at(9, 16))).toBe(16 * 60)
  })
})
