/**
 * Fresh module registry per test, as in useTimer.test.tsx: initRan and
 * listenersInstalled must register against each test's own onDataChanged mock.
 * Import views, providers and stores dynamically so they share that registry.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Entry } from '../../../shared/types'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { matchMedia?: unknown }).matchMedia
})

async function setup(view: 'calendar' | 'today' = 'calendar'): Promise<{
  changed: () => void
  getByMonth: ReturnType<typeof vi.fn>
  summary: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  rows: Entry[]
  setWide: (wide: boolean) => void
}> {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 28, 12))
  const rows: Entry[] = [1, 2].map((id) => ({
    id,
    client_id: 1,
    project_id: null,
    description: `Work ${id}`,
    started_at: new Date(2026, 9, 28, 8 + id).toISOString(),
    stopped_at: new Date(2026, 9, 28, 9 + id).toISOString(),
    heartbeat_at: null,
    rounded_min: null,
    deleted_at: null,
    created_at: '',
    link_id: null,
    tags: ',work,',
    reference: '',
    billable: 1,
    private_note: '',
    version_no: 1,
    segment_seq: 0,
    billed: 0
  }))
  let changed!: () => void
  const getByMonth = vi.fn().mockResolvedValue({ ok: true, data: rows })
  const summary = vi.fn().mockResolvedValue({
    ok: true,
    data: {
      todayEntries: rows,
      recentEntries: [],
      todaySeconds: 7200,
      weekSeconds: 7200,
      weekDaySeconds: [0, 0, 7200, 0, 0, 0, 0],
      topClients30d: []
    }
  })
  const update = vi.fn().mockResolvedValue({ ok: false, error: 'Stale version' })
  const trayUpdate = vi.fn()
  window.api = {
    clients: { getAll: async () => ({ ok: true, data: [{ id: 1, name: 'Acme', active: 1 }] }) },
    projects: { getAll: async () => ({ ok: true, data: [] }) },
    entries: { getByMonth, update, getRunning: async () => ({ ok: true, data: null }) },
    dashboard: { summary, todayTotal: async () => ({ ok: true, data: 0 }) },
    tags: { getAllWithCount: async () => ({ ok: true, data: [] }) },
    tray: { update: trayUpdate },
    idle: { dismiss: vi.fn() },
    onHotkeyToggle: () => {},
    onTrayQuickStart: () => {},
    onTrayStop: () => {},
    onIdleDetected: () => {},
    onDataChanged: (callback: () => void) => {
      changed = callback
      return () => {}
    }
  } as unknown as Window['api']
  let onMediaChange = (): void => {}
  const media = {
    matches: true,
    media: '(min-width: 1120px)',
    addEventListener: (_: string, callback: () => void) => {
      onMediaChange = callback
    },
    removeEventListener: () => {}
  }
  window.matchMedia = (() => media) as unknown as typeof window.matchMedia
  const { I18nProvider } = await import('../contexts/I18nContext')
  const View =
    view === 'calendar'
      ? (await import('./CalendarView')).default
      : (await import('./TodayView')).default
  render(
    <I18nProvider>
      <View />
    </I18nProvider>
  )
  await screen.findByText('Work 1')
  await waitFor(() => expect(trayUpdate).toHaveBeenCalled())
  expect(changed).toBeTypeOf('function')
  return {
    changed,
    getByMonth,
    summary,
    update,
    rows,
    setWide: (wide) => {
      media.matches = wide
      onMediaChange()
    }
  }
}

function openEditor(): HTMLTextAreaElement {
  fireEvent.click(screen.getAllByRole('button', { name: 'Bearbeiten' })[0])
  return screen.getByLabelText(/^Beschreibung/)
}

it('reloads the shown calendar month through data:changed and displays the new state', async () => {
  const { changed, getByMonth, rows } = await setup()
  getByMonth.mockResolvedValue({ ok: true, data: [{ ...rows[0], description: 'External write' }] })
  await act(async () => changed())
  expect(await screen.findByText('External write')).toBeVisible()
  expect(getByMonth).toHaveBeenCalledTimes(2)
  expect(getByMonth).toHaveBeenLastCalledWith({ year: 2026, month: 10 })
})

it('fetches the Heute summary again through data:changed with no timer change', async () => {
  const { changed, summary } = await setup('today')
  const before = summary.mock.calls.length
  await act(async () => changed())
  await waitFor(() => expect(summary).toHaveBeenCalledTimes(before + 1))
})

it('keeps the calendar editor snapshot and sends its old expected_version after a newer write', async () => {
  const { changed, getByMonth, rows, update } = await setup()
  const input = openEditor()
  fireEvent.change(input, { target: { value: 'My draft' } })
  getByMonth.mockResolvedValue({
    ok: true,
    data: [
      { ...rows[0], version_no: 2, description: 'External write', segment_seq: 1, tags: ',other,' },
      rows[1]
    ]
  })
  await act(async () => changed())
  await waitFor(() => expect(getByMonth).toHaveBeenCalledTimes(2))
  expect(screen.getByLabelText(/^Beschreibung/)).toBe(input)
  expect(input).toHaveValue('My draft')
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        expected_version: 1,
        description: 'My draft',
        segment_seq: 0
      })
    )
  )
  expect(await screen.findByText('Stale version')).toBeVisible()
  expect(input).toHaveValue('My draft')
})

it('refreshes billed in the open calendar form when the version stays the same', async () => {
  const { changed, getByMonth, rows, update } = await setup()
  const input = openEditor()
  fireEvent.change(input, { target: { value: 'After billing' } })
  getByMonth.mockResolvedValue({ ok: true, data: [{ ...rows[0], billed: 1 }, rows[1]] })
  await act(async () => changed())
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  expect(await screen.findByRole('alertdialog')).toBeVisible()
  expect(update).not.toHaveBeenCalled()
  expect(input).toHaveValue('After billing')
})

it('closes the calendar editor only after a completed load removes its entry', async () => {
  const { changed, getByMonth, rows, setWide } = await setup()
  const input = openEditor()
  let finish!: (value: unknown) => void
  getByMonth.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  await act(async () => changed())
  expect(input).toBeInTheDocument()
  await act(async () => finish({ ok: true, data: [rows[1]] }))
  expect(screen.queryByLabelText(/^Beschreibung/)).toBeNull()
  // Removal releases busy state, so the empty editor does not pin the wide panel.
  act(() => setWide(false))
  expect(screen.queryByText('Work 2')).toBeNull()
  act(() => setWide(true))
  fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }))
  expect(screen.getByLabelText(/^Beschreibung/)).toHaveValue('Work 2')
  screen.getByLabelText(/^Beschreibung/).focus()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByLabelText(/^Beschreibung/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Bearbeiten' })).toHaveFocus()
})

it('preserves typed calendar input and mounted nodes while another entry reloads', async () => {
  const { changed, getByMonth, rows } = await setup()
  const input = openEditor()
  const row = input.closest('li')
  fireEvent.change(input, { target: { value: 'Unsaved draft' } })
  let finish!: (value: unknown) => void
  getByMonth.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  await act(async () => changed())
  expect(screen.getByLabelText(/^Beschreibung/)).toBe(input)
  expect(input).toHaveValue('Unsaved draft')
  await act(async () =>
    finish({
      ok: true,
      data: [rows[0], { ...rows[1], description: 'Other changed', version_no: 2 }]
    })
  )
  expect(await screen.findByText('Other changed')).toBeVisible()
  expect(screen.getByLabelText(/^Beschreibung/)).toBe(input)
  expect(input.closest('li')).toBe(row)
  expect(input).toHaveValue('Unsaved draft')
})

it.each(['refusal', 'rejection'])(
  'keeps the calendar form and draft after a reload %s',
  async (failure) => {
    const { changed, getByMonth } = await setup()
    const input = openEditor()
    fireEvent.change(input, { target: { value: 'Keep me' } })
    if (failure === 'refusal') getByMonth.mockResolvedValue({ ok: false, error: 'Reload failed' })
    else getByMonth.mockRejectedValue(new Error('Reload failed'))
    await act(async () => changed())
    expect(await screen.findByTitle(/Reload failed/)).toBeVisible()
    expect(screen.getByLabelText(/^Beschreibung/)).toBe(input)
    expect(input).toHaveValue('Keep me')
    expect(within(input.closest('form')!).getByRole('button', { name: 'Speichern' })).toBeEnabled()
  }
)
