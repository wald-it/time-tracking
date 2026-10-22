import { describe, expect, it } from 'vitest'
import type { Client, Entry, Project } from '../../../../shared/types'
import { dayRevenueCent } from './dayRevenue'

const at = (h: number, m = 0, s = 0): number => new Date(2026, 9, 21, h, m, s, 0).getTime()
const iso = (ms: number): string => new Date(ms).toISOString()

const CLIENT: Client = {
  id: 1,
  name: 'Acme',
  color: '#123456',
  active: 1,
  rate_cent: 6000, // 60 €/h = 1 € per minute
  created_at: '2026-01-01T00:00:00.000Z'
}

function project(id: number, rate: number | null): Project {
  return {
    id,
    client_id: 1,
    name: `P${id}`,
    color: '',
    rate_cent: rate,
    active: 1,
    created_at: '2026-01-01T00:00:00.000Z'
  }
}

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
  it('bills the client rate per started minute', () => {
    // 10:00:00–10:07:01 is 7 min 1 s, billed as 8 minutes.
    const e = entry(at(10), at(10, 7, 1))
    expect(dayRevenueCent([e], [CLIENT], [], 0, at(12))).toBe(800)
  })

  it('rounds each entry up to the step, not the day total', () => {
    // Two 5-minute entries at a 15-minute step: 15 + 15, not 15 for 10 min.
    const a = entry(at(9), at(9, 5))
    const b = entry(at(11), at(11, 5))
    expect(dayRevenueCent([a, b], [CLIENT], [], 15, at(12))).toBe(3000)
  })

  it('a project rate of 0 is goodwill and never falls back to the client rate', () => {
    const e = entry(at(9), at(10), { project_id: 8 })
    expect(dayRevenueCent([e], [CLIENT], [project(8, 0)], 0, at(12))).toBe(0)
  })

  it('a project without a rate inherits the client rate; one with a rate wins', () => {
    const inherit = entry(at(9), at(10), { project_id: 8 })
    const own = entry(at(10), at(11), { project_id: 9 })
    const projects = [project(8, null), project(9, 12000)]
    expect(dayRevenueCent([inherit, own], [CLIENT], projects, 0, at(12))).toBe(6000 + 12000)
  })

  it('leaves non-billable entries out', () => {
    const e = entry(at(9), at(10), { billable: 0 })
    expect(dayRevenueCent([e], [CLIENT], [], 0, at(12))).toBe(0)
  })

  it('counts a running entry up to now', () => {
    const e = entry(at(9), null)
    expect(dayRevenueCent([e], [CLIENT], [], 0, at(9, 30))).toBe(3000)
  })
})
