import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'
import { act, cleanup, renderHook, waitFor, type RenderHookResult } from '@testing-library/react'
import type { Entry, IpcResult } from '../../../shared/types'
import type { UseTimerResult } from './useTimer'

const previousTz = process.env.TZ
let now: Date
let boundary: string
let running: Entry
let booked: Entry
beforeAll(() => {
  process.env.TZ = 'Europe/Berlin'
  now = new Date(2026, 10, 2, 12)
  boundary = new Date(2026, 10, 2, 11, 23, 45, 678).toISOString()
  running = {
    id: 1,
    client_id: 1,
    project_id: null,
    description: 'Original work',
    started_at: new Date(2026, 10, 2, 10).toISOString(),
    stopped_at: null,
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
  booked = {
    ...running,
    id: 2,
    client_id: 2,
    project_id: 20,
    description: '',
    started_at: boundary,
    stopped_at: now.toISOString()
  }
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

interface Setup {
  hook: RenderHookResult<UseTimerResult, unknown>
  api: {
    entries: {
      stopAt: Mock<() => Promise<IpcResult<Entry>>>
      create: Mock<() => Promise<IpcResult<Entry>>>
    }
    tray: { update: Mock }
    idle: { dismiss: Mock }
  }
  useToastStore: typeof import('../store/toastStore').useToastStore
}

async function setup(): Promise<Setup> {
  vi.resetModules()
  const { useTimer } = await import('./useTimer')
  const { useTimerStore } = await import('../store/timerStore')
  const { useToastStore } = await import('../store/toastStore')
  const api = {
    clients: { getAll: async () => ({ ok: true as const, data: [] }) },
    entries: {
      getRunning: async () => ({ ok: true as const, data: running }),
      stopAt: vi.fn(
        async (): Promise<IpcResult<Entry>> => ({
          ok: true,
          data: { ...running, stopped_at: boundary }
        })
      ),
      create: vi.fn(async (): Promise<IpcResult<Entry>> => ({ ok: true, data: booked }))
    },
    dashboard: { todayTotal: async () => ({ ok: true as const, data: 3600 }) },
    tray: { update: vi.fn() },
    idle: { dismiss: vi.fn() },
    onHotkeyToggle: () => {},
    onTrayQuickStart: () => {},
    onTrayStop: () => {},
    onDataChanged: () => {},
    onIdleDetected: () => {}
  }
  ;(window as unknown as { api: typeof api }).api = api
  const hook = renderHook(() => useTimer())
  await waitFor(() => expect(hook.result.current.runningEntry?.id).toBe(1))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  act(() =>
    useTimerStore.setState({
      idleEvent: { idleSince: boundary, idleSeconds: 2174 },
      description: 'Original work'
    })
  )
  api.tray.update.mockClear()
  return { hook, api, useToastStore }
}

describe('idle work booking', () => {
  it.each([20, null, undefined])(
    'stops then creates at the same instant, with project %s, and prompts for the new entry',
    async (projectId) => {
      const { hook, api } = await setup()
      const { useEntriesStore } = await import('../store/entriesStore')
      const versionBefore = useEntriesStore.getState().version
      await act(async () => {
        await hook.result.current.idleWorkFor(2, projectId)
      })
      // The Calendar reloads only on the entries version.
      expect(useEntriesStore.getState().version).toBeGreaterThan(versionBefore)
      expect(api.entries.stopAt).toHaveBeenCalledExactlyOnceWith(1, boundary)
      expect(api.entries.create).toHaveBeenCalledExactlyOnceWith({
        client_id: 2,
        project_id: projectId ?? null,
        description: '',
        started_at: boundary,
        stopped_at: now.toISOString(),
        source: 'idle'
      })
      expect(api.entries.stopAt.mock.invocationCallOrder[0]).toBeLessThan(
        api.entries.create.mock.invocationCallOrder[0]
      )
      expect(hook.result.current.runningEntry).toBeNull()
      expect(hook.result.current.description).toBe('')
      expect(api.tray.update).toHaveBeenCalledExactlyOnceWith(false, '', 3600, null)
      expect(hook.result.current.quickNoteEntry).toEqual(booked)
      expect(hook.result.current.idleEvent).toBeNull()
      expect(api.idle.dismiss).toHaveBeenCalledTimes(1)
      expect(hook.result.current.isLoading).toBe(false)
    }
  )

  it.each(['refusal', 'rejection'])(
    'keeps the timer stopped and reports createFailed on create %s',
    async (failure) => {
      const { hook, api } = await setup()
      const { useEntriesStore } = await import('../store/entriesStore')
      const versionBefore = useEntriesStore.getState().version
      if (failure === 'refusal')
        api.entries.create.mockResolvedValue({ ok: false, error: 'Cannot book' })
      else api.entries.create.mockRejectedValue(new Error('IPC unavailable'))
      let result: string | null = null
      await act(async () => {
        result = await hook.result.current.idleWorkFor(2)
      })
      expect(result).toBe('createFailed')
      // The stop committed, so the views must reload even though the booking failed.
      expect(useEntriesStore.getState().version).toBeGreaterThan(versionBefore)
      expect(hook.result.current.runningEntry).toBeNull()
      expect(hook.result.current.description).toBe('')
      expect(hook.result.current.quickNoteEntry).toBeNull()
      expect(hook.result.current.idleEvent).toBeNull()
      expect(hook.result.current.isLoading).toBe(false)
      expect(api.tray.update).toHaveBeenCalledExactlyOnceWith(false, '', 3600, null)
      expect(api.idle.dismiss).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['refusal', 'rejection'])(
    'keeps the dialog and running entry on stopAt %s without creating',
    async (failure) => {
      const { hook, api } = await setup()
      const { useEntriesStore } = await import('../store/entriesStore')
      const versionBefore = useEntriesStore.getState().version
      if (failure === 'refusal')
        api.entries.stopAt.mockResolvedValue({ ok: false, error: 'Cannot stop' })
      else api.entries.stopAt.mockRejectedValue(new Error('IPC unavailable'))
      await act(async () => {
        const result = hook.result.current.idleWorkFor(2)
        if (failure === 'rejection') await expect(result).rejects.toThrow('IPC unavailable')
        else await result
      })
      expect(api.entries.create).not.toHaveBeenCalled()
      expect(hook.result.current.runningEntry).toEqual(running)
      expect(hook.result.current.idleEvent?.idleSince).toBe(boundary)
      expect(hook.result.current.quickNoteEntry).toBeNull()
      expect(hook.result.current.isLoading).toBe(false)
      expect(api.idle.dismiss).not.toHaveBeenCalled()
      expect(api.tray.update).not.toHaveBeenCalled()
    }
  )

  it('ignores a double click during both pending calls and after completion', async () => {
    const { hook, api } = await setup()
    let releaseStop!: (value: IpcResult<Entry>) => void
    let releaseCreate!: (value: IpcResult<Entry>) => void
    api.entries.stopAt.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseStop = resolve
        })
    )
    api.entries.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCreate = resolve
        })
    )
    let booking!: Promise<unknown>
    act(() => {
      booking = hook.result.current.idleWorkFor(2)
    })
    expect(hook.result.current.isLoading).toBe(true)
    await act(async () => {
      await hook.result.current.idleWorkFor(2)
    })
    await act(async () => {
      releaseStop({ ok: true, data: running })
    })
    expect(hook.result.current.isLoading).toBe(true)
    await act(async () => {
      await hook.result.current.idleWorkFor(2)
    })
    await act(async () => {
      releaseCreate({ ok: true, data: booked })
      await booking
    })
    await act(async () => {
      await hook.result.current.idleWorkFor(2)
    })
    expect(api.entries.stopAt).toHaveBeenCalledTimes(1)
    expect(api.entries.create).toHaveBeenCalledTimes(1)
  })
})
