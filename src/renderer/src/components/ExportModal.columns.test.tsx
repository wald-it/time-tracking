import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ExportModal } from './ExportModal'
import { I18nProvider } from '../contexts/I18nContext'
import { useSettingsStore } from '../store/settingsStore'
import type { BillingRunSummary } from '../../../main/billingRuns'
import type { RateTarget } from '../../../shared/rateEditor'

const ok = <T,>(data: T): { ok: true; data: T } => ({ ok: true, data })
const getProfile = vi.fn()
const exportPdf = vi.fn()
const setSetting = vi.fn()
beforeEach(() => {
  localStorage.clear()
  useSettingsStore.setState({ settings: null })
  getProfile.mockReset().mockImplementation(async (target: RateTarget) =>
    ok({
      columns: target.kind === 'client' && target.id === 1 ? 'no_times' : null,
      inherited: { columns: target.kind === 'project' && target.id === 11 ? 'no_times' : 'times' }
    })
  )
  exportPdf.mockReset().mockResolvedValue({ ok: false, code: 'cancelled' })
  setSetting.mockReset().mockResolvedValue(ok(undefined))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      settings: { getAll: async () => ok({ export_prefs: '{"tab":"pdf"}' }), set: setSetting },
      clients: {
        getAll: async () =>
          ok([
            { id: 1, name: 'Client A', rate_cent: 6000, short_code: 'A' },
            { id: 2, name: 'Client B', rate_cent: 6000, short_code: 'B' }
          ])
      },
      projects: {
        getAll: async ({ clientId }: { clientId: number }) =>
          ok(
            clientId === 1
              ? [
                  { id: 11, name: 'Project A', active: 1 },
                  { id: 12, name: 'Project B', active: 1 }
                ]
              : []
          )
      },
      billingProfile: { get: getProfile },
      pdf: { export: exportPdf }
    }
  })
})
afterEach(cleanup)
async function open(replacementRun?: BillingRunSummary): Promise<void> {
  await act(async () => {
    await useSettingsStore.getState().load()
  })
  render(
    <StrictMode>
      <I18nProvider>
        <ExportModal
          open
          onClose={() => {}}
          prefilledRange={{ fromIso: '2026-10-01', toIso: '2026-10-31' }}
          replacementRun={replacementRun}
        />
      </I18nProvider>
    </StrictMode>
  )
  await screen.findByRole('option', { name: /Client A/ })
}
const columnsControl = (): HTMLSelectElement => screen.getByRole('combobox', { name: 'Spalten' })
const selectClient = (id: number): void => {
  fireEvent.change(screen.getByRole('combobox', { name: 'Kunde' }), {
    target: { value: String(id) }
  })
}

describe('export columns (#422)', () => {
  it('waits for the selected profile and ignores a late response for the previous client', async () => {
    await open()
    let resolveFirst!: (value: unknown) => void
    getProfile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    selectClient(1)
    expect(columnsControl()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'PDF speichern' })).toBeDisabled()
    selectClient(2)
    await waitFor(() => expect(columnsControl()).toBeEnabled())
    expect(columnsControl()).toHaveValue('times')
    await act(async () => {
      resolveFirst(ok({ columns: 'no_times', inherited: { columns: 'times' } }))
    })
    expect(columnsControl()).toHaveValue('times')
    expect(getProfile).toHaveBeenLastCalledWith({ kind: 'client', id: 2 })
  })

  it('resets to each client profile and sends a one-export override without persisting it', async () => {
    await open()
    selectClient(1)
    await waitFor(() => expect(columnsControl()).toHaveValue('no_times'))
    fireEvent.change(columnsControl(), { target: { value: 'times' } })
    fireEvent.click(screen.getByRole('button', { name: 'PDF speichern' }))
    await waitFor(() =>
      expect(exportPdf).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 1, columns: 'times' })
      )
    )
    expect(setSetting).not.toHaveBeenCalled()
    selectClient(2)
    await waitFor(() => expect(getProfile).toHaveBeenCalledWith({ kind: 'client', id: 2 }))
    await waitFor(() => expect(columnsControl()).toHaveValue('times'))
    selectClient(1)
    await waitFor(() => expect(columnsControl()).toHaveValue('no_times'))
  })

  it('resets to inherited or own project columns and back to the client profile', async () => {
    await open()
    selectClient(1)
    await screen.findByRole('option', { name: 'Project A' })
    await waitFor(() => expect(columnsControl()).toHaveValue('no_times'))
    fireEvent.change(columnsControl(), { target: { value: 'times' } })
    const project = screen.getByRole('combobox', { name: /Projekt/ })
    fireEvent.change(project, { target: { value: '11' } })
    await waitFor(() => expect(columnsControl()).toHaveValue('no_times'))
    expect(getProfile).toHaveBeenCalledWith({ kind: 'project', id: 11 })
    getProfile.mockResolvedValueOnce(ok({ columns: 'times', inherited: { columns: 'no_times' } }))
    fireEvent.change(project, { target: { value: '12' } })
    await waitFor(() => expect(columnsControl()).toHaveValue('times'))
    fireEvent.change(project, { target: { value: '' } })
    await waitFor(() => expect(columnsControl()).toHaveValue('no_times'))
  })

  it('defaults a replacement export from its current project profile', async () => {
    await open({
      id: 7,
      number: 'SN-old',
      client_id: 1,
      project_id: 11,
      period_from: '2026-10-01',
      period_to: '2026-10-31'
    } as BillingRunSummary)
    await waitFor(() => expect(columnsControl()).toHaveValue('no_times'))
    fireEvent.click(screen.getByRole('button', { name: 'PDF speichern' }))
    await waitFor(() =>
      expect(exportPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          columns: 'no_times',
          projectId: 11,
          replacesRunId: 7,
          markAsBilled: true
        })
      )
    )
  })
})
