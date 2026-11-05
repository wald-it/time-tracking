import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import TodayView from './TodayView'
import { I18nProvider } from '../contexts/I18nContext'
import { NowProvider } from '../contexts/NowContext'
import { useSettingsStore } from '../store/settingsStore'
import type { Client, DashboardSummary, Entry, Settings } from '../../../shared/types'
import * as gapHelpers from '../components/heute/todayGaps'

const clients: Client[] = [
  {
    id: 1,
    name: 'Acme',
    active: 1,
    color: '#111111',
    rate_cent: 0,
    short_code: null,
    created_at: ''
  }
]
vi.mock('../hooks/useTimer', () => ({
  useTimer: () => ({ runningEntry: null, clients })
}))

const local = (hour: number): Date => new Date(2026, 7, 10, hour)
const entry = (start: number, end: number): Entry => ({
  id: start,
  client_id: 1,
  started_at: local(start).toISOString(),
  stopped_at: local(end).toISOString(),
  description: '',
  heartbeat_at: null,
  rounded_min: null,
  deleted_at: null,
  created_at: '',
  link_id: null,
  tags: '',
  reference: '',
  billable: 1,
  private_note: '',
  project_id: null
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(local(12))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  useSettingsStore.setState({ settings: null })
  delete (window as unknown as { api?: unknown }).api
})

async function mount(entries: Entry[], gapCarryovers?: Entry[]): Promise<void> {
  const summary: DashboardSummary = {
    todayEntries: entries,
    gapCarryovers: [],
    recentEntries: [],
    topClients30d: [],
    todaySeconds: 3600,
    weekSeconds: 3600,
    weekDaySeconds: [3600, 0, 0, 0, 0, 0, 0]
  }
  // Exercise the fallback for a response without the new field, too.
  if (gapCarryovers === undefined) delete (summary as Partial<DashboardSummary>).gapCarryovers
  else summary.gapCarryovers = gapCarryovers
  window.api = {
    dashboard: { summary: async () => ({ ok: true, data: summary }) },
    projects: { getAll: async () => ({ ok: true, data: [] }) },
    tags: { getAllWithCount: async () => ({ ok: true, data: [] }) }
  } as unknown as Window['api']
  await act(async () => {
    render(
      <I18nProvider>
        <NowProvider running={false}>
          <TodayView />
        </NowProvider>
      </I18nProvider>
    )
  })
}

async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

function expectTimes(start: string, end: string): void {
  const dialog = within(screen.getByRole('dialog', { name: 'Eintrag nachtragen' }))
  expect(dialog.getByLabelText('Datum')).toHaveValue('2026-08-10')
  expect(dialog.getByLabelText('Start')).toHaveValue(start)
  expect(dialog.getByLabelText('Ende')).toHaveValue(end)
}

describe('Today backfill gaps', () => {
  it('uses a stopped carryover only for gaps, leaving rows and the today total unchanged (#489)', async () => {
    const carryover = {
      ...entry(9, 10),
      id: 489,
      description: 'Yesterday carryover',
      started_at: new Date(2026, 7, 9, 22).toISOString(),
      stopped_at: local(9).toISOString()
    }
    await mount([entry(10, 11)], [carryover])
    expect(screen.getByText('ungeklärt 2:00', { exact: true })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Lücke 09:00–10:00 · ungeklärt 1:00 · nachtragen' })
    ).toBeInTheDocument()
    expect(screen.queryByText('Yesterday carryover')).toBeNull()
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2)
    expect(
      within(screen.getByText('Heute', { exact: true }).parentElement!).getByText('1:00')
    ).toBeInTheDocument()
  })

  it('keeps the larger unexplained figure when gapCarryovers is absent (#489)', async () => {
    await mount([entry(10, 11)])
    expect(screen.getByText('ungeklärt 3:00', { exact: true })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Lücke 08:00–10:00 · ungeklärt 2:00 · nachtragen' })
    ).toBeInTheDocument()
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2)
    expect(
      within(screen.getByText('Heute', { exact: true }).parentElement!).getByText('1:00')
    ).toBeInTheDocument()
  })

  it('passes a running carryover present in both lists once to both gap consumers (#489)', async () => {
    const compute = vi.spyOn(gapHelpers, 'todayGaps')
    const running = {
      ...entry(9, 10),
      id: 489,
      started_at: new Date(2026, 7, 9, 22).toISOString(),
      stopped_at: null
    }
    await mount([entry(10, 11), running], [{ ...running }])
    const loadedCalls = compute.mock.calls.filter(([entries]) => entries.length > 0)
    expect(loadedCalls.length).toBeGreaterThanOrEqual(2)
    for (const [entries] of loadedCalls) {
      expect(entries).toHaveLength(2)
      expect(entries.filter((e) => e === running)).toHaveLength(1)
    }
    expect(screen.queryByRole('button', { name: /^Lücke/ })).toBeNull()
    expect(screen.queryByText(/^ungeklärt /)).toBeNull()
  })

  it('keeps two segments of one entry as separate coverage (#489 counter-check)', async () => {
    const split = { ...entry(9, 10), id: 489, segment_seq: 0, segment_count: 2 }
    const later = { ...entry(10, 11), id: 489, segment_seq: 1, segment_count: 2 }
    await mount([split, later], [])
    expect(
      screen.getByRole('button', { name: 'Lücke 08:00–09:00 · ungeklärt 1:00 · nachtragen' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Lücke 10:00/ })).toBeNull()
  })

  it('updates the stopped timer when working hours change in the store without remounting', async () => {
    useSettingsStore.setState({
      settings: {
        working_hours: JSON.stringify({ start: '13:00', end: '18:00', days: [1] })
      } as Settings
    })
    await mount([entry(9, 10)])
    expect(screen.getByText('Bereit', { exact: true })).toBeInTheDocument()
    expect(screen.queryByText(/Bereit · ungeklärt seit/)).not.toBeInTheDocument()

    act(() => {
      useSettingsStore.setState((s) => ({
        settings: {
          ...s.settings!,
          working_hours: JSON.stringify({ start: '08:00', end: '18:00', days: [1] })
        }
      }))
    })

    expect(screen.getByText('Bereit · ungeklärt seit 10:00')).toBeInTheDocument()
    expect(screen.queryByText('Bereit', { exact: true })).not.toBeInTheDocument()
  })

  it('passes the trailing gap to the stopped timer display', async () => {
    await mount([entry(9, 10)])
    expect(screen.getByText('Bereit · ungeklärt seit 10:00')).toBeInTheDocument()
  })

  it('opens the clicked gap and can reopen with a different gap', async () => {
    await mount([entry(9, 10)])
    await click('Lücke 08:00–09:00 · ungeklärt 1:00 · nachtragen')
    expectTimes('08:00', '09:00')
    await click('Abbrechen')
    await click('Lücke 10:00–12:00 · ungeklärt 2:00 · nachtragen')
    expectTimes('10:00', '12:00')
  })

  it('opens add-entry at the latest gap and keeps the form stable as time advances', async () => {
    await mount([entry(9, 10)])
    await click(/Eintrag nachtragen/)
    expectTimes('10:00', '12:00')
    act(() => vi.advanceTimersByTime(60_000))
    expectTimes('10:00', '12:00')
  })

  it('uses the latest internal gap while the current time is already covered', async () => {
    await mount([entry(9, 10), entry(11, 12)])
    await click(/Eintrag nachtragen/)
    expectTimes('10:00', '11:00')
  })

  it.each([{ entries: [] }, { entries: [entry(8, 12)] }])(
    'keeps the old one-hour-ago default without a gap (%j)',
    async ({ entries }) => {
      await mount(entries)
      expect(screen.queryByRole('button', { name: /^Lücke/ })).toBeNull()
      await click(/Eintrag nachtragen/)
      expectTimes('11:00', '12:00')
    }
  )

  it('rounds the gap start up and the end down, so the backfill never overlaps a neighbour', async () => {
    // The neighbours stop at 09:00:37 and start again at 10:30:20 (local).
    const before = { ...entry(8, 9), stopped_at: new Date(2026, 7, 10, 9, 0, 37).toISOString() }
    const after = {
      ...entry(10, 11),
      id: 99,
      started_at: new Date(2026, 7, 10, 10, 30, 20).toISOString(),
      stopped_at: local(12).toISOString()
    }
    await mount([before, after])
    await click(/^Lücke 09:00–10:30/)
    expectTimes('09:01', '10:30')
  })

  it('uses the configured window end after working hours', async () => {
    vi.setSystemTime(local(19))
    useSettingsStore.setState({
      settings: {
        working_hours: JSON.stringify({ start: '08:00', end: '16:00', days: [1] })
      } as Settings
    })
    await mount([entry(9, 10)])
    await click(/Eintrag nachtragen/)
    expectTimes('10:00', '16:00')
  })
})
