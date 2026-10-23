/**
 * The quick-start switch end to end, renderer and main process together:
 * `useTimer().switchTo` → `entries:switch` (the real `switchTimer` on a real
 * database) → the quick note opens for the STOPPED entry → saving it through
 * the real `QuickNoteModal` → `entries:update` (the real `updateManualEntry`).
 *
 * The parts are tested alone in useTimer.test.tsx (mocked main process) and
 * QuickNoteModal.test.tsx (fixed entry). What only the chain can show: the
 * entry the prompt receives is the one the main process actually stopped, and
 * after the save the database row still carries its project, billable flag,
 * reference, private note and tags — `entries:update` re-inserts the row and
 * defaults every field it is not given.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../../../test/sqlite'
import { seed } from '../../../test/bridgeKit'
import { switchTimer, updateManualEntry } from '../../../main/entryMutations'
import { readDescriptionSuggestions } from '../../../main/descriptionSuggestions'
import type { Client, CreateEntryInput, Entry, UpdateEntryInput } from '../../../shared/types'
import type { UseTimerResult } from './useTimer'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

// `globals` is off, so Testing Library's auto-cleanup is not registered.
afterEach(() => {
  cleanup()
})

function installApi(db: Database.Database): { trayUpdate: ReturnType<typeof vi.fn> } {
  const trayUpdate = vi.fn()
  const api = {
    clients: {
      getAll: async () => ({
        ok: true as const,
        data: db.prepare(`SELECT * FROM clients ORDER BY id`).all() as Client[]
      })
    },
    entries: {
      getRunning: async () => ({
        ok: true as const,
        data:
          (db
            .prepare(
              `SELECT * FROM entries WHERE stopped_at IS NULL AND deleted_at IS NULL
                ORDER BY started_at DESC LIMIT 1`
            )
            .get() as Entry | undefined) ?? null
      }),
      switch: async (input: CreateEntryInput) => switchTimer(db, input),
      update: async (input: UpdateEntryInput) => updateManualEntry(db, input),
      // Q8: the prompt's suggestions, from the same database.
      recentDescriptions: async (pair: { clientId: number; projectId: number | null }) => ({
        ok: true as const,
        data: readDescriptionSuggestions(db, pair.clientId, pair.projectId)
      }),
      heartbeat: async () => ({ ok: true as const, data: undefined })
    },
    dashboard: { todayTotal: async () => ({ ok: true as const, data: 0 }) },
    tray: { update: trayUpdate },
    idle: { dismiss: vi.fn() },
    settings: { set: async () => ({ ok: true as const, data: undefined }) },
    onHotkeyToggle: () => {},
    onTrayQuickStart: () => {},
    onTrayStop: () => {},
    onDataChanged: () => {},
    onIdleDetected: () => {}
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { trayUpdate }
}

describe('quick-start switch → quick note → save (real main-process mutations)', () => {
  it('prompts for the stopped entry and the save keeps project, billable, reference, note and tags', async () => {
    const db = new DatabaseImpl(':memory:')
    seed(db)
    const startedAt = new Date(Date.now() - 60 * 60_000).toISOString()
    db.prepare(
      `INSERT INTO entries (id, client_id, project_id, description, started_at, heartbeat_at,
                            billable, reference, private_note, tags)
       VALUES (1, 1, 10, '', ?, ?, 0, 'JIRA-7', 'intern', ',ops,')`
    ).run(startedAt, startedAt)
    const { trayUpdate } = installApi(db)

    // Fresh module instances (useTimer keeps module-level singletons), wired
    // as App wires them: the engine instance owns the prompt.
    vi.resetModules()
    const { useTimer } = await import('./useTimer')
    const { QuickNoteModal } = await import('../components/QuickNoteModal')
    const { I18nProvider } = await import('../contexts/I18nContext')
    const timer: { current: UseTimerResult | null } = { current: null }
    function Harness(): React.JSX.Element | null {
      const t = useTimer({ engine: true })
      timer.current = t
      return t.quickNoteEntry ? (
        <QuickNoteModal
          key={t.quickNoteEntry.id}
          entry={t.quickNoteEntry}
          onDone={() => t.setQuickNoteEntry(null)}
        />
      ) : null
    }
    render(
      <I18nProvider>
        <Harness />
      </I18nProvider>
    )
    await waitFor(() => expect(trayUpdate).toHaveBeenCalled())
    await waitFor(() => expect(timer.current?.runningEntry?.id).toBe(1))

    await act(async () => {
      await timer.current!.switchTo(2, 20)
    })

    // The prompt is for the entry the main process stopped, not the new one.
    const running = timer.current!.runningEntry!
    expect(running).toMatchObject({ client_id: 2, project_id: 20, stopped_at: null })
    expect(timer.current!.quickNoteEntry).toMatchObject({ id: 1, stopped_at: running.started_at })

    const input = await screen.findByRole('textbox')
    fireEvent.change(input, { target: { value: 'Rollout vorbereitet' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    await waitFor(() => expect(timer.current!.quickNoteEntry).toBeNull())

    const rows = db
      .prepare(
        `SELECT client_id, project_id, description, started_at, stopped_at, billable,
                reference, private_note, tags, deleted_at
           FROM entries ORDER BY started_at`
      )
      .all()
    expect(rows).toEqual([
      {
        client_id: 1,
        project_id: 10,
        description: 'Rollout vorbereitet',
        started_at: startedAt,
        // Still ends where the new entry begins: no gap, no overlap.
        stopped_at: running.started_at,
        billable: 0,
        reference: 'JIRA-7',
        private_note: 'intern',
        tags: ',ops,',
        deleted_at: null
      },
      {
        client_id: 2,
        project_id: 20,
        description: '',
        started_at: running.started_at,
        stopped_at: null,
        billable: 1,
        reference: '',
        private_note: '',
        tags: '',
        deleted_at: null
      }
    ])
    db.close()
  })
})
