/**
 * The two halves of an entry across midnight share one `id` (2.0). Rows that
 * show both next to each other must key them by `id` + `segment_seq`, or React
 * warns about duplicate keys and may drop or reuse a row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { Entry } from '../../../../shared/types'
import { entryRowKey } from '../../../../shared/entryKey'
import { MiniDayScale } from './MiniDayScale'
import { monthRange } from './monthScale'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function half(seq: number, started_at: string, stopped_at: string): Entry {
  return {
    id: 7,
    client_id: 1,
    description: 'Nachtschicht',
    started_at,
    stopped_at,
    heartbeat_at: null,
    rounded_min: null,
    deleted_at: null,
    created_at: started_at,
    link_id: null,
    tags: '',
    reference: '',
    billable: 1,
    private_note: '',
    project_id: null,
    segment_seq: seq
  }
}

describe('keys of segment rows (2.0 P3)', () => {
  it('tells the two halves of a midnight entry apart', () => {
    const a = half(0, '2026-06-20T20:00:00.000Z', '2026-06-20T22:00:00.000Z')
    const b = half(1, '2026-06-20T22:00:00.000Z', '2026-06-21T02:00:00.000Z')
    expect(entryRowKey(a)).not.toBe(entryRowKey(b))
    expect(entryRowKey({ id: 7 })).toBe(entryRowKey({ id: 7, segment_seq: 0 }))
  })

  it('renders two segments with one id without a duplicate-key warning', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const nowMs = Date.parse('2026-06-30T00:00:00.000Z')
    const entries = [
      half(0, '2026-06-20T20:00:00.000Z', '2026-06-20T22:00:00.000Z'),
      half(1, '2026-06-20T22:00:00.000Z', '2026-06-21T02:00:00.000Z')
    ]
    const { getAllByTestId } = render(
      <MiniDayScale
        entries={entries}
        range={monthRange(entries, new Date(2026, 5, 1), nowMs)}
        nowMs={nowMs}
        isToday={false}
        projectsById={new Map()}
        clientsById={new Map()}
      />
    )
    expect(getAllByTestId('mini-bar')).toHaveLength(2)
    const keyWarnings = error.mock.calls.filter((c) => String(c[0]).includes('same key'))
    expect(keyWarnings).toEqual([])
  })
})
