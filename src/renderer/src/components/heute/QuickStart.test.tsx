/**
 * Schnellstart (HANDOFF §3.11, B1 with the owner correction of 2026-10-22):
 * preset keys + project list. Pins what the keys promise — a click starts the
 * last project or, while a timer runs, switches to it; the key whose pair
 * already runs does nothing; the ▾ list opens, is keyboard-driven, starts the
 * chosen row and closes back onto ▾; the B1 switch set to `false` locks it all.
 *
 * The switch itself (one main-process transaction, quick note for the stopped
 * entry) is pinned in useTimer.test.tsx and entryMutations.test.ts; here the
 * component only has to call the right callback with the right pair.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QuickStart } from './QuickStart'
import { I18nProvider } from '../../contexts/I18nContext'
import type { Client, DashboardSummary, Project } from '../../../../shared/types'
import type { RunningPair } from './quickStartList'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function client(id: number, name: string, active = 1): Client {
  return {
    id,
    name,
    color: '#123456',
    active,
    rate_cent: 0,
    created_at: '2026-01-01T00:00:00.000Z'
  }
}

function project(id: number, client_id: number, name: string, active = 1): Project {
  return { id, client_id, name, color: '', rate_cent: null, active, created_at: '2026-01-01' }
}

const CLIENTS = new Map(
  [
    client(1, 'Acme'),
    client(2, 'Beta'),
    client(3, 'Gamma', 0),
    client(4, 'Delta'),
    client(5, 'Epsilon')
  ].map((c) => [c.id, c])
)

const PROJECTS = new Map(
  [
    project(10, 1, 'Rollout'),
    project(11, 1, 'Audit'),
    project(12, 1, 'Alt', 0),
    project(20, 2, 'Beratung')
  ].map((p) => [p.id, p])
)

const TOP: DashboardSummary['topClients30d'] = [
  { client_id: 1, name: 'Acme', color: '#111111', seconds: 48 * 3600, last_project_id: 11 },
  // Deactivated since the summary was read: skipped before the cut.
  { client_id: 3, name: 'Gamma', color: '#333333', seconds: 40 * 3600, last_project_id: null },
  { client_id: 2, name: 'Beta', color: '#222222', seconds: 30 * 3600, last_project_id: 20 },
  // No projects at all: no ▾ segment.
  { client_id: 4, name: 'Delta', color: '#444444', seconds: 20 * 3600, last_project_id: null },
  // The fourth active client — cut, three keys only.
  { client_id: 5, name: 'Epsilon', color: '#555555', seconds: 10 * 3600, last_project_id: null }
]

function setup(opts: { running?: RunningPair | null; switchWhileRunning?: boolean } = {}): {
  onStart: ReturnType<typeof vi.fn>
  onSwitch: ReturnType<typeof vi.fn>
} {
  const onStart = vi.fn()
  const onSwitch = vi.fn()
  render(
    <I18nProvider>
      <div>
        <QuickStart
          topClients={TOP}
          running={opts.running ?? null}
          clientsById={CLIENTS}
          projectsById={PROJECTS}
          onStart={onStart}
          onSwitch={onSwitch}
          switchWhileRunning={opts.switchWhileRunning}
        />
        <button type="button">outside</button>
      </div>
    </I18nProvider>
  )
  return { onStart, onSwitch }
}

const toggleFor = (name: string): HTMLElement =>
  screen.getByRole('button', { name: `Projekt wählen für ${name}` })

describe('QuickStart — keys', () => {
  it('shows three keys: inactive clients skipped before the cut', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Timer für Acme, Audit starten' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Timer für Beta, Beratung starten' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Timer für Delta starten' })).toBeTruthy()
    expect(screen.queryByText('Gamma')).toBeNull()
    expect(screen.queryByText('Epsilon')).toBeNull()
  })

  it('renders nothing without frequent clients', () => {
    const { container } = render(
      <I18nProvider>
        <QuickStart
          topClients={[]}
          running={null}
          clientsById={CLIENTS}
          projectsById={PROJECTS}
          onStart={vi.fn()}
          onSwitch={vi.fn()}
        />
      </I18nProvider>
    )
    expect(container.innerHTML).toBe('')
  })

  it('a click starts the last project', () => {
    const { onStart, onSwitch } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Timer für Acme, Audit starten' }))
    expect(onStart).toHaveBeenCalledWith(1, 11)
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('while a timer runs, a click switches to the last project (B1)', () => {
    const { onStart, onSwitch } = setup({ running: { clientId: 2, projectId: 20 } })
    fireEvent.click(screen.getByRole('button', { name: 'Zu Acme, Audit wechseln' }))
    expect(onSwitch).toHaveBeenCalledWith(1, 11)
    expect(onStart).not.toHaveBeenCalled()
    expect(screen.getByText('Klick wechselt sofort · ▾ oder halten: Projekt wählen')).toBeTruthy()
  })

  it('the key whose client and last project already run does nothing', () => {
    const { onStart, onSwitch } = setup({ running: { clientId: 1, projectId: 11 } })
    fireEvent.click(screen.getByRole('button', { name: 'Acme, Audit läuft bereits' }))
    expect(onStart).not.toHaveBeenCalled()
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('the running client shows LÄUFT and the running project in its sub-line', () => {
    setup({ running: { clientId: 1, projectId: 10 } })
    const key = screen.getByRole('button', { name: 'Zu Acme, Audit wechseln' })
    expect(within(key).getByText('Läuft')).toBeTruthy()
    expect(within(key).getByText('Rollout')).toBeTruthy()
  })

  it('a client without active projects has no ▾ segment', () => {
    setup()
    expect(screen.queryByRole('button', { name: 'Projekt wählen für Delta' })).toBeNull()
    expect(toggleFor('Acme')).toBeTruthy()
  })

  it('switch set to false: keys, ▾ and hint fall back to the old lock', () => {
    const { onStart, onSwitch } = setup({
      running: { clientId: 2, projectId: 20 },
      switchWhileRunning: false
    })
    const main = screen.getByRole('button', {
      name: 'Zu Acme, Audit wechseln'
    }) as HTMLButtonElement
    expect(main.disabled).toBe(true)
    expect((toggleFor('Acme') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(main)
    expect(onStart).not.toHaveBeenCalled()
    expect(onSwitch).not.toHaveBeenCalled()
    expect(screen.getByText('Klick startet sofort · ▾ oder halten: Projekt wählen')).toBeTruthy()
  })
})

describe('QuickStart — project list', () => {
  it('▾ opens the menu with focus on ZULETZT; Esc closes it and focuses ▾', () => {
    setup()
    const toggle = toggleFor('Acme')
    expect(toggle.getAttribute('aria-haspopup')).toBe('menu')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const menu = screen.getByRole('menu')
    const items = within(menu).getAllByRole('menuitem')
    // Active projects in order, then "Kein Projekt"; the archived one is not offered.
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Rollout'),
      expect.stringContaining('Audit'),
      expect.stringContaining('Kein Projekt')
    ])
    expect(document.activeElement).toBe(items[1])
    expect(items[1].textContent).toContain('Zuletzt')

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(toggle)
  })

  it('↓ on ▾ opens it; ↑↓ move; Enter starts the chosen project', () => {
    const { onStart } = setup()
    fireEvent.keyDown(toggleFor('Acme'), { key: 'ArrowDown' })
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    expect(onStart).toHaveBeenCalledWith(1, 10)
    expect(screen.queryByRole('menu')).toBeNull()
    // Focus returns to ▾ instead of falling to <body> with the closed list.
    expect(document.activeElement).toBe(toggleFor('Acme'))
  })

  it('"Kein Projekt" starts with null', () => {
    const { onStart } = setup()
    fireEvent.click(toggleFor('Acme'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toContain('Kein Projekt')
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    expect(onStart).toHaveBeenCalledWith(1, null)
  })

  it('while a timer runs, a row switches; the LÄUFT row has no action', () => {
    const { onStart, onSwitch } = setup({ running: { clientId: 1, projectId: 10 } })
    fireEvent.click(toggleFor('Acme'))
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem')
    expect(items[0].getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(items[0])
    expect(onSwitch).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.click(items[1])
    expect(onSwitch).toHaveBeenCalledWith(1, 11)
    expect(onStart).not.toHaveBeenCalled()
  })

  it('only one list is open at a time', () => {
    setup()
    fireEvent.click(toggleFor('Acme'))
    fireEvent.click(toggleFor('Beta'))
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(toggleFor('Acme').getAttribute('aria-expanded')).toBe('false')
    expect(toggleFor('Beta').getAttribute('aria-expanded')).toBe('true')
  })

  it('a click outside, Tab and a window resize each close it', () => {
    setup()
    fireEvent.click(toggleFor('Acme'))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }))
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(toggleFor('Acme'))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(toggleFor('Acme'))
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('holding the main area 300 ms opens the list, and that release starts nothing', () => {
    vi.useFakeTimers()
    const { onStart } = setup()
    const main = screen.getByRole('button', { name: 'Timer für Acme, Audit starten' })
    fireEvent.pointerDown(main, { button: 0, clientX: 10, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(299)
    })
    expect(screen.queryByRole('menu')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.pointerUp(main)
    fireEvent.click(main)
    expect(onStart).not.toHaveBeenCalled()
  })

  it('a hold that moves more than 8 px is cancelled', () => {
    vi.useFakeTimers()
    setup()
    const main = screen.getByRole('button', { name: 'Timer für Acme, Audit starten' })
    fireEvent.pointerDown(main, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(main, { clientX: 30, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('a right-click opens the list', () => {
    setup()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Timer für Acme, Audit starten' }))
    expect(screen.getByRole('menu')).toBeTruthy()
  })
  it('a click on the main area while the list is open starts and closes the list', () => {
    const { onStart } = setup()
    fireEvent.click(toggleFor('Acme'))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Timer für Acme, Audit starten' }))
    expect(onStart).toHaveBeenCalledWith(1, 11)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
