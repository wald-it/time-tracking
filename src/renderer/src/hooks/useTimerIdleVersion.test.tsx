/**
 * #494: the two older idle paths, "Beim Leerlauf stoppen" (`idleStopAtIdle`)
 * and "Als Pause markieren" (`idleMarkPause`), must bump the entries version
 * after a committed stop. The Calendar reloads only on that version, so
 * without it an open Calendar keeps the stopped entry as running and misses
 * the Pause entry. The fourth key (`idleWorkFor`, #492) already does this;
 * useTimerIdleWork.test.tsx pins it there.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'
import { act, cleanup, renderHook, waitFor, type RenderHookResult } from '@testing-library/react'
import type { Entry, IpcResult } from '../../../shared/types'
import type { UseTimerResult } from './useTimer'

const previousTz = process.env.TZ
let now: Date
let idleSince: string
let running: Entry
let pause: Entry
beforeAll(() => {
  process.env.TZ = 'Europe/Berlin'
  now = new Date(2026, 10, 2, 12)
  idleSince = new Date(2026, 10, 2, 11, 30).toISOString()
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
  pause = {
    ...running,
    id: 2,
    description: 'Pause',
    started_at: idleSince,
    stopped_at: now.toISOString(),
    billable: 0
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
  }
  useEntriesStore: typeof import('../store/entriesStore').useEntriesStore
}

async function setup(): Promise<Setup> {
  vi.resetModules()
  const { useTimer } = await import('./useTimer')
  const { useTimerStore } = await import('../store/timerStore')
  const { useEntriesStore } = await import('../store/entriesStore')
  const api = {
    clients: { getAll: async () => ({ ok: true as const, data: [] }) },
    entries: {
      getRunning: async () => ({ ok: true as const, data: running }),
      stopAt: vi.fn(
        async (): Promise<IpcResult<Entry>> => ({
          ok: true,
          data: { ...running, stopped_at: idleSince }
        })
      ),
      create: vi.fn(async (): Promise<IpcResult<Entry>> => ({ ok: true, data: pause }))
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
      idleEvent: { idleSince, idleSeconds: 1800 },
      description: 'Original work'
    })
  )
  return { hook, api, useEntriesStore }
}

describe('idle stop paths bump the entries version (#494)', () => {
  it('"Beim Leerlauf stoppen": the version rises after the stop', async () => {
    const { hook, api, useEntriesStore } = await setup()
    const versionBefore = useEntriesStore.getState().version
    await act(async () => {
      await hook.result.current.idleStopAtIdle()
    })
    expect(api.entries.stopAt).toHaveBeenCalledExactlyOnceWith(1, idleSince)
    expect(hook.result.current.runningEntry).toBeNull()
    expect(useEntriesStore.getState().version).toBeGreaterThan(versionBefore)
  })

  it('"Beim Leerlauf stoppen": a refused stop leaves the version as it was', async () => {
    const { hook, api, useEntriesStore } = await setup()
    api.entries.stopAt.mockResolvedValue({ ok: false, error: 'Cannot stop' })
    const versionBefore = useEntriesStore.getState().version
    await act(async () => {
      await hook.result.current.idleStopAtIdle()
    })
    expect(hook.result.current.runningEntry).toEqual(running)
    expect(useEntriesStore.getState().version).toBe(versionBefore)
  })

  it('"Als Pause markieren": the version rises after the pause is booked', async () => {
    const { hook, api, useEntriesStore } = await setup()
    const versionBefore = useEntriesStore.getState().version
    // A reload triggered before the pause exists would miss it in the Calendar.
    let createCallsAtBump = -1
    const off = useEntriesStore.subscribe((state, previous) => {
      if (state.version !== previous.version && createCallsAtBump === -1)
        createCallsAtBump = api.entries.create.mock.calls.length
    })
    await act(async () => {
      await hook.result.current.idleMarkPause()
    })
    off()
    expect(api.entries.create).toHaveBeenCalledTimes(1)
    expect(createCallsAtBump).toBe(1)
    expect(hook.result.current.runningEntry).toBeNull()
    expect(useEntriesStore.getState().version).toBeGreaterThan(versionBefore)
  })

  it.each(['refusal', 'rejection'])(
    '"Als Pause markieren": the version rises on a pause %s, since the stop committed',
    async (failure) => {
      const { hook, api, useEntriesStore } = await setup()
      if (failure === 'refusal')
        api.entries.create.mockResolvedValue({ ok: false, error: 'Cannot book' })
      else api.entries.create.mockRejectedValue(new Error('IPC unavailable'))
      const versionBefore = useEntriesStore.getState().version
      await act(async () => {
        const result = hook.result.current.idleMarkPause()
        if (failure === 'rejection') await expect(result).rejects.toThrow('IPC unavailable')
        else await result
      })
      expect(api.entries.stopAt).toHaveBeenCalledTimes(1)
      expect(useEntriesStore.getState().version).toBeGreaterThan(versionBefore)
    }
  )

  it('"Als Pause markieren": a refused stop books nothing and leaves the version', async () => {
    const { hook, api, useEntriesStore } = await setup()
    api.entries.stopAt.mockResolvedValue({ ok: false, error: 'Cannot stop' })
    const versionBefore = useEntriesStore.getState().version
    await act(async () => {
      await hook.result.current.idleMarkPause()
    })
    expect(api.entries.create).not.toHaveBeenCalled()
    expect(hook.result.current.runningEntry).toEqual(running)
    expect(useEntriesStore.getState().version).toBe(versionBefore)
  })
})
