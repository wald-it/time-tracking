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
import { act, cleanup, render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import ClientsView from './ClientsView'
import { I18nProvider } from '../contexts/I18nContext'
import type { Client, Project } from '../../../shared/types'
import { useClientsStore } from '../store/clientsStore'

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
