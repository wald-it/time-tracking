import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Client, Entry, EntryVersion, IpcResult } from '../../../../shared/types'
import { I18nProvider } from '../../contexts/I18nContext'
import { useEntriesStore } from '../../store/entriesStore'
import { useSettingsStore } from '../../store/settingsStore'
import { DayPanel } from './DayPanel'

const client: Client = {
  id: 1,
  name: 'Acme',
  active: 1,
  color: '#111',
  rate_cent: 0,
  created_at: ''
}
const first: EntryVersion = {
  version_id: 1,
  version_no: 1,
  state: 'sealed',
  deleted: false,
  written_at: '2026-10-28T10:00:00.000Z',
  source: 'app',
  reason: null,
  client_id: 1,
  project_id: null,
  description: 'Capture text',
  started_at: '2026-10-28T09:00:00.000Z',
  stopped_at: '2026-10-28T10:00:00.000Z',
  tags: '',
  reference: '',
  billable: 1,
  private_note: '',
  segments: [
    {
      seq: 0,
      segment_date: '2026-10-28',
      started_at: '2026-10-28T09:00:00.000Z',
      stopped_at: '2026-10-28T10:00:00.000Z'
    }
  ]
}
const note = {
  ...first,
  version_id: 2,
  version_no: 2,
  description: 'Added text',
  source: 'quicknote',
  written_at: '2026-10-28T10:01:00.000Z'
}
const later = {
  ...note,
  version_id: 3,
  version_no: 3,
  description: 'Final text',
  source: 'mcp',
  reason: 'Correct scope',
  billable: 0,
  written_at: '2026-10-28T11:00:00.000Z'
}
const entry: Entry = {
  ...later,
  id: 42,
  heartbeat_at: null,
  rounded_min: null,
  deleted_at: null,
  created_at: first.written_at,
  link_id: null
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useSettingsStore.setState({ settings: null })
})

function panel(dateISO = '2026-10-28', rows = [entry]): React.JSX.Element {
  return (
    <I18nProvider>
      <DayPanel dateISO={dateISO} entries={rows} clients={[client]} projects={[]} />
    </I18nProvider>
  )
}
function install(
  versions = vi
    .fn<(id: number) => Promise<IpcResult<EntryVersion[]>>>()
    .mockResolvedValue({ ok: true, data: [first, note, later] })
): typeof versions {
  vi.stubGlobal('api', undefined)
  Object.defineProperty(window, 'api', { configurable: true, value: { entries: { versions } } })
  return versions
}

describe('day panel entry history', () => {
  it('loads only on expansion and shows metadata, adjacent diffs and expandable capture additions', async () => {
    const versions = install()
    render(panel())
    expect(versions).not.toHaveBeenCalled()
    const toggle = screen.getByRole('button', { name: 'Verlauf' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    const history = await screen.findByRole('list', { name: 'Verlauf' })
    expect(versions).toHaveBeenCalledWith(42)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(history).getByText('Erfassung')).toBeVisible()
    expect(within(history).getByText('Version 1')).toBeVisible()
    expect(within(history).getByText('Version 2')).not.toBeVisible()
    expect(within(history).getByText('Version 3')).toBeVisible()
    expect(history.querySelector('time')).toHaveAttribute('datetime', first.written_at)
    expect(within(history).getByText('Quelle: MCP')).toBeVisible()
    expect(within(history).getByText('Grund: Correct scope')).toBeVisible()
    const latestRow = within(history).getByText('Version 3').closest('li')
    expect(latestRow).toHaveTextContent('Beschreibung: Added text → Final text')
    expect(latestRow).toHaveTextContent('Abrechenbar: Ja → Nein')
    fireEvent.click(screen.getByRole('button', { name: '1 weitere' }))
    expect(within(history).getByText('Version 2')).toBeVisible()
    expect(within(history).getByText('Version 2').closest('li')).toHaveTextContent(
      'Beschreibung: Capture text → Added text'
    )
    fireEvent.click(toggle)
    expect(screen.queryByRole('list', { name: 'Verlauf' })).toBeNull()
    fireEvent.click(toggle)
    await waitFor(() => expect(versions).toHaveBeenCalledTimes(2))
    await screen.findByRole('list', { name: 'Verlauf' })
  })

  it('shows tags, reference and internal note of the capture when set, and omits them when empty', async () => {
    const tagged = { ...first, tags: 'workshop', reference: 'PO-7', private_note: 'call back' }
    install(
      vi
        .fn<(id: number) => Promise<IpcResult<EntryVersion[]>>>()
        .mockResolvedValue({ ok: true, data: [tagged] })
    )
    render(panel())
    fireEvent.click(screen.getByRole('button', { name: 'Verlauf' }))
    const history = await screen.findByRole('list', { name: 'Verlauf' })
    const captureRow = within(history).getByText('Version 1').closest('li')
    expect(captureRow).toHaveTextContent('Tags: workshop')
    expect(captureRow).toHaveTextContent('Referenz: PO-7')
    expect(captureRow).toHaveTextContent('Interne Notiz: call back')
    cleanup()
    install()
    render(panel())
    fireEvent.click(screen.getByRole('button', { name: 'Verlauf' }))
    const plain = await screen.findByRole('list', { name: 'Verlauf' })
    const plainRow = within(plain).getByText('Version 1').closest('li')
    expect(plainRow).not.toHaveTextContent('Tags:')
    expect(plainRow).not.toHaveTextContent('Referenz:')
    expect(plainRow).not.toHaveTextContent('Interne Notiz:')
  })

  it('shows loading and an error with retry for both failed results and rejected requests', async () => {
    let resolve!: (result: IpcResult<EntryVersion[]>) => void
    const versions = install(
      vi
        .fn<(id: number) => Promise<IpcResult<EntryVersion[]>>>()
        .mockImplementationOnce(
          () =>
            new Promise((done) => {
              resolve = done
            })
        )
        .mockRejectedValueOnce(new Error('transport'))
        .mockResolvedValue({ ok: true, data: [] })
    )
    render(panel())
    fireEvent.click(screen.getByRole('button', { name: 'Verlauf' }))
    expect(screen.getByRole('status')).toHaveTextContent('Lädt')
    await act(async () => {
      resolve({ ok: false, error: 'Unavailable' })
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Verlauf konnte nicht geladen werden.')
    fireEvent.click(screen.getByRole('button', { name: 'Erneut laden' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Erneut laden' }))
    await screen.findByText('Keine Versionen vorhanden.')
    expect(versions).toHaveBeenCalledTimes(3)
  })

  it('refreshes on entry changes and starts closed when another day is selected', async () => {
    const versions = install()
    const view = render(panel())
    fireEvent.click(screen.getByRole('button', { name: 'Verlauf' }))
    await screen.findByRole('list', { name: 'Verlauf' })
    act(() => useEntriesStore.getState().bumpVersion())
    await waitFor(() => expect(versions).toHaveBeenCalledTimes(2))
    await screen.findByRole('list', { name: 'Verlauf' })
    view.rerender(panel('2026-10-29'))
    expect(screen.getByRole('button', { name: 'Verlauf' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByRole('list', { name: 'Verlauf' })).toBeNull()
  })
})
