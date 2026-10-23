/**
 * A quick-start key starts a timer, or while one runs, switches in one
 * main-process step (B1). When the main process refuses, nothing changes —
 * and the user must learn that, or they bill the next hours to a client they
 * did not start or switch to. The hook returns the error (useTimer.test.tsx);
 * here the Heute view has to show it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TodayView from './TodayView'
import { I18nProvider } from '../contexts/I18nContext'
import { useToastStore } from '../store/toastStore'
import { useTimerStore } from '../store/timerStore'
import type { Client, DashboardSummary, Entry } from '../../../shared/types'

// useTimer adopts the running entry only on its first mount in this module
// registry, so each test sets the store itself (see setup).
afterEach(() => {
  cleanup()
  useToastStore.setState({ toasts: [] })
  useTimerStore.setState({ runningEntry: null })
})

const CLIENTS: Client[] = [
  { id: 1, name: 'Acme', color: '#111111', active: 1, rate_cent: 0, created_at: '' },
  { id: 2, name: 'Beta', color: '#222222', active: 1, rate_cent: 0, created_at: '' }
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
