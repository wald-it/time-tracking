/**
 * Deleting an entry across midnight from the calendar's day panel, end to end
 * (#323): the real `DayDetails` delete key and confirm dialog → `entries:delete`
 * (the real `deleteEntry` on a real database) → the toast's undo →
 * `entries:undelete` (the real `undeleteEntry`).
 *
 * The day panel shows only the segment on its own day, so the user deletes
 * one row; the whole entry has to go, and undo has to bring it back whole.
 * Since 2.0 the two halves are two segments of one entry (same `id`,
 * `segment_seq` 0 and 1), no longer two rows sharing a `link_id`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../../../../test/sqlite'
import { seed } from '../../../../test/bridgeKit'
import { createManualEntry, deleteEntry, undeleteEntry } from '../../../../main/entryMutations'
import type { Client, Entry } from '../../../../shared/types'
import { DayDetails } from './DayDetails'
import { I18nProvider } from '../../contexts/I18nContext'
import { useToastStore } from '../../store/toastStore'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
})

// `globals` is off, so Testing Library's auto-cleanup is not registered.
afterEach(() => {
  cleanup()
})

function installApi(db: Database.Database): void {
  const api = {
    entries: {
      delete: async (id: number) => deleteEntry(db, id),
      undelete: async (id: number) => undeleteEntry(db, id)
    }
  }
  ;(window as unknown as { api: typeof api }).api = api
}

/** Whether the entry is in the trash, and how many of its segments the view shows. */
function state(db: Database.Database, id: number): { trashed: boolean; shown: number } {
  const row = db.prepare(`SELECT is_deleted FROM entry WHERE id = ?`).get(id) as {
    is_deleted: number
  }
  const shown = (
    db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE id = ?`).get(id) as { n: number }
  ).n
  return { trashed: row.is_deleted === 1, shown }
}

describe('day panel: delete and undo an entry across midnight (#323)', () => {
  it('deleting the segment shown on the second day removes the whole entry; undo restores it', async () => {
    const db = new DatabaseImpl(':memory:')
    seed(db)
    const created = createManualEntry(db, {
      client_id: 1,
      description: 'Nachtschicht',
      started_at: new Date(2026, 5, 10, 23, 0, 0).toISOString(),
      stopped_at: new Date(2026, 5, 11, 1, 0, 0).toISOString()
    })
    if (!created.ok) throw new Error(created.error)
    const id = created.data.id
    expect(state(db, id)).toEqual({ trashed: false, shown: 2 })
    const secondHalf = db
      .prepare(`SELECT * FROM entries WHERE id = ? AND segment_seq = 1`)
      .get(id) as Entry
    const clients = db.prepare(`SELECT * FROM clients ORDER BY id`).all() as Client[]
    installApi(db)

    render(
      <I18nProvider>
        <DayDetails dateISO="2026-06-11" entries={[secondHalf]} clients={clients} projects={[]} />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }))
    const dialog = screen.getByRole('alertdialog')
    // 2.0 P2: the question no longer says that both days go. It keyed on
    // `link_id`, which the view always leaves NULL; the renderer learns the
    // entry shape (`segment_seq`) in P3.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Löschen' }))

    await waitFor(() => expect(state(db, id)).toEqual({ trashed: true, shown: 0 }))

    const toast = useToastStore.getState().toasts.find((t) => t.action?.type === 'undo_delete')
    expect(toast).toBeDefined()
    await act(async () => {
      await useToastStore.getState().executeAction(toast!.id)
    })
    expect(state(db, id)).toEqual({ trashed: false, shown: 2 })
  })
})
