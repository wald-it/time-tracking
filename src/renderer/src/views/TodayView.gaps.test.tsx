import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import TodayView from './TodayView'
import { I18nProvider } from '../contexts/I18nContext'
import { NowProvider } from '../contexts/NowContext'
import { useSettingsStore } from '../store/settingsStore'
import type { Client, DashboardSummary, Entry, Settings } from '../../../shared/types'

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
  vi.useRealTimers()
  useSettingsStore.setState({ settings: null })
  delete (window as unknown as { api?: unknown }).api
})

async function mount(entries: Entry[]): Promise<void> {
  const summary: DashboardSummary = {
    todayEntries: entries,
    recentEntries: [],
    topClients30d: [],
    todaySeconds: 3600,
    weekSeconds: 3600,
    weekDaySeconds: [3600, 0, 0, 0, 0, 0, 0]
  }
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
