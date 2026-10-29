import { afterEach, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Entry } from '../../../../shared/types'
import { I18nProvider } from '../../contexts/I18nContext'
import { DayDetails } from './DayDetails'
import { EntryTable } from '../heute/EntryTable'

afterEach(cleanup)

it.each(['day', 'today'] as const)(
  '%s row marks MCP and import, and clears the mark for hand or system edits',
  (surface) => {
    const entry: Entry = {
      id: 1,
      client_id: 1,
      description: 'Work',
      started_at: '2026-10-29T09:00:00Z',
      stopped_at: '2026-10-29T10:00:00Z',
      heartbeat_at: null,
      rounded_min: null,
      deleted_at: null,
      created_at: '',
      link_id: null,
      tags: '',
      reference: '',
      billable: 1,
      private_note: '',
      source: 'mcp'
    }
    const show = (source: string): React.JSX.Element => (
      <I18nProvider>
        {surface === 'day' ? (
          <DayDetails
            dateISO="2026-10-29"
            entries={[{ ...entry, source }]}
            clients={[]}
            projects={[]}
          />
        ) : (
          <EntryTable
            entries={[{ ...entry, source }]}
            clientsById={new Map()}
            projectsById={new Map()}
            showProjectNumber={false}
            nowMs={Date.now()}
            onEdit={vi.fn()}
            onDelete={vi.fn()}
            onAdd={vi.fn()}
          />
        )}
      </I18nProvider>
    )
    const view = render(show('mcp'))
    expect(screen.getByText('MCP')).toHaveClass('text-[11px]', 'text-[var(--ink3)]')
    view.rerender(show('import'))
    expect(screen.getByText('Kalender-Import')).toBeVisible()
    for (const source of [
      'app',
      'controller',
      'idle',
      'quicknote',
      'migration',
      'recovery',
      'tag-rename'
    ]) {
      view.rerender(show(source))
      expect(screen.queryByText('MCP')).not.toBeInTheDocument()
      expect(screen.queryByText('Kalender-Import')).not.toBeInTheDocument()
    }
  }
)
