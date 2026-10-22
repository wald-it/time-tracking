/**
 * B6 (Messinstrument): the START key opens the start modal prefilled with the
 * last used client + project, so Enter starts it. Without a prefill the modal
 * keeps whatever is selected — the header's "Timer starten" relies on that.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { StartTimerModal } from './StartTimerModal'
import { I18nProvider } from '../contexts/I18nContext'
import { useTimerStore } from '../store/timerStore'
import type { Client, Project } from '../../../shared/types'

afterEach(() => {
  cleanup()
  useTimerStore.setState({ selectedClientId: null, selectedProjectId: null })
})

const CLIENTS: Client[] = [
  { id: 1, name: 'Acme', color: '#111111', active: 1, rate_cent: 0, created_at: '' },
  { id: 2, name: 'Beta', color: '#222222', active: 1, rate_cent: 0, created_at: '' }
]

const PROJECTS: Project[] = [
  { id: 7, client_id: 2, name: 'Audit', color: '', rate_cent: null, active: 1, created_at: '' },
  { id: 8, client_id: 2, name: 'Rollout', color: '', rate_cent: null, active: 1, created_at: '' }
]

function setup(): void {
  const api = {
    entries: { getRunning: async () => ({ ok: true as const, data: null }) },
    clients: { getAll: async () => ({ ok: true as const, data: CLIENTS }) },
    projects: {
      getAll: vi.fn(async ({ clientId }: { clientId?: number }) => ({
        ok: true as const,
        data: PROJECTS.filter((p) => clientId == null || p.client_id === clientId)
      }))
    },
    dashboard: { todayTotal: async () => ({ ok: true as const, data: 0 }) },
    tray: { update: vi.fn() },
    idle: { dismiss: vi.fn() },
    onHotkeyToggle: () => {},
    onTrayQuickStart: () => {},
    onTrayStop: () => {},
    onDataChanged: () => {},
    onIdleDetected: () => {}
  }
  ;(window as unknown as { api: typeof api }).api = api
  useTimerStore.setState({ clients: CLIENTS })
}

describe('StartTimerModal — prefill (B6)', () => {
  it('preselects the given client and project when it opens', async () => {
    setup()
    render(
      <I18nProvider>
        <StartTimerModal open onClose={() => {}} prefill={{ clientId: 2, projectId: 8 }} />
      </I18nProvider>
    )
    const selects = await screen.findAllByRole('combobox')
    await waitFor(() => expect((selects[0] as HTMLSelectElement).value).toBe('2'))
    await waitFor(() => {
      const project = screen.getAllByRole('combobox')[1] as HTMLSelectElement
      expect(project.value).toBe('8')
    })
  })

  it('leaves the current selection alone without a prefill', async () => {
    setup()
    useTimerStore.setState({ selectedClientId: 1, selectedProjectId: null })
    render(
      <I18nProvider>
        <StartTimerModal open onClose={() => {}} />
      </I18nProvider>
    )
    const selects = await screen.findAllByRole('combobox')
    expect((selects[0] as HTMLSelectElement).value).toBe('1')
  })
})
