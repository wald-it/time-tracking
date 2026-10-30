import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ExportModal } from './ExportModal'
import { I18nProvider } from '../contexts/I18nContext'
import { useSettingsStore } from '../store/settingsStore'
import type { BillingRunSummary } from '../../../main/billingRuns'
import type { RateTarget } from '../../../shared/rateEditor'
import type { GroupBy } from './exportPrefs'

const ok = <T,>(data: T): { ok: true; data: T } => ({ ok: true, data })
const getProfile = vi.fn()
const exportPdf = vi.fn()
const setSetting = vi.fn()
const getSettings = vi.fn()
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
  getSettings.mockReset().mockResolvedValue(ok({ export_prefs: '{"tab":"pdf"}' }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      settings: { getAll: getSettings, set: setSetting },
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
  // The first render of the file can take longer than the 1 s default under a full-suite load.
  await screen.findByRole('option', { name: /Client A/ }, { timeout: 5000 })
}
const columnsControl = (): HTMLSelectElement => screen.getByRole('combobox', { name: 'Spalten' })
const selectClient = (id: number): void => {
  fireEvent.change(screen.getByRole('combobox', { name: 'Kunde' }), {
    target: { value: String(id) }
  })
}

const groupingControl = (): HTMLSelectElement =>
  screen.getByRole('combobox', { name: 'Gruppieren nach' })
const selectProject = (id: number | null): void => {
  fireEvent.change(screen.getByRole('combobox', { name: /Projekt/ }), {
    target: { value: id === null ? '' : String(id) }
  })
}
const profile = (own: GroupBy | null, inherited: GroupBy = 'none'): ReturnType<typeof ok> =>
  ok({ columns: 'times', group_by: own, inherited: { columns: 'times', group_by: inherited } })

describe('export grouping (#433)', () => {
  it.each([
    ['tag', 'reference'],
    [null, 'reference'],
    ['none', 'reference'],
    ['project', 'tag']
  ] as const)(
    'uses client grouping %s inherited from %s, ignoring old prefs',
    async (own, inherited) => {
      getSettings.mockResolvedValue(
        ok({
          export_prefs: JSON.stringify({
            tab: 'pdf',
            groupBy: (own ?? inherited) === 'reference' ? 'tag' : 'reference'
          })
        })
      )
      getProfile.mockResolvedValue(profile(own, inherited))
      await open()
      selectClient(1)
      await waitFor(() => expect(columnsControl()).toBeEnabled())
      expect(groupingControl()).toHaveValue(own ?? inherited)
      expect(getProfile).toHaveBeenCalledTimes(1)
    }
  )

  it('resets an override when changing clients and when returning to the first client', async () => {
    getProfile.mockImplementation(async (target: RateTarget) =>
      profile(target.id === 1 ? 'tag' : 'reference')
    )
    await open()
    selectClient(1)
    await waitFor(() => expect(columnsControl()).toBeEnabled())
    fireEvent.change(groupingControl(), { target: { value: 'project' } })
    selectClient(2)
    await waitFor(() => expect(columnsControl()).toBeEnabled())
    expect(groupingControl()).toHaveValue('reference')
    selectClient(1)
    await waitFor(() => expect(columnsControl()).toBeEnabled())
    expect(groupingControl()).toHaveValue('tag')
  })

  it('resets to inherited and own project grouping and back to the client profile', async () => {
    getProfile.mockImplementation(async (target: RateTarget) =>
      target.kind === 'client'
        ? profile('project')
        : target.id === 11
          ? profile(null, 'reference')
          : profile('tag', 'reference')
    )
    await open()
    selectClient(1)
    await screen.findByRole('option', { name: 'Project A' })
    selectProject(11)
    await waitFor(() => expect(columnsControl()).toBeEnabled())
    expect(groupingControl()).toHaveValue('reference')
    fireEvent.change(groupingControl(), { target: { value: 'none' } })
    selectProject(12)
    await waitFor(() => expect(columnsControl()).toBeEnabled())
    expect(groupingControl()).toHaveValue('tag')
    selectProject(null)
    await waitFor(() => expect(columnsControl()).toBeEnabled())
    expect(groupingControl()).toHaveValue('project')
  })

  it('keeps project grouping for a client but resets it to none for a selected project', async () => {
    getProfile.mockResolvedValue(profile(null, 'project'))
    await open()
    selectClient(1)
    await waitFor(() => expect(groupingControl()).toHaveValue('project'))
    await screen.findByRole('option', { name: 'Project A' })
    selectProject(11)
    await waitFor(() => expect(columnsControl()).toBeEnabled())
    await waitFor(() => expect(groupingControl()).toHaveValue('none'))
    fireEvent.click(screen.getByRole('button', { name: 'PDF speichern' }))
    await waitFor(() =>
      expect(exportPdf).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 11, groupBy: 'none' })
      )
    )
  })

  it('waits for the shared profile request and ignores a late grouping response', async () => {
    await open()
    let resolveFirst!: (value: unknown) => void
    getProfile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    selectClient(1)
    expect(groupingControl()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'PDF speichern' })).toBeDisabled()
    getProfile.mockResolvedValueOnce(profile('reference'))
    selectClient(2)
    await waitFor(() => expect(groupingControl()).toBeEnabled())
    expect(groupingControl()).toHaveValue('reference')
    await act(async () => {
      resolveFirst(profile('tag'))
    })
    expect(groupingControl()).toHaveValue('reference')
    expect(getProfile.mock.calls).toEqual([
      [{ kind: 'client', id: 1 }],
      [{ kind: 'client', id: 2 }]
    ])
  })

  it('sends a one-export override and excludes grouping from the next preference write', async () => {
    getProfile.mockResolvedValue(profile('reference'))
    await open()
    selectClient(1)
    await waitFor(() => expect(columnsControl()).toBeEnabled())
    fireEvent.change(groupingControl(), { target: { value: 'tag' } })
    expect(setSetting).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: 'Honorar-Spalte ausblenden' }))
    await waitFor(() => expect(setSetting).toHaveBeenCalledTimes(1))
    expect(setSetting.mock.calls[0][0]).toBe('export_prefs')
    expect(JSON.parse(setSetting.mock.calls[0][1])).not.toHaveProperty('groupBy')
    fireEvent.click(screen.getByRole('button', { name: 'PDF speichern' }))
    await waitFor(() =>
      expect(exportPdf).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 1, groupBy: 'tag' })
      )
    )
  })

  it.each([null, 11])(
    'defaults a replacement export from its current profile (project %s)',
    async (projectId) => {
      getProfile.mockResolvedValue(profile(null, 'reference'))
      await open({
        id: 7,
        number: 'SN-old',
        client_id: 1,
        project_id: projectId,
        period_from: '2026-10-01',
        period_to: '2026-10-31'
      } as BillingRunSummary)
      await waitFor(() => expect(columnsControl()).toBeEnabled())
      expect(groupingControl()).toHaveValue('reference')
      fireEvent.click(screen.getByRole('button', { name: 'PDF speichern' }))
      await waitFor(() =>
        expect(exportPdf).toHaveBeenCalledWith(
          expect.objectContaining({
            groupBy: 'reference',
            projectId: projectId ?? undefined,
            replacesRunId: 7,
            markAsBilled: true
          })
        )
      )
    }
  )
})

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

it.each(['on', 'off'] as const)(
  'disables hide fee for profile %s, preserves the preference and restores auto',
  async (fee) => {
    await open()
    selectClient(1)
    await waitFor(() => expect(columnsControl()).toHaveValue('no_times'))
    const control = screen.getByRole('switch', { name: 'Honorar-Spalte ausblenden' })
    fireEvent.click(control)
    expect(control).toBeChecked()
    setSetting.mockClear()
    getProfile.mockResolvedValueOnce(
      ok({ columns: 'times', fee_column: fee, inherited: { columns: 'times', fee_column: 'auto' } })
    )
    selectClient(2)
    await waitFor(() => expect(control).toBeDisabled())
    expect(
      screen.getByText('Das Kunden- oder Projektprofil bestimmt die Honorar-Spalte.')
    ).toBeInTheDocument()
    expect(control).toBeChecked()
    expect(setSetting).not.toHaveBeenCalled()
    selectClient(1)
    await waitFor(() => expect(control).toBeEnabled())
    expect(control).toBeChecked()
    expect(
      screen.queryByText('Das Kunden- oder Projektprofil bestimmt die Honorar-Spalte.')
    ).not.toBeInTheDocument()
    await screen.findByRole('option', { name: 'Project A' })
    getProfile.mockResolvedValueOnce(
      ok({ columns: 'times', fee_column: null, inherited: { columns: 'times', fee_column: fee } })
    )
    fireEvent.change(screen.getByRole('combobox', { name: /Projekt/ }), { target: { value: '11' } })
    await waitFor(() => expect(control).toBeDisabled())
    expect(setSetting).not.toHaveBeenCalled()
  }
)
