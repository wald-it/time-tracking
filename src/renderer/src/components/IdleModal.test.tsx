import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { IdleModal } from './IdleModal'
import { I18nProvider } from '../contexts/I18nContext'
import type { Client, Project } from '../../../shared/types'
import type { PeriodReviewEntry } from '../../../shared/ruleCheck'

const previousTz = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'Europe/Berlin'
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

const clients: Client[] = [1, 2, 3, 4].map((id) => ({
  id,
  name: `Client ${id}`,
  active: id === 4 ? 0 : 1,
  color: '',
  rate_cent: 0,
  short_code: null,
  created_at: ''
}))
const projects: Project[] = [
  {
    id: 11,
    client_id: 1,
    name: 'Running client project',
    active: 1,
    status: 'active',
    color: '',
    rate_cent: null,
    created_at: ''
  },
  {
    id: 21,
    client_id: 2,
    name: 'Paused project',
    active: 0,
    status: 'paused',
    color: '',
    rate_cent: null,
    created_at: ''
  },
  {
    id: 22,
    client_id: 2,
    name: 'Archived status',
    active: 1,
    status: 'archived',
    color: '',
    rate_cent: null,
    created_at: ''
  },
  {
    id: 23,
    client_id: 2,
    name: 'Inactive project',
    active: 0,
    color: '',
    rate_cent: null,
    created_at: ''
  }
]
function recent(clientId: number, day: number): PeriodReviewEntry {
  const start = new Date(2026, 9, day, 10).toISOString()
  return { client_id: clientId, started_at: start, entry_start: start } as PeriodReviewEntry
}
let history: PeriodReviewEntry[]
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 2, 12))
  history = []
  const api = {
    entries: {
      getForReview: vi.fn()
    },
    dashboard: {
      // recentEntries: the last five entries overall, newest first.
      summary: vi.fn(async () => ({
        ok: true as const,
        data: {
          recentEntries: [...history]
            .sort((a, b) => Date.parse(b.entry_start) - Date.parse(a.entry_start))
            .slice(0, 5)
        }
      }))
    },
    projects: {
      getAll: vi.fn(async ({ clientId }: { clientId: number }) => ({
        ok: true as const,
        data: projects.filter((p) => p.client_id === clientId)
      }))
    }
  }
  ;(window as unknown as { api: typeof api }).api = api
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function setup(list = clients): { keep: ReturnType<typeof vi.fn>; book: ReturnType<typeof vi.fn> } {
  const keep = vi.fn()
  const book = vi.fn()
  render(
    <I18nProvider>
      <IdleModal
        idleSince={new Date(2026, 10, 2, 11, 23, 45, 678).toISOString()}
        idleSeconds={1800}
        onKeep={keep}
        onStopAtIdle={vi.fn()}
        onMarkPause={vi.fn()}
        onWorkFor={book}
        clients={list}
        runningClientId={1}
        isLoading={false}
      />
    </I18nProvider>
  )
  return { keep, book }
}
function expand(): void {
  fireEvent.click(screen.getByRole('button', { name: 'War Arbeit für …' }))
}

describe('IdleModal work picker', () => {
  it('expands inline, filters archived clients/projects, follows the client and books its project', async () => {
    const { book } = setup()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expand()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    const client = screen.getByLabelText('Kunde')
    const project = screen.getByLabelText('Projekt (optional)')
    expect(client).toHaveValue('2')
    expect(within(client).queryByText('Client 4')).not.toBeInTheDocument()
    expect(within(client).getByText('Client 1')).toBeInTheDocument()
    await screen.findByRole('option', { name: 'Paused project' })
    expect(screen.queryByText('Archived status')).not.toBeInTheDocument()
    expect(screen.queryByText('Inactive project')).not.toBeInTheDocument()
    expect(project).toHaveValue('')
    fireEvent.change(project, { target: { value: '21' } })
    fireEvent.click(screen.getByRole('button', { name: 'Buchen' }))
    expect(book).toHaveBeenLastCalledWith(2, 21)
    fireEvent.change(client, { target: { value: '1' } })
    expect(project).toHaveValue('')
    await screen.findByRole('option', { name: 'Running client project' })
    expect(screen.queryByText('Paused project')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Buchen' }))
    expect(book).toHaveBeenLastCalledWith(1, null)
  })

  it('preselects the most recent other active client from the recent entries, skipping running and archived ones', async () => {
    history = [recent(3, 3), recent(2, 1), recent(1, 5), recent(4, 6), recent(3, 2)]
    setup()
    expand()
    await waitFor(() => expect(screen.getByLabelText('Kunde')).toHaveValue('3'))
    expect(screen.getByLabelText('Projekt (optional)')).toHaveValue('')
    expect(window.api.dashboard.summary).toHaveBeenCalledTimes(1)
    // No per-client history read: it would scale with the database.
    expect(window.api.entries.getForReview).not.toHaveBeenCalled()
  })

  it('falls back to the first other active client in list order', async () => {
    setup([clients[3], clients[2], clients[1], clients[0]])
    expand()
    await waitFor(() => expect(window.api.dashboard.summary).toHaveBeenCalledTimes(1))
    expect(screen.getByLabelText('Kunde')).toHaveValue('3')
  })

  it('falls back to the running client when it is the only active client', () => {
    setup([clients[3], clients[0]])
    expand()
    expect(screen.getByLabelText('Kunde')).toHaveValue('1')
  })

  it('disables confirm without an active client or after clearing the selection', () => {
    setup()
    expand()
    fireEvent.change(screen.getByLabelText('Kunde'), { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Buchen' })).toBeDisabled()
    cleanup()
    setup([clients[3]])
    expand()
    expect(screen.getByLabelText('Kunde')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Buchen' })).toBeDisabled()
  })

  it('keeps initial focus and collapses on Escape before keeping; Back returns focus too', async () => {
    const { keep } = setup()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Weiter laufen lassen' })).toHaveFocus()
    )
    expand()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'War Arbeit für …' })).toHaveFocus()
    expect(keep).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(keep).toHaveBeenCalledTimes(1)
    expand()
    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }))
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'War Arbeit für …' })).toHaveFocus()
  })
})
