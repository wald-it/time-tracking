/**
 * A quick-start key starts a timer, or while one runs, switches in one
 * main-process step (B1). When the main process refuses, nothing changes —
 * and the user must learn that, or they bill the next hours to a client they
 * did not start or switch to. The hook returns the error (useTimer.test.tsx);
 * here the Heute view has to show it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import TodayView from './TodayView'
import { I18nProvider } from '../contexts/I18nContext'
import { useToastStore } from '../store/toastStore'
import { useTimerStore } from '../store/timerStore'
import type { Client, DashboardSummary, Entry, Project } from '../../../shared/types'

// useTimer adopts the running entry only on its first mount in this module
// registry, so each test sets the store itself (see setup).
afterEach(() => {
  cleanup()
  useToastStore.setState({ toasts: [] })
  useTimerStore.setState({ runningEntry: null })
})

const CLIENTS: Client[] = [
  {
    id: 1,
    name: 'Acme',
    color: '#111111',
    active: 1,
    rate_cent: 0,
    short_code: null,
    created_at: ''
  },
  {
    id: 2,
    name: 'Beta',
    color: '#222222',
    active: 1,
    rate_cent: 0,
    short_code: null,
    created_at: ''
  }
]

const RUNNING: Entry = {
  id: 1,
  client_id: 1,
  description: 'Läuft',
  started_at: new Date(Date.now() - 600_000).toISOString(),
  stopped_at: null,
  heartbeat_at: null,
  rounded_min: null,
  deleted_at: null,
  created_at: new Date(Date.now() - 600_000).toISOString(),
  link_id: null,
  tags: '',
  reference: '',
  billable: 1,
  private_note: '',
  project_id: null
}

const SUMMARY: DashboardSummary = {
  todaySeconds: 600,
  weekSeconds: 600,
  weekDaySeconds: [600, 0, 0, 0, 0, 0, 0],
  recentEntries: [RUNNING],
  todayEntries: [RUNNING],
  topClients30d: [
    { client_id: 1, name: 'Acme', color: '#111111', seconds: 7200, last_project_id: null },
    { client_id: 2, name: 'Beta', color: '#222222', seconds: 3600, last_project_id: null }
  ]
}

function setup(opts: { running: boolean }): {
  startFn: ReturnType<typeof vi.fn>
  switchFn: ReturnType<typeof vi.fn>
} {
  const startFn = vi.fn(async () => ({ ok: false as const, error: 'Kunde existiert nicht' }))
  const switchFn = vi.fn(async () => ({
    ok: false as const,
    error: 'Projekt gehört nicht zu diesem Kunden'
  }))
  const summary: DashboardSummary = opts.running
    ? SUMMARY
    : { ...SUMMARY, recentEntries: [], todayEntries: [] }
  const api = {
    clients: { getAll: async () => ({ ok: true as const, data: CLIENTS }) },
    projects: { getAll: async () => ({ ok: true as const, data: [] }) },
    entries: {
      getRunning: async () => ({ ok: true as const, data: opts.running ? RUNNING : null }),
      start: startFn,
      switch: switchFn,
      heartbeat: async () => ({ ok: true as const, data: undefined })
    },
    dashboard: {
      summary: async () => ({ ok: true as const, data: summary }),
      todayTotal: async () => ({ ok: true as const, data: 600 })
    },
    tray: { update: vi.fn() },
    idle: { dismiss: vi.fn() },
    onHotkeyToggle: () => {},
    onTrayQuickStart: () => {},
    onTrayStop: () => {},
    onDataChanged: () => {},
    onIdleDetected: () => {}
  }
  ;(window as unknown as { api: typeof api }).api = api
  useTimerStore.setState({ clients: CLIENTS, runningEntry: opts.running ? RUNNING : null })
  render(
    <I18nProvider>
      <TodayView />
    </I18nProvider>
  )
  return { startFn, switchFn }
}

describe('TodayView — a refused quick-start key', () => {
  it('a refused switch shows the error as a toast and says the running timer keeps running', async () => {
    const { switchFn } = setup({ running: true })

    fireEvent.click(await screen.findByRole('button', { name: 'Zu Beta wechseln' }))

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1))
    expect(switchFn).toHaveBeenCalledTimes(1)
    expect(useToastStore.getState().toasts[0].message).toBe(
      'Wechsel fehlgeschlagen: Projekt gehört nicht zu diesem Kunden. Der laufende Timer läuft weiter.'
    )
  })

  it('a refused start with no timer running shows the error as a toast', async () => {
    const { startFn } = setup({ running: false })

    fireEvent.click(await screen.findByRole('button', { name: 'Timer für Beta starten' }))

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1))
    expect(startFn).toHaveBeenCalledTimes(1)
    expect(useToastStore.getState().toasts[0].message).toBe(
      'Start fehlgeschlagen: Kunde existiert nicht'
    )
  })
})

// Q8, 2.2: real hook and listener, with a fresh registry for each view.
async function setupResume(
  running: boolean,
  opts: {
    projectId?: number
    getProjects?: Window['api']['projects']['getAll']
  } = {}
): Promise<{
  start: ReturnType<typeof vi.fn>
  switchFn: ReturnType<typeof vi.fn>
  play: HTMLElement
  timerStore: typeof useTimerStore
  toastStore: typeof useToastStore
  resumed: Entry
  finished: Entry
  summary: ReturnType<typeof vi.fn>
  changed: () => void
  setMain: (entry: Entry | null) => void
  finish: () => { entry: Entry; stopped: Entry | null }
}> {
  vi.resetModules()
  const timerStore = (await import('../store/timerStore')).useTimerStore
  const toastStore = (await import('../store/toastStore')).useToastStore
  const View = (await import('./TodayView')).default
  const Provider = (await import('../contexts/I18nContext')).I18nProvider
  const finished: Entry = {
    ...RUNNING,
    id: 7,
    client_id: 2,
    project_id: opts.projectId ?? null,
    description: 'Review',
    stopped_at: new Date().toISOString()
  }
  const resumed: Entry = { ...finished, id: 8, stopped_at: null }
  let current: Entry | null = running ? RUNNING : null
  let rows = running ? [RUNNING, finished] : [finished]
  let changed!: () => void
  const start = vi.fn()
  const switchFn = vi.fn()
  const trayUpdate = vi.fn()
  const summary = vi.fn(async () => ({
    ok: true as const,
    data: { ...SUMMARY, todayEntries: rows, topClients30d: [] }
  }))
  window.api = {
    clients: { getAll: async () => ({ ok: true, data: CLIENTS }) },
    projects: { getAll: opts.getProjects ?? (async () => ({ ok: true, data: [] })) },
    entries: { start, switch: switchFn, getRunning: async () => ({ ok: true, data: current }) },
    dashboard: { summary, todayTotal: async () => ({ ok: true, data: 0 }) },
    tray: { update: trayUpdate },
    idle: { dismiss: vi.fn() },
    onHotkeyToggle: () => {},
    onTrayQuickStart: () => {},
    onTrayStop: () => {},
    onIdleDetected: () => {},
    onDataChanged: (callback: () => void) => {
      changed = callback
    }
  } as unknown as Window['api']
  render(
    <Provider>
      <View />
    </Provider>
  )
  await waitFor(() => expect(trayUpdate).toHaveBeenCalled())
  const play = await screen.findByRole('button', { name: /fortsetzen/i })
  return {
    start,
    switchFn,
    play,
    timerStore,
    toastStore,
    resumed,
    finished,
    summary,
    changed: () => changed(),
    setMain: (entry: Entry | null) => {
      current = entry
    },
    finish: () => {
      const stopped = current ? { ...current, stopped_at: resumed.started_at } : null
      current = resumed
      rows = [resumed, ...(stopped ? [stopped] : []), finished]
      return { entry: resumed, stopped }
    }
  }
}

describe('TodayView — resume (Q8, 2.2)', () => {
  it('disables resume until the project is known, then starts with that project', async () => {
    const pending = Promise.withResolvers<{ ok: true; data: Project[] }>()
    const getProjects = vi.fn(() => pending.promise)
    const ctx = await setupResume(false, { projectId: 20, getProjects })
    ctx.start.mockImplementation(async () => ({ ok: true, data: ctx.finish().entry }))

    expect(getProjects).toHaveBeenCalledWith({})
    expect.soft(ctx.play).toBeDisabled()
    fireEvent.click(ctx.play)
    expect.soft(ctx.start).not.toHaveBeenCalled()
    expect.soft(ctx.switchFn).not.toHaveBeenCalled()

    await act(async () => {
      pending.resolve({
        ok: true,
        data: [
          {
            id: 20,
            client_id: 2,
            name: 'Audit',
            color: '',
            rate_cent: 15000,
            active: 1,
            created_at: ''
          }
        ]
      })
    })
    expect(ctx.play).toBeEnabled()
    fireEvent.click(ctx.play)
    await waitFor(() => expect(ctx.timerStore.getState().runningEntry).toEqual(ctx.resumed))
    expect(ctx.start).toHaveBeenCalledTimes(1)
    expect(ctx.start).toHaveBeenCalledWith({
      client_id: 2,
      project_id: 20,
      description: 'Review',
      started_at: expect.any(String)
    })
  })

  it.each([false, true])('Q8 double play sends one timer call, running=%s', async (running) => {
    const ctx = await setupResume(running)
    let release!: (value: unknown) => void
    const call = running ? ctx.switchFn : ctx.start
    call.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      })
    )
    fireEvent.click(ctx.play)
    fireEvent.click(ctx.play)
    expect(call).toHaveBeenCalledTimes(1)
    expect(running ? ctx.start : ctx.switchFn).not.toHaveBeenCalled()
    expect(ctx.toastStore.getState().toasts).toHaveLength(0)
    await act(async () => {
      const result = ctx.finish()
      release({ ok: true, data: running ? result : result.entry })
    })
    expect(ctx.toastStore.getState().toasts).toHaveLength(0)
  })

  it.each([
    [false, false],
    [true, true],
    [false, true],
    [true, false]
  ])('Q8 toast follows call-time path, rendered=%s current=%s', async (rendered, current) => {
    const ctx = await setupResume(rendered)
    ctx.start.mockResolvedValue({ ok: false, error: 'refused' })
    ctx.switchFn.mockResolvedValue({ ok: false, error: 'refused' })
    // The click is in the same batch as an external store update, before React
    // renders it: the handler still closes over the previous runningEntry.
    act(() => {
      ctx.timerStore.setState({ runningEntry: current ? RUNNING : null })
      fireEvent.click(ctx.play)
    })
    await waitFor(() => expect(ctx.toastStore.getState().toasts).toHaveLength(1))
    expect(current ? ctx.switchFn : ctx.start).toHaveBeenCalledTimes(1)
    expect(ctx.toastStore.getState().toasts[0].message).toBe(
      current
        ? 'Wechsel fehlgeschlagen: refused. Der laufende Timer läuft weiter.'
        : 'Start fehlgeschlagen: refused'
    )
  })

  it.each([false, true])(
    'Q8 table reloads running and stopped play keys, running=%s',
    async (running) => {
      const ctx = await setupResume(running)
      const call = running ? ctx.switchFn : ctx.start
      call.mockImplementation(async () => {
        const result = ctx.finish()
        return { ok: true, data: running ? result : result.entry }
      })
      fireEvent.click(ctx.play)
      const table = screen.getByRole('table')
      await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(running ? 4 : 3))
      const rows = within(table).getAllByRole('row').slice(1)
      expect(within(rows[0]).queryByRole('button', { name: /fortsetzen/i })).toBeNull()
      for (const row of rows.slice(1)) {
        expect(within(row).getByRole('button', { name: /fortsetzen/i })).toBeEnabled()
      }
      expect(ctx.timerStore.getState().runningEntry).toEqual(ctx.resumed)
      expect(ctx.toastStore.getState().toasts).toHaveLength(0)
    }
  )

  it.each([false, true])(
    'Q8 external stop during switch settles main without toast, restarted=%s',
    async (restarted) => {
      const ctx = await setupResume(true)
      let release!: (value: unknown) => void
      ctx.switchFn.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve
        })
      )
      fireEvent.click(ctx.play)
      const final = restarted ? ctx.resumed : null
      ctx.setMain(final)
      await act(async () => ctx.changed())
      expect(ctx.timerStore.getState().runningEntry).toEqual(final)
      await act(async () => release({ ok: true, data: { entry: ctx.resumed, stopped: RUNNING } }))
      expect(ctx.timerStore.getState().runningEntry).toEqual(final)
      expect(ctx.switchFn).toHaveBeenCalledTimes(1)
      expect(ctx.toastStore.getState().toasts).toHaveLength(0)
    }
  )
})
