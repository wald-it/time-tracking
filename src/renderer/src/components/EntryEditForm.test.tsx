/**
 * #334: the first half of an entry across midnight (20:00 to 00:00) could not
 * be saved in the drawer. The form parses start and stop on the same date, so
 * a stop of 00:00 landed before the start and "end after start" refused even
 * a description-only change. On an entry that ends at the next midnight, a stop
 * of 00:00 is that midnight; a new entry keeps the old, same-day reading.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EntryEditForm } from './EntryEditForm'
import { I18nProvider } from '../contexts/I18nContext'
import type { Client, Entry } from '../../../shared/types'

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

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

function mount(entry?: Entry): ReturnType<typeof vi.fn> {
  const update = vi.fn(async () => ({ ok: true as const, data: entry }))
  const create = vi.fn(async () => ({ ok: true as const, data: entry }))
  ;(window as unknown as { api: unknown }).api = {
    entries: { update, create },
    projects: { getAll: vi.fn(async () => ({ ok: true as const, data: [] })) },
    tags: { getAllWithCount: vi.fn(async () => ({ ok: true as const, data: [] })) }
  }
  render(
    <I18nProvider>
      <EntryEditForm
        entry={entry}
        defaultDate={new Date(2026, 5, 10, 20)}
        clients={CLIENTS}
        onSaved={() => {}}
        onCancel={() => {}}
      />
    </I18nProvider>
  )
  return entry ? update : create
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

  it('a whole day from 00:00 to 00:00 saves as 24 hours', async () => {
    const update = mount({
      ...FIRST_HALF,
      started_at: local(10, 0),
      stopped_at: local(11, 0),
      link_id: null
    })
    fireEvent.submit(screen.getByDisplayValue('Nachtschicht').closest('form')!)
    await waitFor(() => expect(update).toHaveBeenCalled())
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ started_at: local(10, 0), stopped_at: local(11, 0) })
    )
  })

  it('a stop before a later start is still refused, with the message', async () => {
    const update = mount({ ...FIRST_HALF, stopped_at: local(10, 19), link_id: null })
    fireEvent.submit(screen.getByDisplayValue('Nachtschicht').closest('form')!)
    expect(
      await screen.findByText(
        /Endzeit muss nach der Startzeit liegen|End time must be after start time/
      )
    ).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
  })

  it('a new entry ending at 00:00 is not read as an overnight entry', async () => {
    const create = mount()
    // Create mode starts at 20:00 (defaultDate) and ends an hour later.
    const stop = screen.getByDisplayValue('21:00')
    fireEvent.change(stop, { target: { value: '00:00' } })
    fireEvent.submit(stop.closest('form')!)
    expect(
      await screen.findByText(
        /Endzeit muss nach der Startzeit liegen|End time must be after start time/
      )
    ).toBeTruthy()
    expect(create).not.toHaveBeenCalled()
  })
})
