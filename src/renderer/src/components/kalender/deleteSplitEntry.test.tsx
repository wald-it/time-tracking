/**
 * Deleting an entry across midnight from the calendar's day panel, end to end
 * (#323): the real `DayDetails` delete key and confirm dialog → `entries:delete`
 * (the real `deleteEntry` on a real database) → the toast's undo →
 * `entries:undelete` (the real `undeleteEntry`).
 *
 * The day panel shows only the half on its own day, so the user deletes one
 * row; both halves have to go, and undo has to bring both back.
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

function deletedFlags(db: Database.Database, linkId: string): boolean[] {
  return (
    db
      .prepare(`SELECT deleted_at FROM entries WHERE link_id = ? ORDER BY started_at`)
      .all(linkId) as Array<{ deleted_at: string | null }>
  ).map((r) => r.deleted_at !== null)
}

describe('day panel: delete and undo an entry across midnight (#323)', () => {
  it('deleting the half shown on the second day removes both halves; undo restores both', async () => {
    const db = new DatabaseImpl(':memory:')
    seed(db)
    const created = createManualEntry(db, {
      client_id: 1,
      description: 'Nachtschicht',
      started_at: new Date(2026, 5, 10, 23, 0, 0).toISOString(),
      stopped_at: new Date(2026, 5, 11, 1, 0, 0).toISOString()
    })
    if (!created.ok) throw new Error(created.error)
    const linkId = created.data.link_id!
    const secondHalf = db
      .prepare(`SELECT * FROM entries WHERE link_id = ? ORDER BY started_at DESC LIMIT 1`)
      .get(linkId) as Entry
    const clients = db.prepare(`SELECT * FROM clients ORDER BY id`).all() as Client[]
    installApi(db)

    render(
      <I18nProvider>
        <DayDetails dateISO="2026-06-11" entries={[secondHalf]} clients={clients} projects={[]} />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }))
    const dialog = screen.getByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Löschen' }))

    await waitFor(() => expect(deletedFlags(db, linkId)).toEqual([true, true]))

    const toast = useToastStore.getState().toasts.find((t) => t.action?.type === 'undo_delete')
    expect(toast).toBeDefined()
    await act(async () => {
      await useToastStore.getState().executeAction(toast!.id)
    })
    expect(deletedFlags(db, linkId)).toEqual([false, false])
  })
})
