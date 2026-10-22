/**
 * B6 (Messinstrument): the START key opens the start modal prefilled with the
 * last used client + project, so Enter starts it. Without a prefill the modal
 * keeps whatever is selected — the header's "Timer starten" relies on that.
 */
import { useState } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
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

  it('keeps an explicit "no project" even when the client has exactly one project', async () => {
    setup()
    // Client 3 has a single active project; the last entry for it had none.
    PROJECTS.push({
      id: 9,
      client_id: 3,
      name: 'Only',
      color: '',
      rate_cent: null,
      active: 1,
      created_at: ''
    })
    CLIENTS.push({
      id: 3,
      name: 'Gamma',
      color: '#333333',
      active: 1,
      rate_cent: 0,
      created_at: ''
    })
    useTimerStore.setState({ clients: CLIENTS })
    try {
      render(
        <I18nProvider>
          <StartTimerModal open onClose={() => {}} prefill={{ clientId: 3, projectId: null }} />
        </I18nProvider>
      )
      const selects = await screen.findAllByRole('combobox')
      await waitFor(() => expect((selects[0] as HTMLSelectElement).value).toBe('3'))
      // Give the project loader its turn, then check it did not auto-pick 'Only'.
      await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(2))
      expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('')
      expect(useTimerStore.getState().selectedProjectId).toBeNull()
    } finally {
      PROJECTS.pop()
      CLIENTS.pop()
    }
  })

  it('a closed second instance (App) does not override the prefill', async () => {
    setup()
    PROJECTS.push({
      id: 9,
      client_id: 3,
      name: 'Only',
      color: '',
      rate_cent: null,
      active: 1,
      created_at: ''
    })
    CLIENTS.push({
      id: 3,
      name: 'Gamma',
      color: '#333333',
      active: 1,
      rate_cent: 0,
      created_at: ''
    })
    useTimerStore.setState({ clients: CLIENTS })
    try {
      render(
        <I18nProvider>
          <StartTimerModal open={false} onClose={() => {}} />
          <StartTimerModal open onClose={() => {}} prefill={{ clientId: 3, projectId: null }} />
        </I18nProvider>
      )
      await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(2))
      // Let every pending project load settle.
      await new Promise((r) => setTimeout(r, 50))
      expect(useTimerStore.getState().selectedProjectId).toBeNull()
    } finally {
      PROJECTS.pop()
      CLIENTS.pop()
    }
  })

  it('a stale project load for the previous client does not undo the prefill', async () => {
    setup()
    // Client 1 is still selected from earlier; the prefill switches to client 2.
    useTimerStore.setState({ selectedClientId: 1, selectedProjectId: null })
    render(
      <I18nProvider>
        <StartTimerModal open onClose={() => {}} prefill={{ clientId: 2, projectId: 8 }} />
      </I18nProvider>
    )
    await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(2))
    await new Promise((r) => setTimeout(r, 50))
    expect(useTimerStore.getState().selectedClientId).toBe(2)
    expect(useTimerStore.getState().selectedProjectId).toBe(8)
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

/**
 * PR 5: the start modal sits on the shared Dialog shell — until then it had
 * no role, no Escape, no focus trap and no focus return.
 */
describe('StartTimerModal — dialog shell (PR 5)', () => {
  function Host(): React.JSX.Element {
    const [open, setOpen] = useState(false)
    return (
      <I18nProvider>
        <button type="button" onClick={() => setOpen(true)}>
          Auslöser
        </button>
        <StartTimerModal
          open={open}
          onClose={() => setOpen(false)}
          prefill={{ clientId: 2, projectId: 8 }}
        />
      </I18nProvider>
    )
  }

  async function openFromTrigger(): Promise<HTMLElement> {
    render(<Host />)
    const trigger = screen.getByRole('button', { name: 'Auslöser' })
    trigger.focus()
    fireEvent.click(trigger)
    await screen.findByRole('dialog')
    await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(2))
    return trigger
  }

  it('is a modal dialog named by its title, focus on the description (Enter starts)', async () => {
    setup()
    await openFromTrigger()
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    await waitFor(() =>
      expect(document.activeElement).toBe(dialog.querySelector('input[type="text"]'))
    )
  })

  it('Escape closes and focus returns to the trigger', async () => {
    setup()
    const trigger = await openFromTrigger()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('Tab from the last control wraps to the first, Shift+Tab back to the last', async () => {
    setup()
    await openFromTrigger()
    const dialog = screen.getByRole('dialog')
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input, select')
    )
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    last.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })
})
