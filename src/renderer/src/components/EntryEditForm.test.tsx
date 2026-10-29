/**
 * #334: the first half of an entry across midnight (20:00 to 00:00) could not
 * be saved in the drawer. The form parses start and stop on the same date, so
 * a stop of 00:00 landed before the start and "end after start" refused even
 * a description-only change. On an entry that ends at the next midnight, a stop
 * of 00:00 is that midnight; a new entry keeps the old, same-day reading.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { EntryEditForm } from './EntryEditForm'
import { I18nProvider } from '../contexts/I18nContext'
import type { Client, Entry, UpdateEntryInput } from '../../../shared/types'

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

const local = (d: number, h: number, m = 0): string => new Date(2026, 5, d, h, m).toISOString()

// Codex counter-check on 2.0 P2: an update is a patch, and a field left out
// keeps its value. "No project" must therefore be sent as null, not left out,
// or the old project stays and a client change fails on the project rule.
describe('EntryEditForm sends "no project" as null (2.0 patch)', () => {
  it('choosing the placeholder sends project_id: null', async () => {
    const entry: Entry = {
      id: 9,
      client_id: 1,
      description: 'Mit Projekt',
      started_at: local(10, 9),
      stopped_at: local(10, 10),
      heartbeat_at: local(10, 10),
      rounded_min: null,
      deleted_at: null,
      created_at: '2026-06-10 08:00:00',
      link_id: null,
      tags: '',
      reference: '',
      billable: 1,
      private_note: '',
      project_id: 5
    }
    const update = vi.fn<(input: UpdateEntryInput) => Promise<{ ok: true; data: Entry }>>(
      async () => ({ ok: true as const, data: entry })
    )
    ;(window as unknown as { api: unknown }).api = {
      entries: { update, create: vi.fn() },
      projects: {
        getAll: vi.fn(async () => ({
          ok: true as const,
          data: [{ id: 5, client_id: 1, name: 'Rollout', status: 'active', active: 1 }]
        }))
      },
      tags: { getAllWithCount: vi.fn(async () => ({ ok: true as const, data: [] })) }
    }
    render(
      <I18nProvider>
        <EntryEditForm
          entry={entry}
          defaultDate={new Date(2026, 5, 10, 9)}
          clients={[{ id: 1, name: 'Acme', active: 1 } as Client]}
          onSaved={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>
    )
    const picker = (await screen.findByDisplayValue('Rollout')) as HTMLSelectElement
    fireEvent.change(picker, { target: { value: '' } })
    fireEvent.submit(picker.closest('form')!)
    await waitFor(() => expect(update).toHaveBeenCalled())
    const sent = update.mock.calls[0][0]
    expect(sent).toMatchObject({ id: 9, project_id: null })
    expect('project_id' in sent).toBe(true)
  })
})

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

describe('billed entry edits', () => {
  it('does not ask for a reason for an unbilled content edit', async () => {
    const update = mount({ ...FIRST_HALF, billed: 0 })
    fireEvent.change(screen.getByDisplayValue('Nachtschicht'), { target: { value: 'Correction' } })
    fireEvent.submit(screen.getByDisplayValue('Correction').closest('form')!)
    await waitFor(() => expect(update).toHaveBeenCalled())
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('shows a backend lock error on save when the loaded status is stale', async () => {
    const update = mount(FIRST_HALF)
    update.mockResolvedValue({ ok: false, error: 'BILLED_ENTRY_ERROR: ABC-2026-001' })
    fireEvent.change(screen.getByDisplayValue('Nachtschicht'), { target: { value: 'Correction' } })
    fireEvent.submit(screen.getByDisplayValue('Correction').closest('form')!)
    expect((await screen.findByRole('alert')).textContent).toBe('BILLED_ENTRY_ERROR: ABC-2026-001')
  })

  it('asks for a non-empty reason, permits cancellation, and sends the reason on save', async () => {
    const update = mount({ ...FIRST_HALF, billed: 1 } as Entry)
    const description = screen.getByDisplayValue('Nachtschicht')
    fireEvent.change(description, { target: { value: 'Correction' } })
    fireEvent.submit(description.closest('form')!)
    expect(update).not.toHaveBeenCalled()
    const dialog = screen.getByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }))
    expect(update).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('alert').textContent).toContain('Grund')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByDisplayValue('Correction')).toBeTruthy()
    fireEvent.submit(description.closest('form')!)
    fireEvent.change(screen.getByLabelText('Grund'), {
      target: { value: '  Falsche Beschreibung  ' }
    })
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Speichern' })
    )
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'Falsche Beschreibung', description: 'Correction' })
      )
    )
  })

  it('saves a private note without asking, preserving displayed seconds and midnight', async () => {
    const update = mount({
      ...FIRST_HALF,
      billed: 1,
      started_at: local(10, 20).replace(':00.000', ':27.000')
    } as Entry)
    fireEvent.change(screen.getByLabelText(/Interne Notiz/), { target: { value: 'Only for me' } })
    fireEvent.submit(screen.getByDisplayValue('Only for me').closest('form')!)
    await waitFor(() => expect(update).toHaveBeenCalled())
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(update.mock.calls[0][0]).not.toHaveProperty('reason')
  })
})
