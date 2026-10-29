import { afterEach, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Client, Entry, EntryVersion } from '../../../../shared/types'
import { I18nProvider } from '../../contexts/I18nContext'
import { DayDetails } from './DayDetails'

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

it('keeps an entry history open after editing and saving its end time', async () => {
  const start = new Date(2026, 9, 28, 9).toISOString()
  const stop = new Date(2026, 9, 28, 10).toISOString()
  const newStop = new Date(2026, 9, 28, 11).toISOString()
  const client: Client = {
    id: 1,
    name: 'Acme',
    active: 1,
    color: '#111',
    rate_cent: 0,
    short_code: null,
    created_at: ''
  }
  const entry: Entry = {
    id: 42,
    client_id: 1,
    project_id: null,
    description: 'Work',
    started_at: start,
    stopped_at: stop,
    heartbeat_at: null,
    rounded_min: null,
    deleted_at: null,
    created_at: start,
    link_id: null,
    tags: '',
    reference: '',
    billable: 1,
    private_note: '',
    version_no: 1,
    segment_seq: 0
  }
  const first: EntryVersion = {
    ...entry,
    project_id: null,
    version_id: 1,
    version_no: 1,
    state: 'sealed',
    deleted: false,
    written_at: stop,
    source: 'app',
    reason: null,
    segments: []
  }
  const updated = { ...entry, stopped_at: newStop, version_no: 2 }
  const second: EntryVersion = {
    ...first,
    version_id: 2,
    version_no: 2,
    written_at: newStop,
    stopped_at: newStop
  }
  const versions = vi.fn().mockResolvedValue({ ok: true, data: [first] })
  const update = vi.fn().mockImplementation(async () => {
    versions.mockResolvedValue({ ok: true, data: [first, second] })
    return { ok: true, data: updated }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      entries: { versions, update },
      projects: { getAll: vi.fn().mockResolvedValue({ ok: true, data: [] }) },
      tags: { getAllWithCount: vi.fn().mockResolvedValue({ ok: true, data: [] }) }
    }
  })
  const other = { ...entry, id: 43, description: 'Other work' }
  const details = (row: Entry): React.JSX.Element => (
    <I18nProvider>
      <DayDetails dateISO="2026-10-28" entries={[row, other]} clients={[client]} projects={[]} />
    </I18nProvider>
  )
  const view = render(details(entry))
  fireEvent.click(screen.getAllByRole('button', { name: 'Verlauf' })[0])
  expect(await screen.findByRole('list', { name: 'Verlauf' })).toBeVisible()
  fireEvent.click(screen.getAllByRole('button', { name: 'Bearbeiten' })[0])
  fireEvent.change(screen.getByLabelText('Ende'), { target: { value: '11:00' } })
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 42,
        stopped_at: newStop,
        expected_version: 1
      })
    )
  )
  await waitFor(() => expect(screen.queryByLabelText('Ende')).toBeNull())
  // The parent receives a new row after the edit; the entry and segment ids stay the same.
  view.rerender(details(updated))
  const toggles = screen.getAllByRole('button', { name: 'Verlauf' })
  expect(toggles[0]).toHaveAttribute('aria-expanded', 'true')
  expect(toggles[1]).toHaveAttribute('aria-expanded', 'false')
  const history = await screen.findByRole('list', { name: 'Verlauf' })
  expect(within(history).getByText('Version 2')).toBeVisible()
  fireEvent.click(toggles[0])
  expect(screen.queryByRole('list', { name: 'Verlauf' })).toBeNull()
})
