/**
 * One start modal per window (owner pre-review, PR 2): the header key and the
 * START key open the same modal in App, both prefilled with the last used
 * client + project (B6). The store resolves the prefill when it opens.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { useStartTimerModalStore } from './startTimerModalStore'
import { useTimerStore } from './timerStore'
import type { Client, Entry } from '../../../shared/types'

const client = (id: number, active: 0 | 1): Client => ({
  id,
  name: `C${id}`,
  color: '#000000',
  active,
  rate_cent: 0,
  created_at: ''
})

function entry(clientId: number, projectId: number | null): Entry {
  return {
    id: 1,
    client_id: clientId,
    project_id: projectId,
    description: '',
    started_at: '2026-10-22T08:00:00.000Z',
    stopped_at: '2026-10-22T09:00:00.000Z',
    heartbeat_at: null,
    rounded_min: null,
    deleted_at: null,
    created_at: '',
    link_id: null,
    tags: '',
    reference: '',
    billable: 1,
    private_note: ''
  }
}

function mockSummary(recent: Entry[]): void {
  ;(window as unknown as { api: unknown }).api = {
    dashboard: {
      summary: vi.fn(async () => ({ ok: true as const, data: { recentEntries: recent } }))
    }
  }
}

afterEach(() => {
  useStartTimerModalStore.setState({ open: false, prefill: null })
})

describe('startTimerModalStore', () => {
  it('opens with the last entry as prefill', async () => {
    useTimerStore.setState({ clients: [client(2, 1)] })
    mockSummary([entry(2, 8)])
    await useStartTimerModalStore.getState().openStart()
    expect(useStartTimerModalStore.getState()).toMatchObject({
      open: true,
      prefill: { clientId: 2, projectId: 8 }
    })
  })

  it('keeps "no project" as an explicit null', async () => {
    useTimerStore.setState({ clients: [client(3, 1)] })
    mockSummary([entry(3, null)])
    await useStartTimerModalStore.getState().openStart()
    expect(useStartTimerModalStore.getState().prefill).toEqual({ clientId: 3, projectId: null })
  })

  it('opens without prefill when the last client is archived or there is no entry', async () => {
    useTimerStore.setState({ clients: [client(4, 0)] })
    mockSummary([entry(4, null)])
    await useStartTimerModalStore.getState().openStart()
    expect(useStartTimerModalStore.getState()).toMatchObject({ open: true, prefill: null })

    useStartTimerModalStore.getState().close()
    mockSummary([])
    await useStartTimerModalStore.getState().openStart()
    expect(useStartTimerModalStore.getState()).toMatchObject({ open: true, prefill: null })
  })

  it('close() closes', async () => {
    useTimerStore.setState({ clients: [] })
    mockSummary([])
    await useStartTimerModalStore.getState().openStart()
    useStartTimerModalStore.getState().close()
    expect(useStartTimerModalStore.getState().open).toBe(false)
  })
})
