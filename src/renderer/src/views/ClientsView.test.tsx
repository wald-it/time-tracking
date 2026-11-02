/**
 * Kunden view (PR 5b, owner review). Focus comes back to the key that opened
 * a form dialog: the forms used `autoFocus`, which React applies before the
 * dialog shell reads the opener — the shell then remembered its own name
 * field and focus fell to <body> on close. Archived clients and projects are
 * told apart by --ink3 and a legend instead of a faded row, and the symbol
 * keys carry names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import ClientsView from './ClientsView'
import { I18nProvider } from '../contexts/I18nContext'
import type { Client, Project } from '../../../shared/types'
import { useClientsStore } from '../store/clientsStore'
import { RATE_EDITOR_CONFLICT_ERROR } from '../../../shared/rateEditor'
import {
  CLIENT_HAS_ENTRIES_ERROR,
  PROJECT_HAS_ENTRIES_ERROR
} from '../../../shared/masterDataDelete'
import { useSettingsStore } from '../store/settingsStore'
import { useToastStore } from '../store/toastStore'

afterEach(cleanup)

describe('Q11 project budgets', () => {
  it('edits and shows a euro monthly budget, then removes the old type on switching both ways', async () => {
    let project: Project = {
      ...PROJECTS[0],
      budget_kind: 'eur',
      budget_period: 'month',
      budget_cent: 10000,
      budget_minutes: null,
      used_cent: 8000,
      used_minutes: 500
    }
    window.api.projects.getAll = vi.fn(async () => ({ ok: true as const, data: [project] }))
    window.api.projects.update = vi.fn(
      async (input: import('../../../shared/types').UpdateProjectInput) => {
        project = { ...project, ...input }
        return { ok: true as const, data: project }
      }
    )
    await renderView()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Projekte anzeigen/ })[0])
    })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '80')
    expect(screen.getByText('80,00 € / 100,00 € · Je Kalendermonat')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten: Rollout' }))
    expect(screen.getByLabelText('Budgettyp')).toHaveValue('eur')
    expect(screen.getByLabelText('Budgetperiode')).toHaveValue('month')
    expect(screen.getByRole('textbox', { name: 'Budget (Euro)' })).toHaveValue('100')
    fireEvent.change(screen.getByLabelText('Budgettyp'), { target: { value: 'hours' } })
    expect(screen.getByRole('textbox', { name: 'Budget (Stunden)' })).toHaveValue('')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    })
    expect(window.api.projects.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ budget_kind: 'hours', budget_cent: null, budget_minutes: null })
    )
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten: Rollout' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Budget (Stunden)' }), {
      target: { value: '10' }
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    })
    expect(screen.getByText('8.3h / 10.0h · Je Kalendermonat')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten: Rollout' }))
    fireEvent.change(screen.getByLabelText('Budgettyp'), { target: { value: 'eur' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    })
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(window.api.projects.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ budget_kind: 'eur', budget_cent: null, budget_minutes: null })
    )
  })

  it('saves a decimal euro amount with its period', async () => {
    window.api.projects.update = vi.fn(
      async (input: import('../../../shared/types').UpdateProjectInput) => ({
        ok: true as const,
        data: { ...PROJECTS[0], ...input }
      })
    )
    await renderView()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Projekte anzeigen/ })[0])
    })
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten: Rollout' }))
    fireEvent.change(screen.getByLabelText('Budgettyp'), { target: { value: 'eur' } })
    fireEvent.change(screen.getByLabelText('Budgetperiode'), { target: { value: 'month' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Budget (Euro)' }), {
      target: { value: '123,45' }
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    })
    expect(window.api.projects.update).toHaveBeenCalledWith(
      expect.objectContaining({
        budget_kind: 'eur',
        budget_period: 'month',
        budget_cent: 12345,
        budget_minutes: null
      })
    )
  })
})

it('uses the shared width with flexible client names and spaced actions (#420)', async () => {
  await renderView()
  const root = screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!
  expect(root).not.toHaveClass('max-w-3xl')
  expect(root).toHaveClass('w-full', 'min-w-0')
  const row = screen.getByRole('button', { name: 'Bearbeiten: Acme' }).parentElement!
  expect(row).toHaveClass('min-[960px]:gap-5')
  expect(screen.getByText('ACME').parentElement).toHaveClass('justify-between')
  expect(screen.getByText('Acme').parentElement!.parentElement).toHaveClass('flex-1', 'min-w-0')
})

const CLIENTS: Client[] = [
  {
    id: 1,
    name: 'Acme',
    short_code: 'ACME',
    color: '#123456',
    active: 1,
    rate_cent: 0,
    created_at: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 2,
    name: 'Altkunde',
    short_code: null,
    color: '#654321',
    active: 0,
    rate_cent: 0,
    created_at: '2026-01-01T00:00:00.000Z'
  }
]

const PROJECTS: Project[] = [
  {
    id: 10,
    client_id: 1,
    name: 'Rollout',
    color: '',
    rate_cent: null,
    active: 1,
    created_at: '2026-01-01',
    status: 'active',
    end_date: '2026-12-31'
  } as Project,
  {
    id: 11,
    client_id: 1,
    name: 'Altlast',
    color: '',
    rate_cent: null,
    active: 0,
    created_at: '2026-01-01',
    status: 'archived'
  } as Project
]

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    rates: {
      list: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          rows: [{ id: 1, valid_from: '0001-01-01', rate_cent: 6000 }],
          current_rate_cent: 6000
        }
      }),
      save: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          rows: [
            { id: 1, valid_from: '0001-01-01', rate_cent: 6000 },
            { id: 2, valid_from: '2020-01-01', rate_cent: 9000 }
          ],
          current_rate_cent: 9000
        }
      }),
      delete: vi.fn().mockResolvedValue({ ok: true, data: { rows: [], current_rate_cent: null } })
    },
    billingProfile: {
      get: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          interval_min: 15,
          min_unit_min: 30,
          columns: null,
          language: null,
          fee_column: null,
          group_by: null,
          inherited: {
            interval_min: 5,
            min_unit_min: 0,
            columns: 'times',
            language: 'de',
            fee_column: 'auto',
            group_by: 'none'
          },
          inherited_source: {
            interval_min: 'default',
            min_unit_min: 'default',
            columns: 'default',
            language: 'default',
            fee_column: 'default',
            group_by: 'default'
          }
        }
      }),
      save: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          interval_min: null,
          min_unit_min: null,
          columns: null,
          language: null,
          fee_column: null,
          group_by: null,
          inherited: {
            interval_min: 5,
            min_unit_min: 0,
            columns: 'times',
            language: 'de',
            fee_column: 'auto',
            group_by: 'none'
          },
          inherited_source: {
            interval_min: 'default',
            min_unit_min: 'default',
            columns: 'default',
            language: 'default',
            fee_column: 'default',
            group_by: 'default'
          }
        }
      })
    },
    clients: { getAll: async () => ({ ok: true as const, data: CLIENTS }) },
    projects: {
      getAll: async ({ clientId }: { clientId: number }) => ({
        ok: true as const,
        data: PROJECTS.filter((p) => p.client_id === clientId)
      })
    }
  }
})

describe('ClientsView — short code editor', () => {
  it('creates a client with an uppercase code and shows existing codes in the list', async () => {
    const create = vi.fn().mockResolvedValue({ ok: true, data: CLIENTS[0] })
    window.api.clients.create = create
    await renderView()
    expect(screen.getByText('ACME')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Neuer Kunde/ }))
    fireEvent.change(screen.getByPlaceholderText('z.B. Mustermann GmbH'), {
      target: { value: 'New' }
    })
    const field = screen.getByLabelText('Kurzcode')
    fireEvent.change(field, { target: { value: 'abc7' } })
    expect(field).toHaveValue('ABC7')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New', short_code: 'ABC7' })
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each(['new7', ''])('edits or clears an existing code with %j', async (value) => {
    const update = vi.fn().mockResolvedValue({ ok: true, data: CLIENTS[0] })
    window.api.clients.update = update
    await renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten: Acme' }))
    const field = screen.getByLabelText('Kurzcode')
    expect(field).toHaveValue('ACME')
    fireEvent.change(field, { target: { value } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, short_code: value.toUpperCase() || null })
    )
  })

  it('shows invalid input at the field without saving', async () => {
    const update = vi.fn()
    window.api.clients.update = update
    await renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten: Acme' }))
    fireEvent.change(screen.getByLabelText('Kurzcode'), { target: { value: 'AC-ME' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    })
    expect(screen.getByLabelText('Kurzcode')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent(/1.*8.*A.Z.*0.9/)
    expect(update).not.toHaveBeenCalled()
  })

  it.each(['create', 'update'] as const)(
    'keeps the form open and shows IPC errors on %s',
    async (method) => {
      const save = vi.fn().mockResolvedValue({
        ok: false,
        error: 'Error: Kurzcode ist bereits einem anderen Kunden zugeordnet.'
      })
      window.api.clients[method] = save
      const version = useClientsStore.getState().version
      await renderView()
      fireEvent.click(
        screen.getByRole('button', {
          name: method === 'create' ? /Neuer Kunde/ : 'Bearbeiten: Acme'
        })
      )
      if (method === 'create') {
        fireEvent.change(screen.getByPlaceholderText('z.B. Mustermann GmbH'), {
          target: { value: 'New' }
        })
      }
      fireEvent.change(screen.getByLabelText('Kurzcode'), { target: { value: 'ABC' } })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
      })
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Kurzcode ist bereits einem anderen Kunden zugeordnet.'
      )
      expect(screen.getByLabelText('Kurzcode')).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByRole('button', { name: 'Speichern' })).toBeEnabled()
      expect(useClientsStore.getState().version).toBe(version)
      fireEvent.change(screen.getByLabelText('Kurzcode'), { target: { value: 'NEXT' } })
      expect(screen.queryByRole('alert')).toBeNull()
      save.mockResolvedValueOnce({ ok: true, data: CLIENTS[0] })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
      })
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(useClientsStore.getState().version).toBe(version + 1)
    }
  )
})

async function renderView(): Promise<void> {
  render(
    <I18nProvider>
      <ClientsView />
    </I18nProvider>
  )
  await act(async () => {})
}

describe('ClientsView billing editors', () => {
  async function openEditor(project = false): Promise<void> {
    await renderView()
    if (project) {
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: /Projekte anzeigen/ })[0])
      })
    }
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: project ? 'Bearbeiten: Rollout' : 'Bearbeiten: Acme' })
      )
    })
  }

  it('shows the rate table and sends a past date, then updates the old field', async () => {
    await openEditor()
    const section = within(screen.getByRole('region', { name: 'Sätze' }))
    expect(section.getByRole('table')).toHaveTextContent('seit Beginn')
    expect(section.getByRole('table')).not.toHaveTextContent('0001-01-01')
    expect(section.getByRole('table')).toHaveTextContent('60,00')
    expect(section.getByRole('button', { name: 'Satz seit Beginn löschen' })).toBeDisabled()
    fireEvent.change(section.getByLabelText('Gültig ab'), { target: { value: '2020-01-01' } })
    fireEvent.change(section.getByLabelText('Satz €/h'), { target: { value: '90' } })
    await act(async () => {
      fireEvent.click(section.getByRole('button', { name: 'Zeile hinzufügen' }))
    })
    expect(window.api.rates.save).toHaveBeenCalledWith(
      { kind: 'client', id: 1 },
      { valid_from: '2020-01-01', rate_cent: 9000, id: undefined }
    )
    expect(screen.getByLabelText('Stundensatz (€/h)')).toHaveValue('90,00')
    expect(section.getByRole('table')).toHaveTextContent('2020-01-01')
  })

  it('edits the baseline rate with its date locked and deletes another row', async () => {
    await openEditor()
    const section = within(screen.getByRole('region', { name: 'Sätze' }))
    fireEvent.click(section.getByRole('button', { name: 'Satz seit Beginn ändern' }))
    expect(section.getByLabelText('Gültig ab')).toBeDisabled()
    expect(section.getByLabelText('Gültig ab')).toHaveValue('0001-01-01')
    fireEvent.change(section.getByLabelText('Satz €/h'), { target: { value: '90' } })
    await act(async () => {
      fireEvent.click(section.getByRole('button', { name: 'Zeile speichern' }))
    })
    expect(window.api.rates.save).toHaveBeenCalledWith(
      { kind: 'client', id: 1 },
      { id: 1, valid_from: '0001-01-01', rate_cent: 9000 }
    )
    await act(async () => {
      fireEvent.click(section.getByRole('button', { name: 'Satz ab 2020-01-01 löschen' }))
    })
    expect(window.api.rates.delete).toHaveBeenCalledWith({ kind: 'client', id: 1 }, 2)
  })

  it('saves a rate on Enter without submitting the surrounding client form', async () => {
    const update = vi.fn()
    window.api.clients.update = update
    await openEditor()
    const section = within(screen.getByRole('region', { name: 'Sätze' }))
    fireEvent.change(section.getByLabelText('Gültig ab'), { target: { value: '2020-01-01' } })
    const rate = section.getByLabelText('Satz €/h')
    fireEvent.change(rate, { target: { value: '90' } })
    await act(async () => {
      fireEvent.keyDown(rate, { key: 'Enter' })
    })
    expect(window.api.rates.save).toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('sends NULL for the project client-rate option and clears the old field', async () => {
    vi.mocked(window.api.rates.save).mockResolvedValue({
      ok: true,
      data: {
        rows: [{ id: 2, valid_from: '2020-01-01', rate_cent: null }],
        current_rate_cent: null
      }
    })
    await openEditor(true)
    const section = within(screen.getByRole('region', { name: 'Sätze' }))
    fireEvent.change(section.getByLabelText('Gültig ab'), { target: { value: '2020-01-01' } })
    fireEvent.click(section.getByLabelText('Kundensatz'))
    await act(async () => {
      fireEvent.click(section.getByRole('button', { name: 'Zeile hinzufügen' }))
    })
    expect(window.api.rates.save).toHaveBeenCalledWith(
      { kind: 'project', id: 10 },
      { valid_from: '2020-01-01', rate_cent: null, id: undefined }
    )
    expect(section.getByRole('table')).toHaveTextContent('Kundensatz')
    expect(screen.getByLabelText('Stundensatz (€/h)')).toHaveValue('')
  })

  it.each([false, true])(
    'sends NULL for blank profile fields and shows inherited placeholders (project=%s)',
    async (project) => {
      await openEditor(project)
      const section = within(screen.getByRole('region', { name: 'Abrechnung' }))
      fireEvent.change(section.getByLabelText('Takt (Minuten)'), { target: { value: '' } })
      fireEvent.change(section.getByLabelText('Mindestzeit (Minuten)'), { target: { value: '' } })
      expect(section.getByLabelText('Takt (Minuten)')).toHaveAttribute('placeholder', '5')
      expect(section.getByLabelText('Mindestzeit (Minuten)')).toHaveAttribute('placeholder', '0')
      await act(async () => {
        fireEvent.click(section.getByRole('button', { name: 'Abrechnung speichern' }))
      })
      expect(window.api.billingProfile.save).toHaveBeenCalledWith(
        { kind: project ? 'project' : 'client', id: project ? 10 : 1 },
        {
          interval_min: null,
          min_unit_min: null,
          columns: null,
          language: null,
          fee_column: null,
          group_by: null
        }
      )
    }
  )

  it('reloads the shown projects after a client profile change, their budget use follows it', async () => {
    const getAll = vi.fn(window.api.projects.getAll)
    window.api.projects.getAll = getAll
    await openEditor(true)
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten: Acme' }))
    })
    getAll.mockClear()
    const version = useClientsStore.getState().version
    const section = within(screen.getByRole('region', { name: 'Abrechnung' }))
    await act(async () => {
      fireEvent.click(section.getByRole('button', { name: 'Abrechnung speichern' }))
    })
    expect(getAll).toHaveBeenCalledWith({ clientId: 1 })
    expect(useClientsStore.getState().version).toBe(version + 1)
  })

  it.each([false, true])(
    'locks the form save while a rate change is pending and the editors while the form saves (project=%s)',
    async (project) => {
      let finishRate: (value: unknown) => void = () => {}
      vi.mocked(window.api.rates.save).mockReturnValue(
        new Promise<unknown>((resolve) => {
          finishRate = resolve
        }) as ReturnType<typeof window.api.rates.save>
      )
      const update = vi.fn()
      if (project) window.api.projects.update = update
      else window.api.clients.update = update
      await openEditor(project)
      const section = within(screen.getByRole('region', { name: 'Sätze' }))
      fireEvent.change(section.getByLabelText('Gültig ab'), { target: { value: '2020-01-01' } })
      fireEvent.change(section.getByLabelText('Satz €/h'), { target: { value: '90' } })
      await act(async () => {
        fireEvent.click(section.getByRole('button', { name: 'Zeile hinzufügen' }))
      })
      const save = screen.getByRole('button', { name: 'Speichern' })
      expect(save).toBeDisabled()
      await act(async () => {
        fireEvent.submit(save.closest('form')!)
      })
      expect(update).not.toHaveBeenCalled()
      await act(async () => {
        finishRate({
          ok: true,
          data: {
            rows: [{ id: 2, valid_from: '2020-01-01', rate_cent: 9000 }],
            current_rate_cent: 9000
          }
        })
      })
      expect(save).toBeEnabled()

      let finishForm: (value: unknown) => void = () => {}
      update.mockReturnValue(
        new Promise((resolve) => {
          finishForm = resolve
        })
      )
      await act(async () => {
        fireEvent.click(save)
      })
      expect(update).toHaveBeenCalled()
      expect(section.getByRole('button', { name: 'Zeile hinzufügen' })).toBeDisabled()
      await act(async () => {
        finishForm({ ok: false, error: 'nope' })
      })
      expect(section.getByRole('button', { name: 'Zeile hinzufügen' })).toBeEnabled()
    }
  )

  // The list copy of the rate lags an editor row that became due while the app
  // was open. The form shows the due rate and sends the rate only when changed.
  it.each([false, true])(
    'takes the due rate on open and sends the rate only when changed (project=%s)',
    async (project) => {
      vi.mocked(window.api.rates.list).mockResolvedValue({
        ok: true,
        data: {
          rows: [{ id: 2, valid_from: '2020-01-01', rate_cent: 9000 }],
          current_rate_cent: 9000
        }
      })
      const update = vi.fn().mockResolvedValue({ ok: true, data: {} })
      if (project) window.api.projects.update = update
      else window.api.clients.update = update
      const open = async (): Promise<void> => {
        await act(async () => {
          fireEvent.click(
            screen.getByRole('button', {
              name: project ? 'Bearbeiten: Rollout' : 'Bearbeiten: Acme'
            })
          )
        })
      }
      const save = async (): Promise<void> => {
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
        })
      }
      await openEditor(project)
      expect(screen.getByLabelText('Stundensatz (€/h)')).toHaveValue('90,00')
      await save()
      expect(update).toHaveBeenCalledTimes(1)
      expect(update.mock.calls[0][0]).not.toHaveProperty('rate_cent')

      await open()
      fireEvent.change(screen.getByLabelText('Stundensatz (€/h)'), { target: { value: '100' } })
      await save()
      expect(update.mock.calls[1][0]).toMatchObject({ rate_cent: 10000 })
      if (!project) return
      await open()
      fireEvent.change(screen.getByLabelText('Stundensatz (€/h)'), { target: { value: '' } })
      await save()
      expect(update.mock.calls[2][0]).toMatchObject({ rate_cent: null })
    }
  )

  it('keeps a rate typed before the editors load', async () => {
    let finishList: (value: unknown) => void = () => {}
    vi.mocked(window.api.rates.list).mockReturnValue(
      new Promise<unknown>((resolve) => {
        finishList = resolve
      }) as ReturnType<typeof window.api.rates.list>
    )
    const update = vi.fn().mockResolvedValue({ ok: true, data: {} })
    window.api.clients.update = update
    await openEditor()
    // The list copy is 0; the typed 0 equals it but not the due rate.
    fireEvent.change(screen.getByLabelText('Stundensatz (€/h)'), { target: { value: '0' } })
    await act(async () => {
      finishList({
        ok: true,
        data: {
          rows: [{ id: 1, valid_from: '0001-01-01', rate_cent: 9000 }],
          current_rate_cent: 9000
        }
      })
    })
    expect(screen.getByLabelText('Stundensatz (€/h)')).toHaveValue('0')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    })
    expect(update.mock.calls[0][0]).toMatchObject({ rate_cent: 0 })
  })

  it('archiving a client does not send its list copy of the rate', async () => {
    const update = vi.fn().mockResolvedValue({ ok: true, data: {} })
    window.api.clients.update = update
    await renderView()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Archivieren: Acme' }))
    })
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 1, active: 0 }))
    expect(update.mock.calls[0][0]).not.toHaveProperty('rate_cent')
  })

  it.each([false, true])(
    'shows the legacy-field conflict as translated field text and keeps the form open (project=%s)',
    async (project) => {
      const save = vi
        .fn()
        .mockResolvedValue({ ok: false, error: 'SqliteError: ' + RATE_EDITOR_CONFLICT_ERROR })
      if (project) window.api.projects.update = save
      else window.api.clients.update = save
      await openEditor(project)
      fireEvent.change(screen.getByLabelText('Stundensatz (€/h)'), { target: { value: '100' } })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
      })
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Für heute gibt es eine Satzzeile. Bitte den Satz unter Sätze ändern.'
      )
      expect(screen.getByLabelText('Stundensatz (€/h)')).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByRole('dialog')).toBeTruthy()
    }
  )
})

describe('ClientsView — focus returns to the opener', () => {
  it('"Neuer Kunde" open and closed: focus is back on the key', async () => {
    await renderView()
    const opener = screen.getByRole('button', { name: /Neuer Kunde/ })
    opener.focus()
    fireEvent.click(opener)
    await act(async () => {})
    expect(screen.getByRole('dialog', { name: 'Neuer Kunde' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})

describe('ClientsView — archived rows and symbol keys', () => {
  it('an archived client: --ink3 name and a legend, no faded row; keys named', async () => {
    await renderView()
    fireEvent.click(screen.getByRole('button', { name: /Archiviert \(1\)/ }))
    await act(async () => {})
    const name = screen.getByText('Altkunde')
    expect(name.style.color).toBe('var(--ink3)')
    expect(name.closest('.opacity-50')).toBeNull()
    expect(screen.getByText('Archiviert', { selector: 'span' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reaktivieren: Altkunde' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Archivieren: Acme' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Projekt hinzufügen: Acme' })).toBeTruthy()
  })

  it('an archived project: --ink3 and a legend; project keys named; end date via i18n', async () => {
    await renderView()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Projekte anzeigen/ })[0])
    })
    expect(screen.getByText('bis 31.12.2026')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Archivieren: Rollout' })).toBeTruthy()
    // The project section of Acme comes before the archived-clients section.
    fireEvent.click(screen.getAllByRole('button', { name: /Archiviert \(1\)/ })[0])
    const name = screen.getByText('Altlast')
    expect(name.style.color).toBe('var(--ink3)')
    expect(name.closest('.opacity-60')).toBeNull()
    expect(screen.getByRole('button', { name: 'Reaktivieren: Altlast' })).toBeTruthy()
  })
})

describe('ClientsView — refused delete (#452)', () => {
  beforeEach(() => useToastStore.setState({ toasts: [] }))

  async function confirmDelete(label: string): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: label }))
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Löschen' })
      )
    })
  }

  it('shows why a client with entries stays and points to archiving', async () => {
    const del = vi.fn().mockResolvedValue({ ok: false, error: CLIENT_HAS_ENTRIES_ERROR })
    Object.assign(window.api.clients, { delete: del })
    await renderView()
    await confirmDelete('Löschen: Acme')
    expect(del).toHaveBeenCalledWith(1)
    expect(useToastStore.getState().toasts.map((x) => x.message)).toEqual([
      'Kunde „Acme“ hat Einträge (auch gelöschte) und lässt sich nicht löschen. Stattdessen archivieren.'
    ])
    expect(screen.getByText('Acme')).toBeTruthy()
  })

  it('shows any other client delete failure with its error', async () => {
    Object.assign(window.api.clients, {
      delete: vi.fn().mockResolvedValue({ ok: false, error: 'disk full' })
    })
    await renderView()
    await confirmDelete('Löschen: Acme')
    expect(useToastStore.getState().toasts.map((x) => x.message)).toEqual([
      'Kunde „Acme“ ließ sich nicht löschen: disk full'
    ])
  })

  it('shows why a project with entries stays and points to archiving', async () => {
    const del = vi.fn().mockResolvedValue({ ok: false, error: PROJECT_HAS_ENTRIES_ERROR })
    Object.assign(window.api.projects, { delete: del })
    await renderView()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Projekte anzeigen/ })[0])
    })
    await confirmDelete('Löschen: Rollout')
    expect(del).toHaveBeenCalledWith(10)
    expect(useToastStore.getState().toasts.map((x) => x.message)).toEqual([
      'Projekt „Rollout“ hat Einträge (auch gelöschte) und lässt sich nicht löschen. Stattdessen archivieren.'
    ])
  })

  it('a client with entries: the key says why and opens no dialog', async () => {
    const del = vi.fn()
    Object.assign(window.api.clients, {
      getAll: async () => ({
        ok: true as const,
        data: CLIENTS.map((c) => ({ ...c, has_entry_versions: c.id === 1 ? 1 : 0 }))
      }),
      delete: del
    })
    await renderView()
    const key = screen.getByRole('button', { name: 'Löschen: Acme' })
    expect(key).toHaveAttribute('aria-disabled', 'true')
    expect(key).toHaveAttribute(
      'title',
      'Hat Einträge (auch gelöschte). Archivieren statt löschen.'
    )
    fireEvent.click(key)
    await act(async () => {})
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(del).not.toHaveBeenCalled()
  })

  it('a project with entries: the key says why and opens no dialog', async () => {
    const del = vi.fn()
    Object.assign(window.api.projects, {
      getAll: async ({ clientId }: { clientId: number }) => ({
        ok: true as const,
        data: PROJECTS.filter((p) => p.client_id === clientId).map((p) => ({
          ...p,
          has_entry_versions: p.id === 10 ? 1 : 0
        }))
      }),
      delete: del
    })
    await renderView()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Projekte anzeigen/ })[0])
    })
    const key = screen.getByRole('button', { name: 'Löschen: Rollout' })
    expect(key).toHaveAttribute('aria-disabled', 'true')
    expect(key).toHaveAttribute(
      'title',
      'Hat Einträge (auch gelöschte). Archivieren statt löschen.'
    )
    fireEvent.click(key)
    await act(async () => {})
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(del).not.toHaveBeenCalled()
    // A record without entries keeps the normal key.
    expect(screen.getByRole('button', { name: 'Löschen: Acme' })).not.toHaveAttribute(
      'aria-disabled'
    )
  })

  it('no longer promises that deleting a client removes its entries', async () => {
    await renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Löschen: Acme' }))
    const text = within(screen.getByRole('alertdialog')).getByText(/wirklich löschen/).textContent
    expect(text).not.toMatch(/mitgelöscht/)
    expect(text).toMatch(/nur archivieren/)
  })
})

describe('Q11 step 2 budget display', () => {
  afterEach(() => {
    vi.useRealTimers()
    useSettingsStore.setState({ settings: null })
  })

  async function showBudget(overrides: Partial<Project> = {}): Promise<void> {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 9, 12))
    const project: Project = {
      ...PROJECTS[0],
      budget_kind: 'eur',
      budget_period: 'month',
      budget_cent: 10000,
      used_cent: 8000,
      pace_cent: 2800,
      effective_rate_cent: 6000,
      internal_minutes: 600,
      month_internal_minutes: 210,
      ...overrides
    }
    window.api.projects.getAll = vi.fn(async () => ({ ok: true as const, data: [project] }))
    await renderView()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Projekte anzeigen|Show projects/ })[0])
    })
  }

  it.each(['de', 'en'] as const)(
    'shows euro monthly ticks, target, forecast and grey internal hours (%s)',
    async (locale) => {
      useSettingsStore.setState({
        settings: { language: locale } as import('../../../shared/types').Settings
      })
      await showBudget()
      const bar = screen.getByRole('progressbar')
      expect(bar).toHaveAttribute('aria-valuenow', '80')
      expect(
        Array.from(bar.querySelectorAll('[data-budget-tick]')).map(
          (tick) => (tick as HTMLElement).style.left
        )
      ).toEqual(['25%', '50%', '75%'])
      expect(bar.querySelector('[data-budget-target]')).toHaveStyle({ left: '30%' })
      // 2000 remaining / (2800/28) = 20 days -> November 29.
      expect(
        screen.getByText(
          locale === 'de' ? 'reicht bis ca. 29.11.2026' : 'lasts until about 29/11/2026'
        )
      ).toBeInTheDocument()
      const internal = screen.getByText(locale === 'de' ? '+ 3,5 h intern' : '+ 3.5 h internal')
      expect(internal).toHaveStyle({ color: 'var(--ink3)' })
      expect(internal).toHaveAttribute(
        'title',
        locale === 'de'
          ? 'nicht abrechenbar, zählt nicht zum Budget'
          : 'non-billable, does not count towards the budget'
      )
    }
  )

  it('shows month-end text when the forecast reaches the next month', async () => {
    await showBudget({ pace_cent: 1400 })
    expect(screen.getByText('reicht bis Monatsende')).toBeInTheDocument()
  })

  it('uses total internal hours and omits an undated total target', async () => {
    await showBudget({ budget_period: 'total', start_date: null, end_date: null })
    expect(screen.getByText('+ 10 h intern')).toBeInTheDocument()
    expect(screen.getByRole('progressbar').querySelector('[data-budget-target]')).toBeNull()
  })

  it('omits zero internal time and a forecast without pace', async () => {
    await showBudget({ month_internal_minutes: 0, pace_cent: 0 })
    expect(screen.queryByText(/h intern/)).toBeNull()
    expect(screen.queryByText(/reicht bis/)).toBeNull()
  })

  it.each([
    ['eur', null, null, 0, true],
    ['eur', null, 0, 0, true],
    ['eur', 5000, null, 5000, false],
    ['eur', 6000, 6000, 0, false],
    ['eur', 0, 0, 5000, true],
    ['hours', null, null, 0, false]
  ] as const)(
    'rate hint kind=%s effective=%s project=%s client=%s',
    async (kind, effective, projectRate, clientRate, hint) => {
      window.api.clients.getAll = vi.fn(async () => ({
        ok: true as const,
        data: CLIENTS.map((c) => ({ ...c, rate_cent: clientRate }))
      }))
      window.api.rates.list = vi
        .fn()
        .mockResolvedValue({ ok: true, data: { rows: [], current_rate_cent: projectRate } })
      await showBudget({
        budget_kind: kind,
        budget_minutes: 600,
        rate_cent: projectRate,
        effective_rate_cent: effective
      })
      const message = 'Kein Satz: Euro-Budget zählt nicht'
      expect(Boolean(screen.queryByText(message))).toBe(hint)
      if (hint) expect(screen.queryByText(/reicht bis/)).toBeNull()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten: Rollout' }))
      })
      const dialog = within(screen.getByRole('dialog'))
      expect(Boolean(dialog.queryByText(message))).toBe(hint)
    }
  )

  it('clears the form hint immediately when a project rate is typed', async () => {
    window.api.rates.list = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { rows: [], current_rate_cent: null } })
    await showBudget({ rate_cent: null, effective_rate_cent: null })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten: Rollout' }))
    })
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('Kein Satz: Euro-Budget zählt nicht')).toBeInTheDocument()
    fireEvent.change(dialog.getByPlaceholderText('Leer = Kundensatz'), { target: { value: '60' } })
    expect(dialog.queryByText('Kein Satz: Euro-Budget zählt nicht')).toBeNull()
    fireEvent.change(dialog.getByPlaceholderText('Leer = Kundensatz'), { target: { value: '' } })
    expect(dialog.getByText('Kein Satz: Euro-Budget zählt nicht')).toBeInTheDocument()
  })
})
