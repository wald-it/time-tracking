/**
 * Characterization tests for CalendarView (#167): selection and navigation
 * interactions — day click → drawer, roving-tabindex arrow keys, Enter,
 * month paging, "Heute". Written against the current implementation to pin
 * observable behavior, not as a spec; rendering itself (bars, totals,
 * layout) is out of scope per the issue.
 *
 * Only `Date` is faked (system time pinned per test) so async loads and
 * `waitFor` run on real timers. Entry timestamps are mid-day UTC, which maps
 * to the same LOCAL day for any timezone between UTC-9 and UTC+11 — the
 * grouping key is the local date.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import CalendarView from './CalendarView'
import { I18nProvider } from '../contexts/I18nContext'
import { useTimerStore } from '../store/timerStore'
import type { Client, Entry, Project } from '../../../shared/types'

// `globals` is off in vitest.config.ts — unmount explicitly (see TagInput test).
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const CLIENTS: Client[] = [
  {
    id: 1,
    name: 'Acme',
    color: '#6366f1',
    active: 1,
    rate_cent: 0,
    created_at: '2026-01-01T00:00:00.000Z'
  }
]

function makeEntry(over: Partial<Entry> & Pick<Entry, 'id' | 'started_at'>): Entry {
  return {
    client_id: 1,
    description: '',
    stopped_at: null,
    heartbeat_at: null,
    rounded_min: null,
    deleted_at: null,
    created_at: over.started_at,
    link_id: null,
    tags: '',
    reference: '',
    billable: 1,
    private_note: '',
    project_id: null,
    ...over
  }
}

const AUGUST_ENTRIES: Entry[] = [
  makeEntry({
    id: 1,
    description: 'Standup prep',
    started_at: '2026-08-10T09:00:00.000Z',
    stopped_at: '2026-08-10T10:30:00.000Z'
  }),
  makeEntry({
    id: 2,
    description: 'Review',
    started_at: '2026-08-10T11:00:00.000Z',
    stopped_at: '2026-08-10T12:00:00.000Z'
  }),
  makeEntry({
    id: 3,
    description: 'Deep work',
    started_at: '2026-08-12T09:00:00.000Z',
    stopped_at: '2026-08-12T11:00:00.000Z'
  })
]

interface Setup {
  getByMonth: ReturnType<typeof vi.fn>
}

/**
 * Pins the clock, mocks the api surface CalendarView + its useTimer() call
 * reach on mount, renders, and waits for the month load to settle.
 */
async function setup(
  opts: {
    now?: string
    byMonth?: Record<string, Entry[]>
    clients?: Client[]
    projects?: Project[]
  } = {}
): Promise<Setup> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(opts.now ?? '2026-08-15T12:00:00.000Z'))
  const clients = opts.clients ?? CLIENTS

  const getByMonth = vi.fn(async ({ year, month }: { year: number; month: number }) => ({
    ok: true as const,
    data: opts.byMonth?.[`${year}-${month}`] ?? []
  }))
  const api = {
    entries: {
      getByMonth,
      getRunning: async () => ({ ok: true as const, data: null })
    },
    clients: {
      getAll: async () => ({ ok: true as const, data: clients })
    },
    projects: {
      getAll: async () => ({ ok: true as const, data: opts.projects ?? [] })
    },
    dashboard: {
      todayTotal: async () => ({ ok: true as const, data: 0 })
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

  // useTimer's module-level init runs only once per test FILE; seed the
  // shared store directly so every test sees the same clients regardless of
  // execution order.
  useTimerStore.setState({ clients })

  render(
    <I18nProvider>
      <CalendarView />
    </I18nProvider>
  )
  await waitFor(() => expect(getByMonth).toHaveBeenCalled())
  await waitFor(() => expect(screen.queryByText('Lade…')).toBeNull())
  return { getByMonth }
}

function cell(dayKey: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-day="${dayKey}"]`)
  if (!el) throw new Error(`no grid cell for ${dayKey}`)
  return el
}

describe('CalendarView — day selection', () => {
  it("a click on a day opens the drawer with exactly that day's entries", async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })

    fireEvent.click(cell('2026-08-10'))

    const drawer = screen.getByRole('dialog', { name: 'Einträge für 10.08.2026' })
    expect(within(drawer).getByText('2 Einträge · 02:30')).not.toBeNull()
    expect(within(drawer).getByText('Standup prep')).not.toBeNull()
    expect(within(drawer).getByText('Review')).not.toBeNull()
    // The neighbouring day's entry stays out.
    expect(within(drawer).queryByText('Deep work')).toBeNull()
  })

  it('Escape closes the drawer', async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    fireEvent.click(cell('2026-08-10'))
    expect(screen.queryByRole('dialog')).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Enter opens the drawer for the KEYBOARD-focused day', async () => {
    await setup()
    // Today (15th) starts focused; move one day right, then commit.
    fireEvent.keyDown(cell('2026-08-15'), { key: 'ArrowRight' })
    fireEvent.keyDown(cell('2026-08-16'), { key: 'Enter' })

    const drawer = screen.getByRole('dialog', { name: 'Einträge für 16.08.2026' })
    expect(within(drawer).getByText('Kein Eintrag an diesem Tag.')).not.toBeNull()
  })
})

describe('CalendarView — keyboard navigation', () => {
  it('arrow keys move the focused day; the tabindex roves with it', async () => {
    await setup()
    expect(document.activeElement).toBe(cell('2026-08-15'))

    fireEvent.keyDown(cell('2026-08-15'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(cell('2026-08-16'))
    expect(cell('2026-08-16').tabIndex).toBe(0)
    expect(cell('2026-08-15').tabIndex).toBe(-1)

    fireEvent.keyDown(cell('2026-08-16'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(cell('2026-08-23'))

    fireEvent.keyDown(cell('2026-08-23'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(cell('2026-08-16'))

    fireEvent.keyDown(cell('2026-08-16'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(cell('2026-08-15'))
  })

  it('stepping past the month boundary flips the grid to the next month', async () => {
    const { getByMonth } = await setup({ now: '2026-08-31T12:00:00.000Z' })
    expect(document.activeElement).toBe(cell('2026-08-31'))

    fireEvent.keyDown(cell('2026-08-31'), { key: 'ArrowRight' })

    expect(screen.getByText('September 2026')).not.toBeNull()
    expect(document.activeElement).toBe(cell('2026-09-01'))
    await waitFor(() => expect(getByMonth).toHaveBeenLastCalledWith({ year: 2026, month: 9 }))
  })
})

describe('CalendarView — month paging', () => {
  it('next/prev buttons page through months and refetch each one', async () => {
    const { getByMonth } = await setup()
    expect(screen.getByText('August 2026')).not.toBeNull()
    expect(getByMonth).toHaveBeenLastCalledWith({ year: 2026, month: 8 })

    fireEvent.click(screen.getByRole('button', { name: 'Nächster Monat' }))
    expect(screen.getByText('September 2026')).not.toBeNull()
    await waitFor(() => expect(getByMonth).toHaveBeenLastCalledWith({ year: 2026, month: 9 }))

    fireEvent.click(screen.getByRole('button', { name: 'Vorheriger Monat' }))
    expect(screen.getByText('August 2026')).not.toBeNull()
    await waitFor(() => expect(getByMonth).toHaveBeenLastCalledWith({ year: 2026, month: 8 }))
  })

  it('"Heute" returns to the current month and refocuses today', async () => {
    await setup()
    fireEvent.click(screen.getByRole('button', { name: 'Nächster Monat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Nächster Monat' }))
    expect(screen.getByText('Oktober 2026')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Heute' }))

    expect(screen.getByText('August 2026')).not.toBeNull()
    expect(document.activeElement).toBe(cell('2026-08-15'))
  })
})

describe('CalendarView — day revenue', () => {
  const RATED: Client[] = [{ ...CLIENTS[0], rate_cent: 10000 }]

  it('shows no amount while no client or project has a rate', async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    expect(within(cell('2026-08-10')).queryByTestId('day-revenue')).toBeNull()
  })

  it('sums billable entries per day at the client rate', async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES }, clients: RATED })
    // 1:30 + 1:00 at 100 €/h
    expect(within(cell('2026-08-10')).getByTestId('day-revenue').textContent).toBe('250,00 €')
    expect(within(cell('2026-08-12')).getByTestId('day-revenue').textContent).toBe('200,00 €')
    expect(within(cell('2026-08-11')).queryByTestId('day-revenue')).toBeNull()
  })

  it('leaves non-billable entries out and lets a project rate win', async () => {
    const project: Project = {
      id: 7,
      client_id: 1,
      name: 'Audit',
      color: '',
      rate_cent: 15000,
      active: 1,
      created_at: '2026-01-01T00:00:00.000Z'
    }
    const entries = [
      { ...AUGUST_ENTRIES[0], project_id: 7 }, // 1:30 at 150 €/h = 225 €
      { ...AUGUST_ENTRIES[1], billable: 0 } // excluded
    ]
    await setup({ byMonth: { '2026-8': entries }, clients: RATED, projects: [project] })
    await waitFor(() =>
      expect(within(cell('2026-08-10')).getByTestId('day-revenue').textContent).toBe('225,00 €')
    )
  })
})
