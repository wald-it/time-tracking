/**
 * Characterization tests for useTimer (#167): timer start/stop and the idle
 * transitions. Written against the current implementation to pin observable
 * behavior — they are a safety net for future refactors, not a spec for new
 * behavior.
 *
 * The hook is built around module-level singletons (`initRan`,
 * `listenersInstalled`, the global listener refs — see #157): state that
 * survives unmounts by design. Each test therefore gets a fresh module
 * registry via `vi.resetModules()` + dynamic import, so init runs and the
 * IPC listeners register against that test's own `window.api` mock. Only
 * source modules re-evaluate; React itself is externalized and stays a
 * single instance.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, waitFor, renderHook, type RenderHookResult } from '@testing-library/react'
import type { Client, Entry, Project } from '../../../shared/types'
import type { UseTimerResult } from './useTimer'

// `globals` is off in vitest.config.ts, so Testing Library's auto-cleanup
// afterEach is never registered — unmount explicitly.
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function makeClient(over: Partial<Client> = {}): Client {
  return {
    id: 1,
    name: 'Acme',
    color: '#6366f1',
    active: 1,
    rate_cent: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

function makeEntry(over: Partial<Entry> = {}): Entry {
  return {
    id: 1,
    client_id: 1,
    description: '',
    started_at: '2026-08-26T08:00:00.000Z',
    stopped_at: null,
    heartbeat_at: null,
    rounded_min: null,
    deleted_at: null,
    created_at: '2026-08-26T08:00:00.000Z',
    link_id: null,
    tags: '',
    reference: '',
    billable: 1,
    private_note: '',
    project_id: null,
    ...over
  }
}

interface Listeners {
  hotkeyToggle?: () => void
  trayQuickStart?: (clientId: number) => void
  trayStop?: () => void
  dataChanged?: () => void
  idleDetected?: (data: { idleSince: string; idleSeconds: number }) => void
}

interface ApiMock {
  listeners: Listeners
  start: ReturnType<typeof vi.fn>
  switch: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  heartbeat: ReturnType<typeof vi.fn>
  trayUpdate: ReturnType<typeof vi.fn>
  idleDismiss: ReturnType<typeof vi.fn>
}

interface StartPayload {
  client_id: number
  project_id?: number | null
  description: string
  started_at: string
}

interface UpdatePayload {
  id: number
  client_id: number
  description: string
  started_at: string
  stopped_at: string
}

interface MockOpts {
  clients?: Client[]
  running?: Entry | null
  /** entries:switch answers { ok: false } — the main transaction rolled back. */
  switchFails?: boolean
  /**
   * dashboard:summary's recentEntries, newest first — the START dialog's and
   * the selection-less start's "last pair" (#297). Defaults to one entry of
   * client 1 without a project: the pair the old first-active-client
   * fallback also picked in every test that does not set this.
   */
  recent?: Entry[]
  /** projects:getAll — for the last pair's project (#297). Default: none. */
  projects?: Project[]
  /** projects:getAll answers { ok: false } (#297 review). */
  projectsFail?: boolean
  /** dashboard:summary waits for this before it answers (#297 review). */
  summaryGate?: Promise<void>
}

function mockApi(opts: MockOpts = {}): ApiMock {
  let nextId = 100
  const listeners: Listeners = {}
  // The entry the mocked main process considers running.
  let current: Entry | null = opts.running ?? null
  const start = vi.fn(async (payload: StartPayload) => {
    const entry = makeEntry({
      id: nextId++,
      client_id: payload.client_id,
      project_id: payload.project_id ?? null,
      description: payload.description,
      started_at: payload.started_at
    })
    current = entry
    return { ok: true as const, data: entry }
  })
  // entries:switch — the main process stops whatever runs and starts the new
  // entry at ONE instant (switchTimer); mirrored here on the mock's own state.
  const switchFn = vi.fn(async (payload: StartPayload) => {
    if (opts.switchFails) return { ok: false as const, error: 'boom' }
    const stopped = current ? { ...current, stopped_at: payload.started_at } : null
    current = makeEntry({
      id: nextId++,
      client_id: payload.client_id,
      project_id: payload.project_id ?? null,
      description: payload.description,
      started_at: payload.started_at
    })
    return { ok: true as const, data: { entry: current, stopped } }
  })
  const stop = vi.fn(async (id: number) => ({
    ok: true as const,
    data: makeEntry({ id, stopped_at: new Date().toISOString() })
  }))
  const update = vi.fn(async (payload: UpdatePayload) => ({
    ok: true as const,
    data: makeEntry(payload)
  }))
  // entries:create — a closed entry in one step (the idle pause, #298).
  const create = vi.fn(async (payload: UpdatePayload & { billable?: number }) => ({
    ok: true as const,
    data: makeEntry({ ...payload, id: nextId++ })
  }))
  const heartbeat = vi.fn(async () => ({ ok: true as const, data: undefined }))
  const trayUpdate = vi.fn()
  const idleDismiss = vi.fn()
  const api = {
    clients: {
      getAll: async () => ({ ok: true as const, data: opts.clients ?? [makeClient()] })
    },
    entries: {
      getRunning: async () => ({ ok: true as const, data: opts.running ?? null }),
      start,
      switch: switchFn,
      stop,
      update,
      create,
      heartbeat
    },
    dashboard: {
      todayTotal: async () => ({ ok: true as const, data: 0 }),
      summary: async () => {
        if (opts.summaryGate) await opts.summaryGate
        return {
          ok: true as const,
          data: {
            todaySeconds: 0,
            weekSeconds: 0,
            weekDaySeconds: [0, 0, 0, 0, 0, 0, 0],
            recentEntries: opts.recent ?? [makeEntry({ id: 1, client_id: 1, project_id: null })],
            todayEntries: [],
            topClients30d: []
          }
        }
      }
    },
    projects: {
      getAll: async ({ clientId }: { clientId?: number }) =>
        opts.projectsFail
          ? { ok: false as const, error: 'db busy' }
          : {
              ok: true as const,
              data: (opts.projects ?? []).filter(
                (p) => clientId == null || p.client_id === clientId
              )
            }
    },
    tray: { update: trayUpdate },
    idle: { dismiss: idleDismiss },
    onHotkeyToggle: (cb: () => void) => {
      listeners.hotkeyToggle = cb
    },
    onTrayQuickStart: (cb: (clientId: number) => void) => {
      listeners.trayQuickStart = cb
    },
    onTrayStop: (cb: () => void) => {
      listeners.trayStop = cb
    },
    onDataChanged: (cb: () => void) => {
      listeners.dataChanged = cb
    },
    onIdleDetected: (cb: (data: { idleSince: string; idleSeconds: number }) => void) => {
      listeners.idleDetected = cb
    }
  }
  ;(window as unknown as { api: typeof api }).api = api
  return {
    listeners,
    start,
    switch: switchFn,
    stop,
    update,
    create,
    heartbeat,
    trayUpdate,
    idleDismiss
  }
}

type Hook = RenderHookResult<UseTimerResult, unknown>

/**
 * Fresh module instance + fresh api mock, rendered and settled. Init always
 * ends in a tray push (running or not), so that is the "init done" signal.
 */
async function setup(opts: MockOpts = {}): Promise<{
  api: ApiMock
  hook: Hook
}> {
  vi.resetModules()
  const api = mockApi(opts)
  const { useTimer } = await import('./useTimer')
  // The hook under test owns the clock, as App does (one engine per window).
  const hook = renderHook(() => useTimer({ engine: true }))
  await waitFor(() => expect(api.trayUpdate).toHaveBeenCalled())
  return { api, hook }
}

async function startTimer(hook: Hook): Promise<Entry> {
  await act(async () => {
    await hook.result.current.start()
  })
  const entry = hook.result.current.runningEntry
  if (!entry) throw new Error('start() did not produce a running entry')
  return entry
}

const IDLE = { idleSince: '2026-08-26T09:30:00.000Z', idleSeconds: 300 }

describe('useTimer — start/stop', () => {
  it('adopts a running entry from the DB on launch', async () => {
    const running = makeEntry({
      id: 7,
      client_id: 1,
      description: 'ongoing work',
      started_at: new Date(Date.now() - 90_000).toISOString()
    })
    const { api, hook } = await setup({ running })

    await waitFor(() => expect(hook.result.current.runningEntry?.id).toBe(7))
    expect(hook.result.current.selectedClientId).toBe(1)
    expect(hook.result.current.description).toBe('ongoing work')
    expect(hook.result.current.elapsedSeconds).toBeGreaterThanOrEqual(90)
    expect(api.trayUpdate).toHaveBeenCalledWith(true, 'Acme', 0, running.started_at)
  })

  it('start() uses the selected client and pushes the running state to the tray', async () => {
    const clients = [makeClient({ id: 1, name: 'Acme' }), makeClient({ id: 2, name: 'Beta' })]
    const { api, hook } = await setup({ clients })

    act(() => hook.result.current.setSelectedClientId(2))
    await startTimer(hook)

    expect(api.start).toHaveBeenCalledWith({
      client_id: 2,
      project_id: undefined,
      description: '',
      started_at: expect.any(String)
    })
    expect(hook.result.current.runningEntry?.client_id).toBe(2)
    expect(api.trayUpdate).toHaveBeenLastCalledWith(
      true,
      'Beta',
      0,
      hook.result.current.runningEntry?.started_at
    )
  })

  // #297 replaces the first-active-client fallback: the hotkey and the mini
  // widget's play key start what the START dialog offers, the last pair.
  // Client 1 sorts first and is active, so the old rule would pick it.
  it('start() without a selection starts the last entry’s client and project', async () => {
    const clients = [makeClient({ id: 1, name: 'Acme' }), makeClient({ id: 2, name: 'Beta' })]
    const { api, hook } = await setup({
      clients,
      recent: [makeEntry({ id: 9, client_id: 2, project_id: 20 })],
      projects: [
        {
          id: 20,
          client_id: 2,
          name: 'Audit',
          color: '',
          rate_cent: null,
          active: 1,
          created_at: ''
        }
      ]
    })

    await startTimer(hook)

    expect(api.start).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: 2, project_id: 20 })
    )
    expect(hook.result.current.selectedClientId).toBe(2)
    expect(hook.result.current.selectedProjectId).toBe(20)
  })

  it('start() without a selection opens the START dialog when the last client is archived', async () => {
    const clients = [
      makeClient({ id: 1, name: 'Archived', active: 0 }),
      makeClient({ id: 2, name: 'Beta' })
    ]
    const { api, hook } = await setup({
      clients,
      recent: [makeEntry({ id: 9, client_id: 1 })]
    })
    // The module registry is fresh per setup(); take the store from it.
    const { useStartTimerModalStore } = await import('../store/startTimerModalStore')

    await act(async () => {
      await hook.result.current.start()
    })

    expect(api.start).not.toHaveBeenCalled()
    expect(hook.result.current.runningEntry).toBeNull()
    await waitFor(() => expect(useStartTimerModalStore.getState().open).toBe(true))
  })

  it('start() without a selection opens the START dialog when there is no entry yet', async () => {
    const { api, hook } = await setup({ recent: [] })
    const { useStartTimerModalStore } = await import('../store/startTimerModalStore')

    await act(async () => {
      await hook.result.current.start()
    })

    expect(api.start).not.toHaveBeenCalled()
    await waitFor(() => expect(useStartTimerModalStore.getState().open).toBe(true))
  })

  // #297 review: a selection left over from a client that is archived since
  // is not a choice the user can see (the selector lists active clients
  // only), so it must not be booked on.
  it('start() treats a selected archived client as no selection', async () => {
    const clients = [
      makeClient({ id: 1, name: 'Archived', active: 0 }),
      makeClient({ id: 2, name: 'Beta' })
    ]
    const { api, hook } = await setup({
      clients,
      recent: [makeEntry({ id: 9, client_id: 2 })]
    })
    act(() => hook.result.current.setSelectedClientId(1))

    await startTimer(hook)

    expect(api.start).toHaveBeenCalledTimes(1)
    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ client_id: 2 }))
  })

  // #297 review: the selection-less start awaits the last pair before it
  // knows a timer runs; a second press meanwhile must not switch away from
  // the entry the first one starts (that would leave a zero-length entry).
  it('a second start() while the first is still resolving does nothing', async () => {
    const { api, hook } = await setup()

    await act(async () => {
      await Promise.all([hook.result.current.start(), hook.result.current.start()])
    })

    expect(api.start).toHaveBeenCalledTimes(1)
    expect(api.switch).not.toHaveBeenCalled()
  })

  // #297 review 2: while the selection-less start resolves its pair, the
  // timer is busy — the dialog's start key and the switch path must wait,
  // or a choice confirmed meanwhile would be dropped or switch the new entry.
  it('is busy while the last pair resolves: a switch meanwhile is ignored', async () => {
    let release: () => void = () => {}
    const summaryGate = new Promise<void>((r) => (release = r))
    const { api, hook } = await setup({ summaryGate })

    let pending: Promise<string | null> = Promise.resolve(null)
    act(() => {
      pending = hook.result.current.start()
    })
    await waitFor(() => expect(hook.result.current.isLoading).toBe(true))
    let switched: string | null = 'unset'
    await act(async () => {
      switched = await hook.result.current.switchTo(2, null)
    })
    expect(switched).toBeNull()
    expect(api.switch).not.toHaveBeenCalled()

    await act(async () => {
      release()
      await pending
    })
    expect(api.start).toHaveBeenCalledTimes(1)
    expect(hook.result.current.isLoading).toBe(false)
  })

  // #297 review 3 / Codex: a quick-start key clicked while the hotkey's start
  // still resolves its pair wins; the fallback must not switch away from it.
  it('a quick start during the pair lookup is not switched away', async () => {
    let release: () => void = () => {}
    const summaryGate = new Promise<void>((r) => (release = r))
    const clients = [makeClient({ id: 1, name: 'Acme' }), makeClient({ id: 2, name: 'Beta' })]
    const { api, hook } = await setup({ clients, summaryGate })

    let pending: Promise<string | null> = Promise.resolve(null)
    act(() => {
      pending = hook.result.current.start()
    })
    await act(async () => {
      await hook.result.current.startWithClient(2, null)
    })
    await act(async () => {
      release()
      await pending
    })

    expect(api.start).toHaveBeenCalledTimes(1)
    expect(api.switch).not.toHaveBeenCalled()
    expect(hook.result.current.runningEntry?.client_id).toBe(2)
  })

  // #297 Codex follow-up: the quick start's reply may not be back when the
  // lookup finishes (runningEntry still empty); the fallback must yield as
  // soon as a newer start began, or main's switch replaces the user's choice.
  it('a quick start still in flight when the lookup finishes is not replaced', async () => {
    let release: () => void = () => {}
    const summaryGate = new Promise<void>((r) => (release = r))
    const clients = [makeClient({ id: 1, name: 'Acme' }), makeClient({ id: 2, name: 'Beta' })]
    const { api, hook } = await setup({ clients, summaryGate })
    let answerQuick: () => void = () => {}
    api.start.mockImplementationOnce(
      () =>
        new Promise((r) => {
          answerQuick = () => r({ ok: true as const, data: makeEntry({ id: 50, client_id: 2 }) })
        })
    )

    let pending: Promise<string | null> = Promise.resolve(null)
    let quick: Promise<string | null> = Promise.resolve(null)
    act(() => {
      pending = hook.result.current.start()
    })
    act(() => {
      quick = hook.result.current.startWithClient(2, null)
    })
    await act(async () => {
      release()
      await pending
    })
    await act(async () => {
      answerQuick()
      await quick
    })

    expect(api.start).toHaveBeenCalledTimes(1)
    expect(hook.result.current.runningEntry?.client_id).toBe(2)
  })

  // #297 Codex follow-up 2 (a): MCP or the Stream Deck started a timer during
  // the lookup. The renderer hears it as data:changed, but the resync's
  // getRunning reply is not back yet — the fallback must yield anyway, or
  // main's switch ends the externally started timer.
  it('yields to an external start announced during the lookup', async () => {
    let release: () => void = () => {}
    const summaryGate = new Promise<void>((r) => (release = r))
    const { api, hook } = await setup({ summaryGate })
    const entriesApi = (
      window as unknown as { api: { entries: { getRunning: () => Promise<unknown> } } }
    ).api.entries
    let answerRunning: () => void = () => {}
    entriesApi.getRunning = () =>
      new Promise((r) => {
        answerRunning = () => r({ ok: true as const, data: makeEntry({ id: 70, client_id: 2 }) })
      })

    let pending: Promise<string | null> = Promise.resolve(null)
    act(() => {
      pending = hook.result.current.start()
    })
    act(() => api.listeners.dataChanged?.())
    await act(async () => {
      release()
      await pending
    })

    expect(api.start).not.toHaveBeenCalled()
    await act(async () => {
      answerRunning()
    })
    await waitFor(() => expect(hook.result.current.runningEntry?.id).toBe(70))
  })

  // #297 Codex follow-up 2 (b): the lookup ending must not clear the busy
  // flag of a quick start whose reply is still out.
  it('leaves the busy flag to a quick start still in flight', async () => {
    let release: () => void = () => {}
    const summaryGate = new Promise<void>((r) => (release = r))
    const clients = [makeClient({ id: 1, name: 'Acme' }), makeClient({ id: 2, name: 'Beta' })]
    const { api, hook } = await setup({ clients, summaryGate })
    let answerQuick: () => void = () => {}
    api.start.mockImplementationOnce(
      () =>
        new Promise((r) => {
          answerQuick = () => r({ ok: true as const, data: makeEntry({ id: 50, client_id: 2 }) })
        })
    )

    let pending: Promise<string | null> = Promise.resolve(null)
    let quick: Promise<string | null> = Promise.resolve(null)
    act(() => {
      pending = hook.result.current.start()
    })
    act(() => {
      quick = hook.result.current.startWithClient(2, null)
    })
    await act(async () => {
      release()
      await pending
    })

    expect(hook.result.current.isLoading).toBe(true)
    await act(async () => {
      answerQuick()
      await quick
    })
    expect(hook.result.current.isLoading).toBe(false)
  })

  // #297 review 3: a running entry whose client was archived since leaves an
  // archived selection behind; a start without a valid selection must not
  // switch away from the running timer or clear its selection.
  it('does nothing without a valid selection while a timer runs', async () => {
    const clients = [
      makeClient({ id: 1, name: 'Archived', active: 0 }),
      makeClient({ id: 2, name: 'Beta' })
    ]
    const running = makeEntry({ id: 5, client_id: 1 })
    const { api, hook } = await setup({ clients, running })
    await waitFor(() => expect(hook.result.current.runningEntry?.id).toBe(5))
    act(() => hook.result.current.setSelectedClientId(1))

    await act(async () => {
      await hook.result.current.start()
    })

    expect(api.switch).not.toHaveBeenCalled()
    expect(api.start).not.toHaveBeenCalled()
    expect(hook.result.current.selectedClientId).toBe(1)
  })

  // #297 review 3: with the client list not loaded yet, the last pair is
  // read from the database's client list, not from the empty store.
  it('starts the last pair while the store has no client list yet', async () => {
    const { api, hook } = await setup()
    const { useTimerStore } = await import('../store/timerStore')
    act(() => useTimerStore.setState({ clients: [] }))

    await act(async () => {
      await hook.result.current.start()
    })

    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ client_id: 1 }))
  })

  // #297 review 2: an archived selection without a pair to fall back to is
  // cleared, so the dialog does not show the hidden client's projects.
  it('clears a selected archived client when it opens the dialog', async () => {
    const clients = [makeClient({ id: 1, name: 'Archived', active: 0 })]
    const { api, hook } = await setup({ clients, recent: [] })
    act(() => hook.result.current.setSelectedClientId(1))

    await act(async () => {
      await hook.result.current.start()
    })

    expect(api.start).not.toHaveBeenCalled()
    expect(hook.result.current.selectedClientId).toBeNull()
    expect(hook.result.current.selectedProjectId).toBeNull()
  })

  // #297 review 2: with no client list (not loaded yet, or the load failed)
  // nothing says the selection is archived; it starts as it always did.
  it('starts the selection when the client list is unknown', async () => {
    const { api, hook } = await setup({ clients: [] })
    act(() => hook.result.current.setSelectedClientId(5))

    await startTimer(hook)

    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ client_id: 5 }))
  })

  // #297 review 2: a failed project lookup is not "archived" — the last
  // entry's project is kept rather than silently dropped.
  it('keeps the last project when the project list cannot be read', async () => {
    const { api, hook } = await setup({
      recent: [makeEntry({ id: 9, client_id: 1, project_id: 10 })],
      projectsFail: true
    })

    await startTimer(hook)

    expect(api.start).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: 1, project_id: 10 })
    )
  })

  it('start() with no active client at all is a silent no-op', async () => {
    const clients = [makeClient({ id: 1, active: 0 })]
    const { api, hook } = await setup({ clients })

    await act(async () => {
      await hook.result.current.start()
    })

    expect(api.start).not.toHaveBeenCalled()
    expect(hook.result.current.runningEntry).toBeNull()
  })

  it('stop() clears the running state and pushes the idle tray', async () => {
    const { api, hook } = await setup()
    act(() => hook.result.current.setDescription('work'))
    const entry = await startTimer(hook)

    await act(async () => {
      await hook.result.current.stop()
    })

    expect(api.stop).toHaveBeenCalledWith(entry.id)
    expect(hook.result.current.runningEntry).toBeNull()
    expect(hook.result.current.description).toBe('')
    expect(api.trayUpdate).toHaveBeenLastCalledWith(false, '', 0, null)
  })

  it('stop() after a run without description opens the quick-note prompt', async () => {
    const { hook } = await setup()
    const entry = await startTimer(hook)

    await act(async () => {
      await hook.result.current.stop()
    })

    expect(hook.result.current.quickNoteEntry?.id).toBe(entry.id)
  })

  it('stop() after a described run does NOT open the quick-note prompt', async () => {
    const { hook } = await setup()
    act(() => hook.result.current.setDescription('work'))
    await startTimer(hook)

    await act(async () => {
      await hook.result.current.stop()
    })

    expect(hook.result.current.quickNoteEntry).toBeNull()
  })

  it('the global hotkey toggles: starts when idle, stops when running', async () => {
    const { api, hook } = await setup()

    // The IPC listener fires the async start/stop without awaiting it; the
    // async act drains the whole chain so no state update escapes the test
    // (an escaped one wedges React's act queue for every later render).
    await act(async () => {
      api.listeners.hotkeyToggle?.()
    })
    expect(hook.result.current.runningEntry).not.toBeNull()

    await act(async () => {
      api.listeners.hotkeyToggle?.()
    })
    expect(hook.result.current.runningEntry).toBeNull()
    expect(api.start).toHaveBeenCalledTimes(1)
    expect(api.stop).toHaveBeenCalledTimes(1)
  })
})

describe('useTimer — elapsed clock', () => {
  // NOTE: fake timers go on AFTER setup() — the dynamic import inside setup
  // runs through vitest's module runner, which needs real timers to resolve.
  // Live times come from the shared clock (NowContext). A per-second write to
  // the timer store re-rendered App and every useTimer consumer each second
  // for a value nobody reads, so the engine keeps only the 30 s heartbeat.
  it('does not tick elapsedSeconds every second, and resets it on stop', async () => {
    const { hook } = await setup()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-26T10:00:00.000Z'))

    await startTimer(hook)
    expect(hook.result.current.elapsedSeconds).toBe(0)

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(hook.result.current.elapsedSeconds).toBe(0)

    await act(async () => {
      await hook.result.current.stop()
    })
    expect(hook.result.current.elapsedSeconds).toBe(0)
  })

  it('heartbeats the running entry every 30 seconds', async () => {
    const { api, hook } = await setup()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-26T10:00:00.000Z'))

    const entry = await startTimer(hook)
    expect(api.heartbeat).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(api.heartbeat).toHaveBeenCalledTimes(1)
    expect(api.heartbeat).toHaveBeenCalledWith(entry.id)
  })
})

describe('useTimer — startWithClient keeps the selection consistent', () => {
  // Codex on #242: quick-starting client B left client A's project selected;
  // the global hotkey's start() then sent B with A's project.
  it('sets the project together with the client', async () => {
    const { hook } = await setup()
    const { useTimerStore } = await import('../store/timerStore')
    useTimerStore.setState({ selectedClientId: 1, selectedProjectId: 99 })
    await act(async () => {
      await hook.result.current.startWithClient(2, null)
    })
    expect(useTimerStore.getState().selectedClientId).toBe(2)
    expect(useTimerStore.getState().selectedProjectId).toBeNull()
  })
})

describe('useTimer — switchTo (B1)', () => {
  // Owner correction to B1: the switch is ONE main-process path. When the
  // stopped entry had no description, the quick-note prompt opens for it
  // AFTER the new entry runs — startWithClient would dismiss it.
  it('runs the new entry AND opens the quick note for the stopped one', async () => {
    const clients = [makeClient({ id: 1, name: 'Acme' }), makeClient({ id: 2, name: 'Beta' })]
    const { api, hook } = await setup({ clients })
    const first = await startTimer(hook)

    await act(async () => {
      await hook.result.current.switchTo(2, null)
    })

    expect(api.switch).toHaveBeenCalledWith({
      client_id: 2,
      project_id: null,
      description: '',
      started_at: expect.any(String)
    })
    expect(api.stop).not.toHaveBeenCalled()
    expect(hook.result.current.runningEntry?.client_id).toBe(2)
    expect(hook.result.current.quickNoteEntry?.id).toBe(first.id)
    expect(api.trayUpdate).toHaveBeenLastCalledWith(
      true,
      'Beta',
      0,
      hook.result.current.runningEntry?.started_at
    )
  })

  it('ignores a second switch while the first one is still in flight', async () => {
    const { api, hook } = await setup()
    await startTimer(hook)

    await act(async () => {
      await Promise.all([
        hook.result.current.switchTo(1, null),
        hook.result.current.switchTo(1, null)
      ])
    })

    expect(api.switch).toHaveBeenCalledTimes(1)
  })

  it('opens no quick note when the stopped entry had a description', async () => {
    const { hook } = await setup()
    act(() => hook.result.current.setDescription('work'))
    await startTimer(hook)

    await act(async () => {
      await hook.result.current.switchTo(1, null)
    })

    expect(hook.result.current.quickNoteEntry).toBeNull()
  })

  it('keeps a pending quick note open (no dismiss on the switch path)', async () => {
    const { hook } = await setup()
    act(() => hook.result.current.setDescription('work'))
    await startTimer(hook)
    // An earlier, unanswered prompt; the described run that now stops opens
    // none of its own, and the start must not close this one.
    act(() => hook.result.current.setQuickNoteEntry(makeEntry({ id: 55, description: '' })))

    await act(async () => {
      await hook.result.current.switchTo(1, null)
    })

    expect(hook.result.current.quickNoteEntry?.id).toBe(55)
  })

  it('drops a pending idle event, as stop() does', async () => {
    const { api, hook } = await setup()
    await startTimer(hook)
    act(() => api.listeners.idleDetected?.(IDLE))

    await act(async () => {
      await hook.result.current.switchTo(1, null)
    })

    expect(hook.result.current.idleEvent).toBeNull()
    expect(api.idleDismiss).toHaveBeenCalledTimes(1)
  })

  it('a failed switch leaves the old entry running and opens nothing', async () => {
    const { hook } = await setup({ switchFails: true })
    const first = await startTimer(hook)

    await act(async () => {
      await hook.result.current.switchTo(1, null)
    })

    expect(hook.result.current.runningEntry?.id).toBe(first.id)
    expect(hook.result.current.quickNoteEntry).toBeNull()
  })
})

// Owner decision for 1.22: the start dialog, submitted while a timer runs
// (one started elsewhere while the dialog was open), takes the switch path.
describe('useTimer — start() while a timer runs', () => {
  it('switches in one step and opens the quick note for the stopped entry', async () => {
    const clients = [makeClient({ id: 1, name: 'Acme' }), makeClient({ id: 2, name: 'Beta' })]
    const { api, hook } = await setup({ clients })
    const first = await startTimer(hook)
    // The module registry is fresh per setup(); take the store from it.
    const { useTimerStore } = await import('../store/timerStore')
    act(() => {
      useTimerStore.getState().setSelectedClientId(2)
      hook.result.current.setDescription('Review')
    })

    await act(async () => {
      await hook.result.current.start()
    })

    expect(api.switch).toHaveBeenCalledWith({
      client_id: 2,
      project_id: null,
      description: 'Review',
      started_at: expect.any(String)
    })
    expect(api.stop).not.toHaveBeenCalled()
    expect(hook.result.current.runningEntry?.client_id).toBe(2)
    expect(hook.result.current.quickNoteEntry?.id).toBe(first.id)
  })

  it('does not dismiss an open quick note', async () => {
    const { hook } = await setup()
    act(() => hook.result.current.setDescription('work'))
    await startTimer(hook)
    act(() => hook.result.current.setQuickNoteEntry(makeEntry({ id: 55, description: '' })))

    await act(async () => {
      await hook.result.current.start()
    })

    expect(hook.result.current.quickNoteEntry?.id).toBe(55)
  })
})

// A failed switch must not go unnoticed: the caller gets the error to show,
// and a call that never answers must not leave the switch path locked.
describe('useTimer — a failed switch is reported', () => {
  it('switchTo() returns the error of a refused switch', async () => {
    const { hook } = await setup({ switchFails: true })
    await startTimer(hook)

    let error: string | null = null
    await act(async () => {
      error = await hook.result.current.switchTo(1, null)
    })

    expect(error).toBe('boom')
  })

  it('start() while a timer runs returns the error of a refused switch', async () => {
    const { hook } = await setup({ switchFails: true })
    await startTimer(hook)

    let error: string | null = null
    await act(async () => {
      error = await hook.result.current.start()
    })

    expect(error).toBe('boom')
  })

  it('a successful switch returns no error', async () => {
    const { hook } = await setup()
    await startTimer(hook)

    let error: string | null = 'unset'
    await act(async () => {
      error = await hook.result.current.switchTo(1, null)
    })

    expect(error).toBeNull()
  })

  it('a call ignored while another switch is in flight returns no error', async () => {
    const { hook } = await setup()
    await startTimer(hook)

    let results: Array<string | null> = []
    await act(async () => {
      results = await Promise.all([
        hook.result.current.switchTo(1, null),
        hook.result.current.switchTo(1, null)
      ])
    })

    expect(results).toEqual([null, null])
  })

  it('a rejected switch call returns its message and unlocks the next switch', async () => {
    const clients = [makeClient({ id: 1, name: 'Acme' }), makeClient({ id: 2, name: 'Beta' })]
    const { api, hook } = await setup({ clients })
    const first = await startTimer(hook)
    api.switch.mockRejectedValueOnce(new Error('ipc gone'))

    let error: string | null = null
    await act(async () => {
      error = await hook.result.current.switchTo(2, null)
    })

    expect(error).toBe('ipc gone')
    expect(hook.result.current.isLoading).toBe(false)
    expect(hook.result.current.runningEntry?.id).toBe(first.id)

    await act(async () => {
      await hook.result.current.switchTo(2, null)
    })

    expect(api.switch).toHaveBeenCalledTimes(2)
    expect(hook.result.current.runningEntry?.client_id).toBe(2)
  })
})

describe('useTimer — a refused or rejected start is reported', () => {
  it('start() returns the error of a refused start', async () => {
    const { api, hook } = await setup()
    api.start.mockResolvedValueOnce({ ok: false, error: 'refused' })

    let error: string | null = null
    await act(async () => {
      error = await hook.result.current.start()
    })

    expect(error).toBe('refused')
    expect(hook.result.current.runningEntry).toBeNull()
  })

  it('startWithClient() returns the error of a refused start', async () => {
    const { api, hook } = await setup()
    api.start.mockResolvedValueOnce({ ok: false, error: 'refused' })

    let error: string | null = null
    await act(async () => {
      error = await hook.result.current.startWithClient(1, null)
    })

    expect(error).toBe('refused')
  })

  it('a successful start returns no error', async () => {
    const { hook } = await setup()

    let error: string | null = 'unset'
    await act(async () => {
      error = await hook.result.current.start()
    })

    expect(error).toBeNull()
  })

  it('a rejected start call returns its message and clears isLoading', async () => {
    const { api, hook } = await setup()
    api.start.mockRejectedValueOnce(new Error('ipc gone'))

    let error: string | null = null
    await act(async () => {
      error = await hook.result.current.start()
    })

    expect(error).toBe('ipc gone')
    expect(hook.result.current.isLoading).toBe(false)
  })

  it('a rejected startWithClient call returns its message and clears isLoading', async () => {
    const { api, hook } = await setup()
    api.start.mockRejectedValueOnce(new Error('ipc gone'))

    let error: string | null = null
    await act(async () => {
      error = await hook.result.current.startWithClient(1, null)
    })

    expect(error).toBe('ipc gone')
    expect(hook.result.current.isLoading).toBe(false)
  })
})

// Every timer action that sets isLoading around an IPC call must clear it
// even when the call rejects: a stuck flag disables the start dialog's start
// key and makes the switch path ignore every later call.
describe('useTimer — a rejected call never leaves isLoading set', () => {
  it('stop()', async () => {
    const { api, hook } = await setup()
    await startTimer(hook)
    api.stop.mockRejectedValueOnce(new Error('ipc gone'))

    await act(async () => {
      await hook.result.current.stop().catch(() => {})
    })

    expect(hook.result.current.isLoading).toBe(false)
  })

  it('idleStopAtIdle()', async () => {
    const { api, hook } = await setup()
    await startTimer(hook)
    act(() => api.listeners.idleDetected?.(IDLE))
    api.update.mockRejectedValueOnce(new Error('ipc gone'))

    await act(async () => {
      await hook.result.current.idleStopAtIdle().catch(() => {})
    })

    expect(hook.result.current.isLoading).toBe(false)
    // The idle prompt stays open for a retry: nothing was stopped.
    expect(hook.result.current.idleEvent).not.toBeNull()
    expect(api.idleDismiss).not.toHaveBeenCalled()
  })

  it('idleMarkPause()', async () => {
    const { api, hook } = await setup()
    await startTimer(hook)
    act(() => api.listeners.idleDetected?.(IDLE))
    api.update.mockRejectedValueOnce(new Error('ipc gone'))

    await act(async () => {
      await hook.result.current.idleMarkPause().catch(() => {})
    })

    expect(hook.result.current.isLoading).toBe(false)
  })
})

describe('useTimer — one engine per window', () => {
  // Every view calls useTimer(); before, each mounted instance ran its own
  // 1 s tick and 30 s heartbeat, so the main process got one heartbeat (and
  // one tray update) per mounted view. Only the engine instance runs them now.
  it('a second, non-engine instance adds no heartbeat', async () => {
    const { api, hook } = await setup()
    const { useTimer } = await import('./useTimer')
    renderHook(() => useTimer())
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-26T10:00:00.000Z'))

    await startTimer(hook)
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(api.heartbeat).toHaveBeenCalledTimes(1)
  })
})

describe('useTimer — idle transitions', () => {
  it('an idle signal while running surfaces the idle event', async () => {
    const { api, hook } = await setup()
    await startTimer(hook)

    act(() => api.listeners.idleDetected?.(IDLE))

    expect(hook.result.current.idleEvent).toEqual(IDLE)
    expect(api.idleDismiss).not.toHaveBeenCalled()
  })

  it('an idle signal with no timer running is dismissed without surfacing', async () => {
    const { api, hook } = await setup()

    act(() => api.listeners.idleDetected?.(IDLE))

    expect(hook.result.current.idleEvent).toBeNull()
    expect(api.idleDismiss).toHaveBeenCalledTimes(1)
  })

  it('idleKeep() dismisses the event and keeps the timer running', async () => {
    const { api, hook } = await setup()
    const entry = await startTimer(hook)
    act(() => api.listeners.idleDetected?.(IDLE))

    act(() => hook.result.current.idleKeep())

    expect(hook.result.current.idleEvent).toBeNull()
    expect(api.idleDismiss).toHaveBeenCalledTimes(1)
    expect(hook.result.current.runningEntry?.id).toBe(entry.id)
    expect(api.update).not.toHaveBeenCalled()
  })

  it('idleStopAtIdle() ends the entry at idleSince, not at now', async () => {
    const { api, hook } = await setup()
    const entry = await startTimer(hook)
    act(() => api.listeners.idleDetected?.(IDLE))

    await act(async () => {
      await hook.result.current.idleStopAtIdle()
    })

    // The whole entry travels along: entries:update re-inserts the row and
    // defaults every field it is not given (#313).
    expect(api.update).toHaveBeenCalledWith({
      id: entry.id,
      client_id: entry.client_id,
      project_id: entry.project_id ?? null,
      description: entry.description,
      started_at: entry.started_at,
      stopped_at: IDLE.idleSince,
      billable: entry.billable,
      tags: entry.tags,
      reference: entry.reference,
      private_note: entry.private_note
    })
    expect(hook.result.current.runningEntry).toBeNull()
    expect(hook.result.current.idleEvent).toBeNull()
    expect(api.idleDismiss).toHaveBeenCalledTimes(1)
    expect(api.trayUpdate).toHaveBeenLastCalledWith(false, '', 0, null)
  })

  it('idleMarkPause() stops at idleSince and books a Pause block up to now', async () => {
    const { api, hook } = await setup()
    const entry = await startTimer(hook)
    act(() => api.listeners.idleDetected?.(IDLE))

    // Pin only Date (after setup — module-runner trap, see the clock tests)
    // so "up to now" is an exact timestamp, not any-string. Deliberately
    // different from idleSince: a pauseEnd regression to it must go red.
    const NOW = new Date('2026-08-26T09:41:00.000Z')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)

    await act(async () => {
      await hook.result.current.idleMarkPause()
    })

    // 1. The running entry is closed at the moment idleness began.
    expect(api.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: entry.id,
        stopped_at: IDLE.idleSince
      })
    )
    // 2. A "Pause" entry covers idleSince → now, booked closed and not
    // billable in one step (#298: it used to be started as a running timer
    // and closed afterwards, which left a running billable pause whenever
    // the closing write failed).
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.create).toHaveBeenCalledWith({
      client_id: entry.client_id,
      description: 'Pause',
      started_at: IDLE.idleSince,
      stopped_at: NOW.toISOString(),
      billable: 0
    })
    expect(api.start).toHaveBeenCalledTimes(1) // startTimer() above, not the pause
    expect(api.update).toHaveBeenCalledTimes(1)
    expect(hook.result.current.runningEntry).toBeNull()
    expect(hook.result.current.idleEvent).toBeNull()
    expect(api.idleDismiss).toHaveBeenCalledTimes(1)
  })

  it('a manual stop() with a pending idle event dismisses it', async () => {
    const { api, hook } = await setup()
    await startTimer(hook)
    act(() => api.listeners.idleDetected?.(IDLE))
    expect(hook.result.current.idleEvent).toEqual(IDLE)

    await act(async () => {
      await hook.result.current.stop()
    })

    expect(hook.result.current.idleEvent).toBeNull()
    expect(api.idleDismiss).toHaveBeenCalledTimes(1)
  })
})

// #297: main sends timer:open-start when the start hotkey or mini play key
// finds nothing to start in the database, and brings the window forward.
// Main does not know the renderer's selection, so the renderer answers with
// the same start path: a valid selection starts, else the last pair, else
// the START dialog opens — now in a visible window.
describe('useTimer — handleOpenStart (#297)', () => {
  // Main sent this because the last entry's client (1) is archived; the
  // user's selection (2) is valid and starts, as it did before #297. Hotkey
  // and mini play both reach main's onStartKey and send this same event.
  it('starts a valid selection instead of opening the dialog', async () => {
    const clients = [
      makeClient({ id: 1, name: 'Archived', active: 0 }),
      makeClient({ id: 2, name: 'Beta' })
    ]
    const { api, hook } = await setup({ clients, recent: [makeEntry({ id: 9, client_id: 1 })] })
    const { handleOpenStart } = await import('./useTimer')
    const { useStartTimerModalStore } = await import('../store/startTimerModalStore')
    act(() => hook.result.current.setSelectedClientId(2))

    await act(async () => {
      await handleOpenStart()
    })

    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ client_id: 2 }))
    expect(useStartTimerModalStore.getState().open).toBe(false)
  })

  it('opens the START dialog when there is neither a selection nor a pair', async () => {
    const { api } = await setup({ recent: [] })
    const { handleOpenStart } = await import('./useTimer')
    const { useStartTimerModalStore } = await import('../store/startTimerModalStore')

    await act(async () => {
      await handleOpenStart()
    })

    expect(api.start).not.toHaveBeenCalled()
    await waitFor(() => expect(useStartTimerModalStore.getState().open).toBe(true))
  })

  // #297 review 2: the caller (App) shows the error, as the dialog does.
  it('returns the error of a refused start', async () => {
    const clients = [makeClient({ id: 2, name: 'Beta' })]
    const { api, hook } = await setup({ clients, recent: [] })
    const { handleOpenStart } = await import('./useTimer')
    act(() => hook.result.current.setSelectedClientId(2))
    api.start.mockResolvedValueOnce({ ok: false, error: 'refused' })

    let error: string | null = null
    await act(async () => {
      error = await handleOpenStart()
    })

    expect(error).toBe('refused')
  })

  // #297 review 3: an IPC call that rejects (instead of answering ok:false)
  // comes back as an error to show, not as an unhandled rejection.
  it('returns the message when reading the last pair fails', async () => {
    const { hook } = await setup({ recent: [] })
    const { handleOpenStart } = await import('./useTimer')
    ;(
      window as unknown as { api: { dashboard: { summary: () => Promise<never> } } }
    ).api.dashboard.summary = async () => {
      throw new Error('ipc gone')
    }

    let error: string | null = null
    await act(async () => {
      error = await handleOpenStart()
    })

    expect(error).toBe('ipc gone')
    expect(hook.result.current.isLoading).toBe(false)
  })

  it('does nothing while a timer runs (no switch from a window-forward event)', async () => {
    const { api, hook } = await setup()
    await startTimer(hook)
    const { handleOpenStart } = await import('./useTimer')

    await act(async () => {
      await handleOpenStart()
    })

    expect(api.start).toHaveBeenCalledTimes(1)
    expect(api.switch).not.toHaveBeenCalled()
  })
})

// Q8 (2.0.0): "Fortsetzen" starts an entry's client, project and description
// again — the start path when nothing runs, the switch path (one instant,
// quick note for the stopped entry) when another timer runs.
describe('useTimer — resume (Q8)', () => {
  const clients = [makeClient({ id: 1, name: 'Acme' }), makeClient({ id: 2, name: 'Beta' })]

  it('starts client, project and description when nothing runs', async () => {
    const { api, hook } = await setup({ clients })

    let error: string | null = 'unset'
    await act(async () => {
      error = await hook.result.current.resume(2, 20, 'Review')
    })

    expect(error).toBeNull()
    expect(api.start).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: 2, project_id: 20, description: 'Review' })
    )
    expect(hook.result.current.selectedClientId).toBe(2)
    expect(hook.result.current.selectedProjectId).toBe(20)
    expect(hook.result.current.description).toBe('Review')
  })

  it('switches with the description when another timer runs', async () => {
    const { api, hook } = await setup({ clients })
    const first = await startTimer(hook)

    await act(async () => {
      await hook.result.current.resume(2, 20, 'Review')
    })

    expect(api.switch).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: 2, project_id: 20, description: 'Review' })
    )
    expect(api.start).toHaveBeenCalledTimes(1) // startTimer above
    expect(hook.result.current.runningEntry?.client_id).toBe(2)
    expect(hook.result.current.description).toBe('Review')
    // The stopped entry had no description: its prompt opens, as for a switch.
    expect(hook.result.current.quickNoteEntry?.id).toBe(first.id)
  })

  it('does nothing when the same thing already runs', async () => {
    const { api, hook } = await setup({ clients })
    act(() => {
      hook.result.current.setSelectedClientId(2)
      hook.result.current.setSelectedProjectId(20)
      hook.result.current.setDescription('Review')
    })
    await startTimer(hook)

    await act(async () => {
      await hook.result.current.resume(2, 20, 'Review')
    })

    expect(api.switch).not.toHaveBeenCalled()
    expect(api.start).toHaveBeenCalledTimes(1)
  })

  it('returns the error of a refused start', async () => {
    const { api, hook } = await setup({ clients })
    api.start.mockResolvedValueOnce({ ok: false, error: 'refused' })

    let error: string | null = null
    await act(async () => {
      error = await hook.result.current.resume(2, null, 'Review')
    })

    expect(error).toBe('refused')
  })
})

// #313: the idle prompt stops the running entry through entries:update, which
// defaults every field it is not sent. Today only the project of a running
// entry can differ from the defaults; the other fields are sent along anyway,
// and this pins that, so a later way to set them on a running entry is not
// reset by the idle prompt.
describe('useTimer — the idle prompt sends the whole running entry (#313)', () => {
  const RUNNING = makeEntry({
    id: 5,
    project_id: 7,
    billable: 0,
    tags: ',ops,',
    reference: 'JIRA-7',
    private_note: 'intern'
  })
  const KEPT = {
    id: 5,
    project_id: 7,
    billable: 0,
    tags: ',ops,',
    reference: 'JIRA-7',
    private_note: 'intern',
    stopped_at: IDLE.idleSince
  }

  it('idleStopAtIdle()', async () => {
    const { api, hook } = await setup({ running: RUNNING })
    await waitFor(() => expect(hook.result.current.runningEntry?.id).toBe(5))
    act(() => api.listeners.idleDetected?.(IDLE))

    await act(async () => {
      await hook.result.current.idleStopAtIdle()
    })

    expect(api.update).toHaveBeenCalledWith(expect.objectContaining(KEPT))
  })

  it('idleMarkPause()', async () => {
    const { api, hook } = await setup({ running: RUNNING })
    await waitFor(() => expect(hook.result.current.runningEntry?.id).toBe(5))
    act(() => api.listeners.idleDetected?.(IDLE))

    await act(async () => {
      await hook.result.current.idleMarkPause()
    })

    expect(api.update).toHaveBeenNthCalledWith(1, expect.objectContaining(KEPT))
  })
})
