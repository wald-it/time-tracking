import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type Database from 'better-sqlite3'
import type { Entry, Settings, UpdateEntryInput } from '../../../shared/types'
import { applyMigrations, loadSqlite } from '../../../test/sqlite'
import { startTimer, updateManualEntry } from '../../../main/entryMutations'

let db: Database.Database
afterEach(() => {
  cleanup()
  db?.close()
  vi.useRealTimers()
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- test fixture: the return shape is the stores and handles the tests read, inferred on purpose
async function setup(
  options: {
    hours?: number
    description?: string
    threshold?: string
    settingsPending?: boolean
  } = {}
) {
  vi.resetModules()
  vi.useFakeTimers()
  const now = new Date(2026, 10, 2, 2)
  vi.setSystemTime(now)
  const Sqlite = await loadSqlite()
  db = new Sqlite(':memory:')
  applyMigrations(db)
  db.exec(
    "INSERT INTO clients (id, name, color, active, rate_cent) VALUES (1, 'Acme', '#111', 1, 0)"
  )
  const started = startTimer(db, {
    client_id: 1,
    description: options.description ?? 'Work',
    started_at: new Date(now.getTime() - (options.hours ?? 8) * 3_600_000).toISOString()
  })
  if (!started.ok) throw new Error(started.error)
  const entry = started.data
  let mainEntry: Entry | null = entry
  let dataChanged = (): void => {}
  let idleDetected: (event: { idleSince: string; idleSeconds: number }) => void = () => {}
  const { useTimer } = await import('./useTimer')
  const { useTimerStore } = await import('../store/timerStore')
  const { useEntriesStore } = await import('../store/entriesStore')
  const { useSettingsStore } = await import('../store/settingsStore')
  const { LongRunModal } = await import('../components/LongRunModal')
  const { IdleModal } = await import('../components/IdleModal')
  const { I18nProvider } = await import('../contexts/I18nContext')
  const { NowProvider } = await import('../contexts/NowContext')
  const { askedLongRunEntries } = await import('./longRunPrompt')
  useSettingsStore.setState({
    settings: options.settingsPending
      ? null
      : ({ long_run_threshold_hours: options.threshold } as Settings)
  })
  const api = {
    clients: { getAll: async () => ({ ok: true, data: [{ id: 1, name: 'Acme', active: 1 }] }) },
    entries: {
      getRunning: async () => ({ ok: true, data: mainEntry }),
      heartbeat: vi.fn(),
      stopAt: vi.fn(
        async (
          _id: number,
          iso: string
        ): Promise<{ ok: true; data: Entry } | { ok: false; error: string }> => ({
          ok: true,
          data: { ...entry, stopped_at: iso }
        })
      ),
      update: vi.fn(async (input: UpdateEntryInput) => updateManualEntry(db, input))
    },
    dashboard: {
      todayTotal: async () => ({ ok: true, data: 100 }),
      summary: async () => ({ ok: true, data: { recentEntries: [] } })
    },
    tray: { update: vi.fn() },
    idle: { dismiss: vi.fn() },
    projects: { getAll: async () => ({ ok: true, data: [] }) },
    tags: { getAllWithCount: async () => ({ ok: true, data: [] }) },
    onHotkeyToggle: () => {},
    onTrayQuickStart: () => {},
    onTrayStop: () => {},
    onDataChanged: (cb: () => void) => {
      dataChanged = cb
    },
    onIdleDetected: (cb: typeof idleDetected) => {
      idleDetected = cb
    }
  }
  Object.assign(window, { api })
  function Harness(): React.JSX.Element {
    const timer = useTimer({ engine: true })
    return (
      <NowProvider running={!!timer.runningEntry}>
        <LongRunModal key={timer.runningEntry?.id ?? 'stopped'} />
        {timer.idleEvent && (
          <IdleModal
            {...timer.idleEvent}
            onKeep={timer.idleKeep}
            onStopAtIdle={timer.idleStopAtIdle}
            onMarkPause={timer.idleMarkPause}
            onWorkFor={timer.idleWorkFor}
            clients={timer.clients}
            runningClientId={timer.runningEntry?.client_id ?? null}
            isLoading={timer.isLoading}
          />
        )}
      </NowProvider>
    )
  }
  await act(async () => {
    render(
      <I18nProvider>
        <Harness />
      </I18nProvider>
    )
  })
  return {
    api,
    entry,
    now,
    useTimerStore,
    useEntriesStore,
    useSettingsStore,
    askedLongRunEntries,
    idle: async () => {
      await act(async () => idleDetected({ idleSince: entry.started_at, idleSeconds: 28_800 }))
    },
    external: async (next: Entry | null) => {
      mainEntry = next
      await act(async () => dataChanged())
    }
  }
}

const longDialog = (): HTMLElement | null =>
  screen.queryByRole('dialog', { name: 'Timer läuft schon lange' })
const stopButton = (): HTMLElement => screen.getByRole('button', { name: 'Stoppen um …' })
async function click(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}
async function tick(ms = 30_000): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('long-running engine and dialog', () => {
  it('asks immediately on restart at six hours, focuses keep, and does not repeat after keep', async () => {
    const s = await setup({ hours: 6 })
    expect(longDialog()).toBeInTheDocument()
    await tick(0)
    expect(screen.getByRole('button', { name: 'Weiter laufen lassen' })).toHaveFocus()
    expect(s.askedLongRunEntries.size).toBe(0)
    await click('Weiter laufen lassen')
    await tick(120_000)
    expect(longDialog()).toBeNull()
    expect(s.api.entries.heartbeat).toHaveBeenCalledTimes(4)
    expect(s.askedLongRunEntries.has(s.entry.id)).toBe(true)
  })
  it('checks on the heartbeat and respects the saved threshold after settings load', async () => {
    const s = await setup({ hours: 6, settingsPending: true })
    expect(longDialog()).toBeNull()
    act(() =>
      s.useSettingsStore.setState({ settings: { long_run_threshold_hours: '7' } as Settings })
    )
    expect(longDialog()).toBeNull()
    await tick(3_600_000)
    expect(longDialog()).toBeInTheDocument()
  })
  // A running entry is amended in place (main's amendEntry keeps version_no):
  // the edit shows in the fields, not in the version.
  it('edit then save keeps the id and the timer, changes the fields, and never asks again', async () => {
    const s = await setup()
    await click('Bearbeiten')
    fireEvent.change(screen.getByDisplayValue('Work'), { target: { value: 'Edited' } })
    await act(async () => {
      fireEvent.submit(screen.getByDisplayValue('Edited').closest('form')!)
    })
    await tick(300)
    const running = s.useTimerStore.getState().runningEntry!
    expect(running.id).toBe(s.entry.id)
    expect(running.stopped_at).toBeNull()
    expect(running.description).toBe('Edited')
    await tick(60_000)
    expect(longDialog()).toBeNull()
  })
  it('cancelling edit still counts as the answer', async () => {
    await setup()
    await click('Bearbeiten')
    await click('Abbrechen')
    await tick(60_000)
    expect(longDialog()).toBeNull()
  })
  it('idle hides a pending long-run prompt without answering it; idle keep answers both', async () => {
    const s = await setup()
    await s.idle()
    expect(longDialog()).toBeNull()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: 'Inaktivität erkannt' })).toBeInTheDocument()
    expect(s.askedLongRunEntries.size).toBe(0)
    await click('Weiter laufen lassen')
    await tick(60_000)
    expect(longDialog()).toBeNull()
    expect(s.askedLongRunEntries.has(s.entry.id)).toBe(true)
  })
  it('returns after idle hides it if the same entry remains unanswered', async () => {
    const s = await setup()
    await s.idle()
    act(() => s.useTimerStore.getState().setIdleEvent(null))
    expect(longDialog()).toBeInTheDocument()
    expect(s.askedLongRunEntries.size).toBe(0)
  })
  it('hides on external stop or entry change without marking the old entry', async () => {
    const s = await setup()
    await s.external({ ...s.entry, id: 999, started_at: new Date().toISOString() })
    expect(longDialog()).toBeNull()
    expect(s.askedLongRunEntries.size).toBe(0)
    await s.external(s.entry)
    expect(longDialog()).toBeInTheDocument()
    await s.external(null)
    expect(longDialog()).toBeNull()
    expect(s.askedLongRunEntries.size).toBe(0)
  })
  it.each([
    ['2026-11-01', '23:30'],
    ['2026-11-02', '01:00']
  ])('stops at local date %s time %s and refreshes entries', async (date, time) => {
    const s = await setup()
    const before = s.useEntriesStore.getState().version
    fireEvent.change(screen.getByLabelText('Datum'), { target: { value: date } })
    fireEvent.change(screen.getByLabelText('Ende'), { target: { value: time } })
    await click('Stoppen um …')
    expect(s.api.entries.stopAt).toHaveBeenCalledExactlyOnceWith(
      s.entry.id,
      new Date(`${date}T${time}:00`).toISOString()
    )
    expect(s.useEntriesStore.getState().version).toBe(before + 1)
    expect(s.useTimerStore.getState().runningEntry).toBeNull()
    expect(s.useTimerStore.getState().description).toBe('')
    expect(s.api.tray.update).toHaveBeenLastCalledWith(false, '', 100, null)
  })
  it('uses click time for an untouched field and opens the quick note after an empty description', async () => {
    const s = await setup({ description: '' })
    await tick(75_123)
    await click('Stoppen um …')
    expect(s.api.entries.stopAt).toHaveBeenCalledExactlyOnceWith(
      s.entry.id,
      new Date(s.now.getTime() + 75_123).toISOString()
    )
    expect(s.useTimerStore.getState().quickNoteEntry?.id).toBe(s.entry.id)
  })
  it.each([
    ['2026-11-01', '17:59'],
    ['2026-11-01', '18:00'],
    ['2026-11-02', '02:01'],
    ['', '01:00']
  ])('refuses invalid stop %s %s', async (date, time) => {
    const s = await setup()
    fireEvent.change(screen.getByLabelText('Datum'), { target: { value: date } })
    fireEvent.change(screen.getByLabelText('Ende'), { target: { value: time } })
    expect(stopButton()).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Das Ende muss nach dem Start liegen')
    fireEvent.click(stopButton())
    expect(s.api.entries.stopAt).not.toHaveBeenCalled()
  })
  it('rechecks bounds at click time after the clock moves backwards', async () => {
    const s = await setup()
    fireEvent.change(screen.getByLabelText('Ende'), { target: { value: '01:59' } })
    expect(stopButton()).not.toBeDisabled()
    vi.setSystemTime(new Date(2026, 10, 2, 1, 58))
    await click('Stoppen um …')
    expect(s.api.entries.stopAt).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Das Ende muss nach dem Start liegen')
  })
  it.each(['refused', 'rejected'])('keeps the dialog and state on a %s stop', async (failure) => {
    const s = await setup({ description: '' })
    const before = s.useEntriesStore.getState().version
    if (failure === 'refused')
      s.api.entries.stopAt.mockResolvedValue({ ok: false, error: 'Cannot stop' })
    else s.api.entries.stopAt.mockRejectedValue(new Error('Cannot stop'))
    await click('Stoppen um …')
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot stop')
    expect(longDialog()).toBeInTheDocument()
    expect(s.useEntriesStore.getState().version).toBe(before)
    expect(s.useTimerStore.getState().runningEntry).toEqual(s.entry)
    expect(s.useTimerStore.getState().quickNoteEntry).toBeNull()
    expect(s.useTimerStore.getState().isLoading).toBe(false)
    await tick()
    expect(longDialog()).toBeInTheDocument()
  })
  it('disables all actions during stop IPC', async () => {
    const s = await setup()
    let finish!: (value: { ok: false; error: string }) => void
    s.api.entries.stopAt.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await click('Stoppen um …')
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
    await act(async () => {
      finish({ ok: false, error: 'Cannot stop' })
    })
  })
})
