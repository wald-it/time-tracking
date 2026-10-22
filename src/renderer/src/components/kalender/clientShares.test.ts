import { describe, expect, it } from 'vitest'
import type { Client, Entry } from '../../../../shared/types'
import { clientShares, entrySeconds } from './clientShares'

const at = (day: number, h: number, m = 0): number => new Date(2026, 9, day, h, m, 0, 0).getTime()
const iso = (ms: number): string => new Date(ms).toISOString()

function client(id: number, name: string, color = '#123456'): Client {
  return { id, name, color, active: 1, rate_cent: 0, created_at: '2026-01-01T00:00:00.000Z' }
}

let nextId = 1
function entry(clientId: number, start: number, stop: number | null): Entry {
  return {
    id: nextId++,
    client_id: clientId,
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
    project_id: null
  }
}

const CLIENTS = [client(1, 'Acme'), client(2, 'Brandt'), client(3, 'Kessler', '')]

describe('entrySeconds', () => {
  it('measures a completed entry from start to stop', () => {
    expect(entrySeconds(entry(1, at(21, 9), at(21, 10, 30)), at(22, 12))).toBe(5400)
  })

  it('measures a running entry up to nowMs', () => {
    expect(entrySeconds(entry(1, at(22, 9), null), at(22, 9, 45))).toBe(2700)
  })

  it('never goes negative', () => {
    expect(entrySeconds(entry(1, at(22, 10), null), at(22, 9))).toBe(0)
  })
})

describe('clientShares', () => {
  it('is empty without entries', () => {
    expect(clientShares([], CLIENTS, at(22, 12))).toEqual([])
  })

  it('groups by client and sorts by time, largest first', () => {
    const rows = clientShares(
      [
        entry(2, at(1, 9), at(1, 10)), // Brandt 1 h
        entry(1, at(2, 9), at(2, 11)), // Acme 2 h
        entry(1, at(3, 9), at(3, 10)), // Acme +1 h → 3 h
        entry(3, at(4, 9), at(4, 9, 30)) // Kessler 0.5 h
      ],
      CLIENTS,
      at(22, 12)
    )
    expect(rows.map((r) => [r.name, r.seconds])).toEqual([
      ['Acme', 3 * 3600],
      ['Brandt', 3600],
      ['Kessler', 1800]
    ])
  })

  it('share = part of the summed total, and the shares add up to 100', () => {
    const rows = clientShares(
      [entry(1, at(2, 9), at(2, 12)), entry(2, at(3, 9), at(3, 10))],
      CLIENTS,
      at(22, 12)
    )
    expect(rows.map((r) => r.sharePct)).toEqual([75, 25])
    expect(rows.reduce((s, r) => s + r.sharePct, 0)).toBeCloseTo(100)
  })

  it('counts a running entry up to nowMs, so the shares move with the clock', () => {
    const entries = [entry(1, at(20, 9), at(20, 10)), entry(2, at(22, 9), null)]
    const early = clientShares(entries, CLIENTS, at(22, 9, 30))
    const later = clientShares(entries, CLIENTS, at(22, 11))
    expect(early.map((r) => [r.name, r.seconds])).toEqual([
      ['Acme', 3600],
      ['Brandt', 1800]
    ])
    expect(later.map((r) => [r.name, r.seconds])).toEqual([
      ['Brandt', 7200],
      ['Acme', 3600]
    ])
  })

  it('breaks ties by name so the order is stable', () => {
    const rows = clientShares(
      [entry(2, at(1, 9), at(1, 10)), entry(1, at(2, 9), at(2, 10))],
      CLIENTS,
      at(22, 12)
    )
    expect(rows.map((r) => r.name)).toEqual(['Acme', 'Brandt'])
  })

  it('keeps an unknown client as its own row with no colour; an empty colour is null too', () => {
    const rows = clientShares(
      [entry(99, at(1, 9), at(1, 10)), entry(3, at(2, 9), at(2, 9, 30))],
      CLIENTS,
      at(22, 12)
    )
    expect(rows).toEqual([
      { clientId: 99, name: '', color: null, seconds: 3600, sharePct: (3600 / 5400) * 100 },
      { clientId: 3, name: 'Kessler', color: null, seconds: 1800, sharePct: (1800 / 5400) * 100 }
    ])
  })

  it('drops clients whose time is zero', () => {
    const rows = clientShares(
      [entry(1, at(1, 9), at(1, 10)), entry(2, at(2, 9), at(2, 9))],
      CLIENTS,
      at(22, 12)
    )
    expect(rows.map((r) => r.name)).toEqual(['Acme'])
  })
})
