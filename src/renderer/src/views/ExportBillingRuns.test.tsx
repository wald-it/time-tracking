import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { BillingRunSummary } from '../../../main/billingRuns'
import type { IpcResult } from '../../../shared/types'
import { I18nProvider } from '../contexts/I18nContext'
import { useSettingsStore } from '../store/settingsStore'
import ExportView from './ExportView'

const active: BillingRunSummary = {
  id: 7,
  number: 'SN-2026-09-ABC-01',
  client_id: 1,
  client_name: 'Example client',
  project_id: 3,
  period_from: '2026-09-01',
  period_to: '2026-09-30',
  created_at: '2026-10-01T09:00:00.000Z',
  status: 'active',
  released_at: null,
  release_reason: null,
  replaces_run_id: null,
  invoice_ref: '',
  rule_snapshot: 'PRIVATE_RULE_SNAPSHOT',
  html_sha256: 'html',
  pdf_sha256: 'pdf',
  billed_minutes: 125,
  fee_cent: 12345
}
const released: BillingRunSummary = {
  ...active,
  id: 8,
  number: 'SN-2026-09-ABC-02',
  status: 'released',
  released_at: '2026-10-02T10:00:00.000Z',
  release_reason: 'Wrong description'
}
type PdfResult = Awaited<ReturnType<Window['api']['pdf']['export']>>
let rows: BillingRunSummary[]
let shortCode: string | null
const list = vi.fn<() => Promise<IpcResult<BillingRunSummary[]>>>()
const exportPdf = vi.fn<Window['api']['pdf']['export']>()
const release = vi.fn<Window['api']['billingRuns']['release']>()
const open = vi.fn<Window['api']['billingRuns']['open']>()
const setSetting = vi.fn()

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  rows = [released, active]
  shortCode = 'ABC'
  useSettingsStore.setState({ settings: { export_prefs: JSON.stringify({ tab: 'pdf' }) } as never })
  list.mockImplementation(async () => ({ ok: true, data: [...rows] }))
  exportPdf.mockResolvedValue({ ok: true, data: { path: 'timesheet.pdf' } })
  open.mockResolvedValue({ ok: true, data: undefined })
  release.mockImplementation(async (id, reason) => {
    rows = rows.map((r) =>
      r.id === id
        ? {
            ...r,
            status: 'released',
            released_at: '2026-10-28T10:00:00.000Z',
            release_reason: reason
          }
        : r
    )
    return { ok: true, data: undefined }
  })
  setSetting.mockResolvedValue({ ok: true, data: undefined })
  const api = {
    settings: { getAll: async () => ({ ok: true, data: {} }), set: setSetting },
    clients: {
      getAll: async () => ({
        ok: true,
        data: [{ id: 1, name: 'Example client', short_code: shortCode, rate_cent: 6000 }]
      })
    },
    projects: {
      getAll: async () => ({
        ok: true,
        data: [
          { id: 3, name: 'Archived project', active: 0 },
          { id: 4, name: 'Other project', active: 1 }
        ]
      })
    },
    billingRuns: { list, open, release },
    billingProfile: {
      get: async () => ({ ok: true, data: { columns: null, inherited: { columns: 'times' } } })
    },
    pdf: { export: exportPdf }
  }
  window.api = api as unknown as Window['api']
})
afterEach(cleanup)

async function renderView(): Promise<void> {
  render(
    <I18nProvider>
      <ExportView />
    </I18nProvider>
  )
  await screen.findByText(active.number)
}
async function openExport(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Dieser Monat' }))
  const dialog = screen.getByRole('dialog', { name: 'Exportieren' })
  await waitFor(() =>
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: 'Kunde' }).value).toBe(
      '1'
    )
  )
  await waitFor(() =>
    expect(within(dialog).getByRole('combobox', { name: 'Spalten' })).toBeEnabled()
  )
  return dialog
}
function row(number: string): HTMLElement {
  return screen.getByText(number).closest('li')!
}

describe('P6b export and billing run list', () => {
  it('#424 offers the PDF reference only for billing, trims the request and locks it after creation', async () => {
    await renderView()
    const dialog = await openExport()
    const ui = within(dialog)
    expect(ui.queryByRole('textbox', { name: 'Zu Rechnung Nr. (optional)' })).toBeNull()
    const billed = ui.getByRole('checkbox', { name: 'Als abgerechnet markieren' })
    fireEvent.click(billed)
    const input = ui.getByRole<HTMLInputElement>('textbox', { name: 'Zu Rechnung Nr. (optional)' })
    expect(input.maxLength).toBe(64)
    fireEvent.change(input, { target: { value: '  RE-123  ' } })
    fireEvent.click(billed)
    expect(ui.queryByRole('textbox', { name: 'Zu Rechnung Nr. (optional)' })).toBeNull()
    fireEvent.click(ui.getByRole('button', { name: 'PDF speichern' }))
    await waitFor(() => expect(exportPdf).toHaveBeenCalledTimes(1))
    expect(exportPdf.mock.calls[0][0].invoiceRef).toBeUndefined()
    await ui.findByText('PDF gespeichert: timesheet.pdf')
    fireEvent.click(billed)
    exportPdf.mockResolvedValueOnce({
      ok: true,
      data: { path: 'run.pdf', runId: 9, runNumber: 'SN-new' }
    })
    fireEvent.click(ui.getByRole('button', { name: 'PDF speichern' }))
    await waitFor(() =>
      expect(exportPdf).toHaveBeenLastCalledWith(
        expect.objectContaining({ markAsBilled: true, invoiceRef: 'RE-123' })
      )
    )
    await waitFor(() =>
      expect(
        ui.getByRole<HTMLInputElement>('textbox', { name: 'Zu Rechnung Nr. (optional)' }).disabled
      ).toBe(true)
    )
    fireEvent.change(ui.getByRole('combobox', { name: 'Gruppieren nach' }), {
      target: { value: 'tag' }
    })
    expect(JSON.parse(setSetting.mock.calls.at(-1)![1])).not.toHaveProperty('invoiceRef')
    fireEvent.click(ui.getByText('Schließen'))
    const reopened = within(await openExport())
    fireEvent.click(reopened.getByRole('checkbox', { name: 'Als abgerechnet markieren' }))
    expect(
      reopened.getByRole<HTMLInputElement>('textbox', { name: 'Zu Rechnung Nr. (optional)' }).value
    ).toBe('')
  })

  it('#424 always offers the CSV reference and sends trimmed or absent values', async () => {
    const exportCsv = vi.fn().mockResolvedValue({ ok: true, data: { path: 'entries.csv' } })
    window.api.csv = { export: exportCsv }
    await renderView()
    const ui = within(await openExport())
    fireEvent.click(ui.getByRole('button', { name: 'CSV — Tabelle' }))
    const input = ui.getByRole<HTMLInputElement>('textbox', { name: 'Zu Rechnung Nr. (optional)' })
    expect(input.maxLength).toBe(64)
    for (const [value, expected] of [
      ['  RE-123  ', 'RE-123'],
      ['   ', undefined]
    ]) {
      fireEvent.change(input, { target: { value } })
      fireEvent.click(ui.getByRole('button', { name: 'CSV speichern' }))
      await waitFor(() =>
        expect(exportCsv).toHaveBeenLastCalledWith(
          expect.objectContaining({ invoiceRef: expected })
        )
      )
      await ui.findByText('CSV gespeichert: entries.csv')
    }
  })

  it.each(['active', 'released'] as const)(
    '#424 shows, edits and clears the reference of a %s run',
    async (status) => {
      const target = status === 'active' ? active : released
      rows = rows.map((r) => (r.id === target.id ? { ...r, invoice_ref: 'RE-old' } : r))
      const setInvoiceRef = vi.fn().mockImplementation(async (id: number, invoiceRef: string) => {
        rows = rows.map((r) => (r.id === id ? { ...r, invoice_ref: invoiceRef } : r))
        return { ok: true, data: undefined }
      })
      window.api.billingRuns.setInvoiceRef = setInvoiceRef
      await renderView()
      expect(within(row(target.number)).getByText(/RE-old/)).toBeTruthy()
      for (const [value, expected] of [
        ['  RE-new  ', 'RE-new'],
        ['   ', '']
      ]) {
        fireEvent.click(
          within(row(target.number)).getByRole('button', { name: 'Rechnungsnummer bearbeiten' })
        )
        const ui = within(screen.getByRole('dialog', { name: 'Rechnungsnummer bearbeiten' }))
        expect(ui.getByText('Das archivierte PDF bleibt unverändert.')).toBeTruthy()
        const input = ui.getByRole<HTMLInputElement>('textbox', {
          name: 'Zu Rechnung Nr. (optional)'
        })
        expect(input.maxLength).toBe(64)
        fireEvent.change(input, { target: { value } })
        fireEvent.click(ui.getByRole('button', { name: 'Speichern' }))
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
        expect(setInvoiceRef).toHaveBeenLastCalledWith(target.id, expected)
        await waitFor(() => expect(within(row(target.number)).queryByText(/RE-old/)).toBeNull())
        if (expected) await within(row(target.number)).findByText(/RE-new/)
        else
          await waitFor(() => expect(within(row(target.number)).queryByText(/RE-new/)).toBeNull())
      }
      expect(open).not.toHaveBeenCalled()
      expect(exportPdf).not.toHaveBeenCalled()
    }
  )

  it('#424 keeps failed edits open and explains the archive invariant in English', async () => {
    useSettingsStore.setState({
      settings: { language: 'en', export_prefs: JSON.stringify({ tab: 'pdf' }) } as never
    })
    const setInvoiceRef = vi.fn().mockResolvedValue({ ok: false, error: 'Write failed' })
    window.api.billingRuns.setInvoiceRef = setInvoiceRef
    await renderView()
    fireEvent.click(within(row(active.number)).getByRole('button', { name: 'Edit invoice number' }))
    const ui = within(screen.getByRole('dialog', { name: 'Edit invoice number' }))
    expect(ui.getByText('The archived PDF stays unchanged.')).toBeTruthy()
    const input = ui.getByRole<HTMLInputElement>('textbox', { name: 'For invoice no. (optional)' })
    fireEvent.change(input, { target: { value: 'RE-123' } })
    fireEvent.click(ui.getByRole('button', { name: 'Save' }))
    expect(await ui.findByRole('alert')).toHaveProperty('textContent', 'Write failed')
    expect(input.value).toBe('RE-123')
    fireEvent.click(ui.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(setInvoiceRef).toHaveBeenCalledTimes(1)
  })

  it('shows numbers, client, period, frozen minutes and fee, and released date and reason', async () => {
    await renderView()
    const item = within(row(active.number))
    expect(item.getByText('Example client')).toBeTruthy()
    expect(item.getByText('2026-09-01 bis 2026-09-30')).toBeTruthy()
    expect(item.getByText(/125 min · 123,45/)).toBeTruthy()
    expect(item.getByText('Aktiv')).toBeTruthy()
    expect(
      within(row(released.number)).getByText(/Gelöst am .*2\.10\.2026.*Wrong description/)
    ).toBeTruthy()
    expect(screen.queryByText('PRIVATE_RULE_SNAPSHOT')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('names the replacement of a re-billed run instead of offering a second re-bill', async () => {
    const replacement: BillingRunSummary = {
      ...active,
      id: 9,
      number: 'SN-2026-09-ABC-03',
      replaces_run_id: released.id
    }
    rows = [replacement, released, active]
    await renderView()
    const old = within(row(released.number))
    expect(old.getByText('Ersetzt durch SN-2026-09-ABC-03')).toBeTruthy()
    expect(old.queryByRole('button', { name: 'Neu abrechnen' })).toBeNull()
  })

  it('opens the archived PDF and surfaces viewer errors', async () => {
    await renderView()
    open.mockResolvedValueOnce({ ok: false, error: 'Viewer unavailable' })
    fireEvent.click(within(row(active.number)).getByRole('button', { name: 'PDF öffnen' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Fehler: Viewer unavailable'
    )
    expect(open).toHaveBeenCalledWith(7)
    fireEvent.click(within(row(released.number)).getByRole('button', { name: 'PDF öffnen' }))
    await waitFor(() => expect(open).toHaveBeenLastCalledWith(8))
  })

  it.each(['', '   '])(
    'rejects an empty release reason (%j), then releases and refreshes the list',
    async (empty) => {
      await renderView()
      fireEvent.click(within(row(active.number)).getByRole('button', { name: 'Lösen' }))
      const dialog = screen.getByRole('dialog', { name: 'Lösen' })
      const reason = within(dialog).getByRole('textbox', { name: 'Grund (Pflicht)' })
      fireEvent.change(reason, { target: { value: empty } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Lösen' }))
      expect(await within(dialog).findByRole('alert')).toHaveProperty(
        'textContent',
        'Bitte einen Grund zum Lösen angeben.'
      )
      expect(release).not.toHaveBeenCalled()
      fireEvent.change(reason, { target: { value: '  Correct hours  ' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Lösen' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(release).toHaveBeenCalledWith(7, 'Correct hours')
      await waitFor(() =>
        expect(within(row(active.number)).getByText(/Gelöst am .*Correct hours/)).toBeTruthy()
      )
    }
  )

  it('keeps the reason after a failed release and allows cancel without writing', async () => {
    await renderView()
    release.mockResolvedValueOnce({ ok: false, error: 'Run changed' })
    fireEvent.click(within(row(active.number)).getByRole('button', { name: 'Lösen' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Correction' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lösen' }))
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Run changed')
    expect(within(dialog).getByRole<HTMLInputElement>('textbox').value).toBe('Correction')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('defaults the billing checkbox off, sends it explicitly and never persists it', async () => {
    await renderView()
    const dialog = await openExport()
    const checkbox = within(dialog).getByRole<HTMLInputElement>('checkbox', {
      name: 'Als abgerechnet markieren'
    })
    expect(checkbox.checked).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'PDF speichern' }))
    await waitFor(() =>
      expect(exportPdf).toHaveBeenCalledWith(expect.objectContaining({ markAsBilled: false }))
    )
    await within(dialog).findByText('PDF gespeichert: timesheet.pdf')
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)
    // Persisting another option must not smuggle the billing flag into preferences.
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Gruppieren nach' }), {
      target: { value: 'tag' }
    })
    expect(JSON.parse(setSetting.mock.calls[0][1])).not.toHaveProperty('markAsBilled')
    fireEvent.click(within(dialog).getByText('Schließen'))
    const reopened = await openExport()
    expect(within(reopened).getByRole<HTMLInputElement>('checkbox').checked).toBe(false)
  })

  it('reports the new run number and excluded segments and reloads the list after billing', async () => {
    await renderView()
    exportPdf.mockImplementationOnce(async () => {
      rows = [{ ...active, id: 9, number: 'SN-2026-10-ABC-01' }, ...rows]
      return {
        ok: true,
        data: { path: 'new.pdf', runId: 9, runNumber: 'SN-2026-10-ABC-01', excludedCount: 2 }
      }
    })
    const dialog = await openExport()
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'PDF speichern' }))
    expect(await within(dialog).findByRole('status')).toHaveProperty(
      'textContent',
      'PDF gespeichert: new.pdf Abrechnungslauf SN-2026-10-ABC-01 angelegt. 2 bereits abgerechnete Segmente ausgeschlossen.'
    )
    expect(exportPdf).toHaveBeenCalledWith(expect.objectContaining({ markAsBilled: true }))
    expect(await screen.findByText('SN-2026-10-ABC-01')).toBeTruthy()
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'PDF speichern' }).disabled
    ).toBe(true)
  })

  it('omits the exclusion notice for zero exclusions', async () => {
    await renderView()
    exportPdf.mockResolvedValueOnce({
      ok: true,
      data: { path: 'new.pdf', runId: 9, runNumber: 'SN-2026-10-ABC-01', excludedCount: 0 }
    })
    const dialog = await openExport()
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'PDF speichern' }))
    await within(dialog).findByText(/Abrechnungslauf SN-2026-10-ABC-01 angelegt/)
    expect(within(dialog).queryByText(/ausgeschlossen/)).toBeNull()
  })

  it('requires the client code only for billing, with a pointer to Clients', async () => {
    shortCode = null
    await renderView()
    const dialog = await openExport()
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'PDF speichern' }))
    expect(await within(dialog).findByRole('alert')).toHaveProperty(
      'textContent',
      'Dieser Kunde hat noch keinen Kurzcode. Trage ihn unter Kunden ein, dann geht der Lauf.'
    )
    expect(exportPdf).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'PDF speichern' }))
    await waitFor(() => expect(exportPdf).toHaveBeenCalledTimes(1))
  })

  it('re-bills a released run with the same client, archived project and range, even with CSV prefs', async () => {
    useSettingsStore.setState({
      settings: { export_prefs: JSON.stringify({ tab: 'csv', groupBy: 'project' }) } as never
    })
    await renderView()
    fireEvent.click(within(row(released.number)).getByRole('button', { name: 'Neu abrechnen' }))
    const dialog = screen.getByRole('dialog', { name: 'Exportieren' })
    await within(dialog).findByRole('option', { name: 'Archived project' })
    await act(async () => {})
    const client = within(dialog).getByRole<HTMLSelectElement>('combobox', { name: 'Kunde' })
    const project = within(dialog).getByRole<HTMLSelectElement>('combobox', { name: 'Projekt' })
    expect(client.value).toBe('1')
    expect(project.value).toBe('3')
    expect(client.disabled && project.disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLInputElement>('checkbox').checked).toBe(true)
    expect(within(dialog).getByRole<HTMLInputElement>('checkbox').disabled).toBe(true)
    expect(within(dialog).getByLabelText<HTMLInputElement>('Von').value).toBe('2026-09-01')
    expect(within(dialog).getByLabelText<HTMLInputElement>('Bis').value).toBe('2026-09-30')
    fireEvent.click(within(dialog).getByRole('button', { name: 'PDF speichern' }))
    await waitFor(() =>
      expect(exportPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 1,
          projectId: 3,
          fromIso: '2026-09-01',
          toIso: '2026-09-30',
          markAsBilled: true,
          replacesRunId: 8
        })
      )
    )
  })

  it.each([
    { ok: false, code: 'cancelled', error: 'Cancelled' },
    { ok: false, error: 'Run archived but file write failed' }
  ] satisfies PdfResult[])(
    'refreshes after a billed export result ($error) without a success notice',
    async (result) => {
      await renderView()
      exportPdf.mockResolvedValueOnce(result)
      const dialog = await openExport()
      fireEvent.click(within(dialog).getByRole('checkbox'))
      fireEvent.click(within(dialog).getByRole('button', { name: 'PDF speichern' }))
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
      expect(within(dialog).queryByText(/Abrechnungslauf .* angelegt/)).toBeNull()
      expect(
        within(dialog).getByRole<HTMLButtonElement>('button', { name: 'PDF speichern' }).disabled
      ).toBe(false)
    }
  )

  it('shows a failed list load and retries to an empty state', async () => {
    list.mockResolvedValueOnce({ ok: false, error: 'Database unavailable' })
    rows = []
    render(
      <I18nProvider>
        <ExportView />
      </I18nProvider>
    )
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Fehler: Database unavailable'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }))
    expect(await screen.findByText('Noch keine Abrechnungsläufe.')).toBeTruthy()
  })
})
