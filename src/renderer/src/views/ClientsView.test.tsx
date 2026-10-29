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

afterEach(cleanup)

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
