import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Client, Entry, IpcResult } from '../../../shared/types'
import { I18nProvider } from '../contexts/I18nContext'
import { DayDetails } from './kalender/DayDetails'
import TodayView from '../views/TodayView'
import { ToastTray } from './Toast'
import { useToastStore } from '../store/toastStore'
import { useTimerStore } from '../store/timerStore'

const client: Client = {
  id: 1,
  name: 'Client',
  active: 1,
  color: 'var(--ink)',
  rate_cent: 0,
  short_code: null,
  created_at: ''
}
const entry: Entry = {
  id: 1,
  client_id: 1,
  description: 'Billed work',
  started_at: new Date(2026, 5, 10, 9).toISOString(),
  stopped_at: new Date(2026, 5, 10, 10).toISOString(),
  heartbeat_at: null,
  rounded_min: null,
  deleted_at: null,
  created_at: '',
  link_id: null,
  tags: '',
  reference: '',
  billable: 1,
  private_note: '',
  billed: 1
}
const remove = vi.fn<(id: number, reason?: string) => Promise<IpcResult<void>>>()
const restore = vi.fn<(id: number, reason?: string) => Promise<IpcResult<Entry>>>()

beforeEach(() => {
  remove.mockReset().mockResolvedValue({ ok: true, data: undefined })
  restore.mockReset().mockResolvedValue({ ok: true, data: entry })
  useToastStore.setState({ toasts: [], pendingUndo: null })
  useTimerStore.setState({ clients: [client], runningEntry: null })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function mount(view: 'calendar' | 'today', billed = 1): Promise<HTMLElement> {
  const entries = [
    { ...entry, billed },
    { ...entry, id: 2, description: 'Unbilled work', billed: 0 }
  ]
  ;(window as unknown as { api: unknown }).api = {
    entries: {
      delete: remove,
      undelete: restore,
      getRunning: async () => ({ ok: true, data: null })
    },
    clients: { getAll: async () => ({ ok: true, data: [client] }) },
    projects: { getAll: async () => ({ ok: true, data: [] }) },
    dashboard: {
      summary: async () => ({
        ok: true,
        data: {
          todayEntries: entries,
          recentEntries: entries,
          todaySeconds: 7200,
          weekSeconds: 7200,
          weekDaySeconds: [0, 0, 7200, 0, 0, 0, 0],
          topClients30d: []
        }
      }),
      todayTotal: async () => ({ ok: true, data: 7200 })
    },
    tray: { update: vi.fn() },
    idle: { dismiss: vi.fn() },
    onHotkeyToggle: () => {},
    onTrayQuickStart: () => {},
    onTrayStop: () => {},
    onDataChanged: () => {},
    onIdleDetected: () => {}
  }
  render(
    <I18nProvider>
      {view === 'calendar' ? (
        <DayDetails dateISO="2026-06-10" entries={entries} clients={[client]} projects={[]} />
      ) : (
        <TodayView />
      )}
      <ToastTray />
    </I18nProvider>
  )
  await screen.findByText('Billed work')
  return screen.getAllByRole('button', {
    name: view === 'calendar' ? 'Löschen' : /Eintrag.*löschen/
  })[0]
}

describe.each(['calendar', 'today'] as const)('%s billed entries', (view) => {
  it('shows one lock chip, requires a reason for delete and a new reason for restore', async () => {
    const deleteButton = await mount(view)
    const chip = screen.getByText('abgerechnet')
    expect(chip.parentElement!.querySelector('svg')).not.toBeNull()
    fireEvent.click(deleteButton)
    let dialog = screen.getByRole('alertdialog')
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '   ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Löschen' }))
    expect(within(dialog).getByRole('alert')).toBeTruthy()
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }))
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(deleteButton)
    dialog = screen.getByRole('alertdialog')
    expect((within(dialog).getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: '  Wrong booking  ' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Löschen' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith(1, 'Wrong booking'))
    fireEvent.click(await screen.findByRole('button', { name: 'Rückgängig' }))
    dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toContain('wiederherstellen')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Wiederherstellen' }))
    expect(restore).not.toHaveBeenCalled()
    // The original toast may expire while the user supplies the new reason.
    act(() => useToastStore.setState({ toasts: [] }))
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Keep it after all' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Wiederherstellen' }))
    await waitFor(() => expect(restore).toHaveBeenCalledWith(1, 'Keep it after all'))
  })

  it('does not show a chip or ask for a reason for unbilled delete and undo', async () => {
    fireEvent.click(await mount(view, 0))
    expect(screen.queryByText('abgerechnet')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Löschen' })
    )
    await waitFor(() => expect(remove).toHaveBeenCalledWith(1, undefined))
    fireEvent.click(await screen.findByRole('button', { name: 'Rückgängig' }))
    await waitFor(() => expect(restore).toHaveBeenCalledWith(1, undefined))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('shows a backend lock error even if billing changed after loading the entry', async () => {
    remove.mockResolvedValue({ ok: false, error: 'BILLED_ENTRY_ERROR: ABC-2026-001' })
    fireEvent.click(await mount(view, 0))
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Löschen' })
    )
    expect(await screen.findByText(/BILLED_ENTRY_ERROR: ABC-2026-001/)).toBeTruthy()
  })
})

it('cancels restore without writing, and shows a refused restore as a toast', async () => {
  await mount('calendar')
  act(() =>
    useToastStore.setState({
      pendingUndo: { type: 'undo_delete', label: 'Undo', data: { entryId: 1, billed: true } }
    })
  )
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Abbrechen' })
  )
  expect(restore).not.toHaveBeenCalled()
  expect(screen.queryByRole('alertdialog')).toBeNull()
  restore.mockResolvedValue({ ok: false, error: 'BILLED_ENTRY_ERROR: ABC-2026-001' })
  act(() =>
    useToastStore
      .getState()
      .show('Deleted', { type: 'undo_delete', label: 'Undo', data: { entryId: 1 } })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(await screen.findByText('BILLED_ENTRY_ERROR: ABC-2026-001')).toBeTruthy()
})
