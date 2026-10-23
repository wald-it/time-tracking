/**
 * #334: the first half of an entry across midnight (20:00 to 00:00) could not
 * be saved in the drawer. The form parses start and stop on the same date, so
 * a stop of 00:00 landed before the start and "end after start" refused even
 * a description-only change. A stop of 00:00 after a later start is the end
 * of the day — midnight of the next one.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EntryEditForm } from './EntryEditForm'
import { I18nProvider } from '../contexts/I18nContext'
import type { Client, Entry } from '../../../shared/types'

afterEach(cleanup)

const local = (d: number, h: number, m = 0): string => new Date(2026, 5, d, h, m).toISOString()

const CLIENTS = [{ id: 1, name: 'Acme', active: 1 } as Client]

const FIRST_HALF: Entry = {
  id: 7,
  client_id: 1,
  description: 'Nachtschicht',
  started_at: local(10, 20),
  stopped_at: local(11, 0),
  heartbeat_at: local(11, 0),
  rounded_min: 240,
  deleted_at: null,
  created_at: '2026-06-10 18:00:00',
  link_id: 'L1',
  tags: '',
  reference: '',
  billable: 1,
  private_note: '',
  project_id: null
}

function mount(entry: Entry): ReturnType<typeof vi.fn> {
  const update = vi.fn(async () => ({ ok: true as const, data: entry }))
  ;(window as unknown as { api: unknown }).api = {
    entries: { update, create: vi.fn() },
    projects: { getAll: vi.fn(async () => ({ ok: true as const, data: [] })) },
    tags: { getAllWithCount: vi.fn(async () => ({ ok: true as const, data: [] })) }
  }
  render(
    <I18nProvider>
      <EntryEditForm entry={entry} clients={CLIENTS} onSaved={() => {}} onCancel={() => {}} />
    </I18nProvider>
  )
  return update
}

describe('EntryEditForm and the end of the day (#334)', () => {
  it('the first half of an entry across midnight saves, its end is midnight of the next day', async () => {
    const update = mount(FIRST_HALF)
    fireEvent.change(screen.getByDisplayValue('Nachtschicht'), {
      target: { value: 'Nachtschicht (Wartung)' }
    })
    fireEvent.submit(screen.getByDisplayValue('Nachtschicht (Wartung)').closest('form')!)
    await waitFor(() => expect(update).toHaveBeenCalled())
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 7,
        description: 'Nachtschicht (Wartung)',
        started_at: local(10, 20),
        stopped_at: local(11, 0)
      })
    )
  })

  it('a stop before a later start is still refused (no silent overnight entry)', async () => {
    const update = mount({ ...FIRST_HALF, stopped_at: local(10, 19), link_id: null })
    fireEvent.submit(screen.getByDisplayValue('Nachtschicht').closest('form')!)
    await new Promise((r) => setTimeout(r, 50))
    expect(update).not.toHaveBeenCalled()
  })
})
