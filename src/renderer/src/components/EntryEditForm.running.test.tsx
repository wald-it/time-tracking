import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../../../test/sqlite'
import { startTimer, updateManualEntry, RUNNING_EDIT_ERROR } from '../../../main/entryMutations'
import type { Client, UpdateEntryInput } from '../../../shared/types'
import { EntryEditForm } from './EntryEditForm'
import { I18nProvider } from '../contexts/I18nContext'

let Sqlite: DatabaseCtor
let db: Database.Database
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
afterEach(() => {
  cleanup()
  db.close()
  vi.useRealTimers()
})

async function setup(seconds = 0, hour = 9): Promise<ReturnType<typeof vi.fn>> {
  db = new Sqlite(':memory:')
  applyMigrations(db)
  db.exec(
    "INSERT INTO clients (id, name, color, active, rate_cent) VALUES (1, 'Acme', '#111', 1, 0)"
  )
  const res = startTimer(db, {
    client_id: 1,
    description: 'Original',
    started_at: new Date(2026, 5, 10, hour, 0, seconds).toISOString()
  })
  if (!res.ok) throw new Error(res.error)
  const update = vi.fn(async (input: UpdateEntryInput) => updateManualEntry(db, input))
  Object.assign(window, {
    api: {
      entries: { update },
      projects: { getAll: async () => ({ ok: true, data: [] }) },
      tags: { getAllWithCount: async () => ({ ok: true, data: [] }) }
    }
  })
  render(
    <I18nProvider>
      <EntryEditForm
        entry={res.data}
        clients={[{ id: 1, name: 'Acme', active: 1 } as Client]}
        onSaved={() => {}}
        onCancel={() => {}}
      />
    </I18nProvider>
  )
  await screen.findByDisplayValue('Original')
  return update
}

describe('running entry form (#485)', () => {
  it.each([0, 27])(
    'description save keeps a running entry open (start seconds %s)',
    async (seconds) => {
      const update = await setup(seconds)
      fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Changed' } })
      fireEvent.submit(screen.getByDisplayValue('Changed').closest('form')!)
      await waitFor(() => expect(update).toHaveBeenCalledOnce())
      const result = await update.mock.results[0].value
      expect(result.ok).toBe(true)
      expect(result.data.stopped_at).toBeNull()
      expect(result.data.description).toBe('Changed')
      expect(update.mock.calls[0][0]).not.toHaveProperty('started_at')
      expect(update.mock.calls[0][0]).not.toHaveProperty('stopped_at')
    }
  )

  it('sends a changed start minute to main and shows its refusal', async () => {
    const update = await setup()
    fireEvent.change(screen.getByDisplayValue('09:00'), { target: { value: '09:01' } })
    fireEvent.submit(screen.getByDisplayValue('Original').closest('form')!)
    expect((await screen.findByRole('alert')).textContent).toBe(RUNNING_EDIT_ERROR)
    expect(update.mock.calls[0][0]).toHaveProperty(
      'started_at',
      new Date(2026, 5, 10, 9, 1).toISOString()
    )
  })

  // Codex counter-check on #485: a save from Today or the calendar must reach
  // the timer store too, not only a save from the long-run prompt.
  it('a saved running entry replaces the timer store entry and selection', async () => {
    const { useTimerStore } = await import('../store/timerStore')
    const update = await setup()
    const running = db.prepare('SELECT id FROM entries WHERE stopped_at IS NULL').get() as {
      id: number
    }
    useTimerStore.setState({
      runningEntry: { id: running.id, description: 'Original' } as never,
      description: 'Original'
    })
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Synced' } })
    fireEvent.submit(screen.getByDisplayValue('Synced').closest('form')!)
    await waitFor(() => expect(useTimerStore.getState().runningEntry?.description).toBe('Synced'))
    expect(useTimerStore.getState().description).toBe('Synced')
    expect(useTimerStore.getState().runningEntry?.stopped_at).toBeNull()
    expect(useTimerStore.getState().selectedClientId).toBe(1)
    expect(update).toHaveBeenCalledOnce()
    useTimerStore.setState({ runningEntry: null, description: '' })
  })

  it('can edit a running entry whose disabled end wraps midnight', async () => {
    const update = await setup(0, 23)
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Night' } })
    fireEvent.submit(screen.getByDisplayValue('Night').closest('form')!)
    await waitFor(() => expect(update).toHaveBeenCalledOnce())
    expect((await update.mock.results[0].value).data.stopped_at).toBeNull()
  })
})
