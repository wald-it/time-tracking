/**
 * Kunden view (PR 5b, owner review). Focus comes back to the key that opened
 * a form dialog: the forms used `autoFocus`, which React applies before the
 * dialog shell reads the opener — the shell then remembered its own name
 * field and focus fell to <body> on close. Archived clients and projects are
 * told apart by --ink3 and a legend instead of a faded row, and the symbol
 * keys carry names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import ClientsView from './ClientsView'
import { I18nProvider } from '../contexts/I18nContext'
import type { Client, Project } from '../../../shared/types'

afterEach(cleanup)

const CLIENTS: Client[] = [
  {
    id: 1,
    name: 'Acme',
    color: '#123456',
    active: 1,
    rate_cent: 0,
    created_at: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 2,
    name: 'Altkunde',
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
