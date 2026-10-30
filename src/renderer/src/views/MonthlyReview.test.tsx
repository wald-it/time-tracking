import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../contexts/I18nContext'
import { useEntriesStore } from '../store/entriesStore'
import { useSettingsStore } from '../store/settingsStore'
import ExportView from './ExportView'

const period = vi.fn()
const getForReview = vi.fn()
const update = vi.fn()
const pdf = vi.fn()
const scroll = vi.fn()
const entries = [1, 2].map((id) => ({
  id,
  client_id: 1,
  project_id: 3,
  description: `Work ${id}`,
  billable: id === 1 ? 0 : 1,
  billed: id === 2 ? 1 : 0,
  tags: '',
  reference: '',
  private_note: '',
  segment_seq: 0,
  version_no: 1,
  started_at: `2026-09-0${id}T08:00:00.000Z`,
  stopped_at: `2026-09-0${id}T09:00:00.000Z`,
  entry_start: `2026-09-0${id}T08:00:00.000Z`,
  entry_stop: `2026-09-0${id}T09:00:00.000Z`,
  duration_seconds: 3600
}))
const findings = [
  { entryId: 1, rule: 'not_billable', params: {} },
  { entryId: 2, rule: 'missing_description', params: {} }
]
beforeEach(() => {
  vi.resetAllMocks()
  useSettingsStore.setState({
    settings: {
      language: 'de',
      week_start: 'sunday',
      export_prefs: JSON.stringify({ tab: 'csv' })
    } as never
  })
  period.mockResolvedValue({ ok: true, data: findings })
  getForReview.mockResolvedValue({ ok: true, data: entries })
  update.mockImplementation(async (input) => ({ ok: true, data: { ...entries[1], ...input } }))
  pdf.mockResolvedValue({ ok: true, data: { path: 'review.pdf' } })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scroll
  })
  window.api = {
    clients: {
      getAll: async () => ({
        ok: true,
        data: [
          { id: 1, name: 'First', active: 1, rate_cent: 6000 },
          { id: 2, name: 'Second', active: 1, rate_cent: 6000 },
          { id: 9, name: 'Archived', active: 0 }
        ]
      })
    },
    projects: {
      getAll: async () => ({
        ok: true,
        data: [{ id: 3, client_id: 1, name: 'Project', active: 1 }]
      })
    },
    ruleCheck: { period },
    entries: { getForReview, update },
    tags: { getAllWithCount: async () => ({ ok: true, data: [] }) },
    settings: { set: async () => ({ ok: true, data: undefined }) },
    billingRuns: { list: async () => ({ ok: true, data: [] }) },
    billingProfile: {
      get: async () => ({ ok: true, data: { inherited: { columns: 'times', group_by: 'none' } } })
    },
    pdf: { export: pdf }
  } as unknown as Window['api']
})
afterEach(cleanup)
async function mount(): Promise<ReturnType<typeof within>> {
  render(
    <I18nProvider>
      <ExportView />
    </I18nProvider>
  )
  const section = screen.getByRole('region', { name: 'Monats-Review' })
  const ui = within(section)
  await ui.findByRole('option', { name: 'First' })
  return ui
}
async function selectClient(): Promise<ReturnType<typeof within>> {
  const ui = await mount()
  fireEvent.change(ui.getByLabelText('Review-Kunde'), { target: { value: '1' } })
  await ui.findByText('Work 2')
  return ui
}
describe('monthly review', () => {
  it('renders ordered finding lines and count, entry metadata and active client choices above the cards', async () => {
    const ui = await selectClient()
    const list = ui.getByRole('list', { name: 'Befunde (2)' })
    const lines = within(list).getAllByRole('button')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toHaveTextContent('Hinweis: Eintrag ist nicht abrechenbar.')
    expect(lines[1]).toHaveTextContent('Beschreibung fehlt.')
    expect(lines[0].textContent).toMatch(/01\.09\.2026.*\d{2}:\d{2}/)
    expect(ui.getByText('abgerechnet')).toBeVisible()
    expect(ui.getByText('Nicht abrechenbar')).toBeVisible()
    expect(ui.getAllByText('1:00')).toHaveLength(2)
    expect(ui.queryByRole('option', { name: 'Archived' })).toBeNull()
    const section = screen.getByRole('region', { name: 'Monats-Review' })
    expect(section.parentElement!.querySelector(':scope > section')).toBe(section)
    expect(section.nextElementSibling).toHaveClass('grid')
    await act(async () => useSettingsStore.setState({ settings: { language: 'en' } as never }))
    const englishLines = within(screen.getByRole('list', { name: 'Findings (2)' })).getAllByRole(
      'button'
    )
    expect(englishLines[0]).toHaveTextContent('not billable')
    expect(englishLines[1]).toHaveTextContent('Description is missing.')
  })
  it('shows the empty findings state in German and English', async () => {
    period.mockResolvedValue({ ok: true, data: [] })
    const ui = await selectClient()
    expect(ui.getByText('Keine Befunde')).toBeVisible()
    expect(ui.getByRole('list', { name: 'Befunde (0)' })).toBeVisible()
    await act(async () => useSettingsStore.setState({ settings: { language: 'en' } as never }))
    expect(await screen.findByText('No findings')).toBeVisible()
  })
  it('jumps to, focuses and highlights the matching row and opens its inline editor', async () => {
    const ui = await selectClient()
    const line = within(ui.getByRole('list', { name: 'Befunde (2)' })).getAllByRole('button')[1]
    fireEvent.click(line)
    const row = ui.getByRole('listitem', { name: 'Eintrag 2' })
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(scroll.mock.instances[0]).toBe(row)
    expect(row).toHaveFocus()
    expect(row).toHaveAttribute('data-highlighted', 'true')
    expect(within(row).getByLabelText(/^Beschreibung/)).toHaveValue('Work 2')
    expect(
      within(ui.getByRole('listitem', { name: 'Eintrag 1' })).queryByLabelText(/^Beschreibung/)
    ).toBeNull()
  })
  it('saves an inline edit through entries.update and reloads the findings and rows', async () => {
    const ui = await selectClient()
    fireEvent.click(
      within(ui.getByRole('listitem', { name: 'Eintrag 1' })).getByRole('button', {
        name: 'Bearbeiten'
      })
    )
    fireEvent.change(ui.getByLabelText(/^Beschreibung/), { target: { value: 'Corrected' } })
    period.mockResolvedValue({ ok: true, data: [] })
    getForReview.mockResolvedValue({
      ok: true,
      data: [{ ...entries[0], description: 'Corrected' }]
    })
    fireEvent.click(ui.getByRole('button', { name: 'Speichern' }))
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, description: 'Corrected', expected_version: 1 })
      )
    )
    await ui.findByText('Keine Befunde')
    await waitFor(() => expect(ui.queryByLabelText(/^Beschreibung/)).toBeNull())
    expect(period).toHaveBeenCalledTimes(2)
    expect(getForReview).toHaveBeenCalledTimes(2)
    expect(ui.getByText('Corrected')).toBeVisible()
  })
  it('uses the existing billed reason prompt and sends the reason with a content edit', async () => {
    const ui = await selectClient()
    fireEvent.click(
      within(ui.getByRole('listitem', { name: 'Eintrag 2' })).getByRole('button', {
        name: 'Bearbeiten'
      })
    )
    fireEvent.change(ui.getByLabelText(/^Beschreibung/), {
      target: { value: 'Corrected billed work' }
    })
    fireEvent.click(ui.getByRole('button', { name: 'Speichern' }))
    const dialog = within(await screen.findByRole('alertdialog'))
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(dialog.getByRole('button', { name: 'Speichern' }))
    expect(dialog.getByRole('alert')).toBeVisible()
    fireEvent.change(dialog.getByLabelText(/^Grund/), {
      target: { value: '  Correct description  ' }
    })
    fireEvent.click(dialog.getByRole('button', { name: 'Speichern' }))
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 2, reason: 'Correct description' })
      )
    )
    await waitFor(() => expect(period).toHaveBeenCalledTimes(2))
  })
  it('opens PDF with the review client, project and dates despite findings and remembered CSV', async () => {
    const ui = await selectClient()
    await ui.findByRole('option', { name: 'Project' })
    fireEvent.change(ui.getByLabelText('Review-Projekt'), { target: { value: '3' } })
    fireEvent.change(ui.getByLabelText('Review von'), { target: { value: '2026-09-01' } })
    fireEvent.change(ui.getByLabelText('Review bis'), { target: { value: '2026-09-30' } })
    const button = ui.getByRole('button', { name: 'PDF vorbereiten' })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    const dialog = within(screen.getByRole('dialog', { name: 'Exportieren' }))
    await waitFor(() => expect(dialog.getByRole('combobox', { name: 'Kunde' })).toHaveValue('1'))
    await waitFor(() => expect(dialog.getByRole('combobox', { name: 'Projekt' })).toHaveValue('3'))
    expect(dialog.getByText('Von').parentElement!.querySelector('input')).toHaveValue('2026-09-01')
    expect(dialog.getByText('Bis').parentElement!.querySelector('input')).toHaveValue('2026-09-30')
    await waitFor(() => expect(dialog.getByRole('button', { name: 'PDF speichern' })).toBeEnabled())
    fireEvent.click(dialog.getByRole('button', { name: 'PDF speichern' }))
    await waitFor(() =>
      expect(pdf).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 1,
          projectId: 3,
          fromIso: '2026-09-01',
          toIso: '2026-09-30'
        })
      )
    )
  })
  it('defaults to last month and reloads on client, project, quick range and manual date changes', async () => {
    const ui = await selectClient()
    const now = new Date()
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const last = new Date(now.getFullYear(), now.getMonth(), 0)
    const key = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(period).toHaveBeenLastCalledWith({ clientId: 1, fromIso: key(first), toIso: key(last) })
    fireEvent.change(ui.getByLabelText('Review-Kunde'), { target: { value: '2' } })
    await waitFor(() =>
      expect(period).toHaveBeenLastCalledWith(expect.objectContaining({ clientId: 2 }))
    )
    fireEvent.change(ui.getByLabelText('Review-Zeitraum'), { target: { value: 'thisWeek' } })
    const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay())
    await waitFor(() =>
      expect(period).toHaveBeenLastCalledWith(expect.objectContaining({ fromIso: key(sunday) }))
    )
    fireEvent.change(ui.getByLabelText('Review von'), { target: { value: '2026-01-01' } })
    await waitFor(() =>
      expect(getForReview).toHaveBeenLastCalledWith(
        expect.objectContaining({ fromIso: '2026-01-01' })
      )
    )
    await ui.findByRole('option', { name: 'Project' })
    fireEvent.change(ui.getByLabelText('Review-Projekt'), { target: { value: '3' } })
    await waitFor(() =>
      expect(period).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: 3 }))
    )
  })
  it('shows the day of a day finding as a display date, not as the ISO key', async () => {
    period.mockResolvedValue({
      ok: true,
      data: [
        {
          entryId: 1,
          rule: 'day_over_threshold',
          params: { day: '2026-09-03', hours: '11:45', threshold: 10 }
        }
      ]
    })
    const ui = await selectClient()
    const line = within(ui.getByRole('list', { name: 'Befunde (1)' })).getByRole('button')
    expect(line).toHaveTextContent('03.09.2026: insgesamt 11:45 h, über 10 h.')
    expect(line).not.toHaveTextContent('2026-09-03')
    await act(async () => useSettingsStore.setState({ settings: { language: 'en' } as never }))
    const english = within(screen.getByRole('list', { name: 'Findings (1)' })).getByRole('button')
    expect(english).toHaveTextContent('03/09/2026: 11:45 h in total, above 10 h.')
  })
  it('keeps the inline editor out of a nested scroll box, so its sticky buttons cover nothing', async () => {
    const ui = await selectClient()
    fireEvent.click(
      within(ui.getByRole('listitem', { name: 'Eintrag 1' })).getByRole('button', {
        name: 'Bearbeiten'
      })
    )
    const field = ui.getByLabelText(/^Beschreibung/)
    for (let el = field.parentElement; el; el = el.parentElement) {
      expect(el.className).not.toMatch(/overflow-(auto|scroll|y-auto|y-scroll)|max-h-/)
    }
  })
  it('reloads when entries are written elsewhere in the app', async () => {
    await selectClient()
    expect(period).toHaveBeenCalledTimes(1)
    await act(async () => useEntriesStore.getState().bumpVersion())
    await waitFor(() => expect(period).toHaveBeenCalledTimes(2))
    expect(getForReview).toHaveBeenCalledTimes(2)
  })
  it('reloads when a billing run is released, so its entries no longer show as billed', async () => {
    const run = {
      id: 7,
      number: 'SN-2026-09-ABC-01',
      client_id: 1,
      client_name: 'First',
      project_id: 3,
      period_from: '2026-09-01',
      period_to: '2026-09-30',
      created_at: '2026-10-01T09:00:00.000Z',
      status: 'active',
      released_at: null,
      release_reason: null,
      replaces_run_id: null,
      invoice_ref: '',
      rule_snapshot: '',
      html_sha256: 'html',
      pdf_sha256: 'pdf',
      billed_minutes: 60,
      fee_cent: 6000
    }
    const release = vi.fn(async () => ({ ok: true, data: undefined }))
    window.api.billingRuns = {
      list: async () => ({ ok: true, data: [run] }),
      release
    } as unknown as Window['api']['billingRuns']
    await selectClient()
    expect(period).toHaveBeenCalledTimes(1)
    fireEvent.click(await screen.findByRole('button', { name: 'Lösen' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Lösen' }))
    fireEvent.change(dialog.getByLabelText(/^Grund/), { target: { value: 'Wrong period' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Lösen' }))
    await waitFor(() => expect(release).toHaveBeenCalledWith(7, 'Wrong period'))
    await waitFor(() => expect(period).toHaveBeenCalledTimes(2))
    expect(getForReview).toHaveBeenCalledTimes(2)
  })
})
