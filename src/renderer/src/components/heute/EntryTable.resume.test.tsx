/**
 * Q8 (2.0.0): a "Fortsetzen" key (play glyph) in the action column of Heute's
 * entry table. Not on the running row (it already runs); disabled for an
 * archived client.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EntryTable } from './EntryTable'
import { I18nProvider } from '../../contexts/I18nContext'
import type { Client, Entry, Project } from '../../../../shared/types'

afterEach(cleanup)

const CLIENTS = new Map<number, Client>([
  [1, { id: 1, name: 'Acme', color: '#111111', active: 1, rate_cent: 0, created_at: '' }],
  [3, { id: 3, name: 'Alt', color: '#333333', active: 0, rate_cent: 0, created_at: '' }]
])
const PROJECTS = new Map<number, Project>()

function entry(id: number, over: Partial<Entry>): Entry {
  return {
    id,
    client_id: 1,
    project_id: null,
    description: 'Review',
    started_at: '2026-10-23T08:00:00.000Z',
    stopped_at: '2026-10-23T09:00:00.000Z',
    heartbeat_at: null,
    rounded_min: null,
    deleted_at: null,
    created_at: '',
    link_id: null,
    tags: '',
    reference: '',
    billable: 1,
    private_note: '',
    ...over
  }
}

function setup(entries: Entry[]): { onResume: ReturnType<typeof vi.fn> } {
  const onResume = vi.fn()
  render(
    <I18nProvider>
      <EntryTable
        entries={entries}
        clientsById={CLIENTS}
        projectsById={PROJECTS}
        nowMs={Date.parse('2026-10-23T12:00:00.000Z')}
        roundMinutes={0}
        showProjectNumber={false}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAdd={vi.fn()}
        onResume={onResume}
      />
    </I18nProvider>
  )
  return { onResume }
}

describe('EntryTable — Fortsetzen (Q8)', () => {
  it('a stopped row resumes its entry', () => {
    const e = entry(1, {})
    const { onResume } = setup([e])

    fireEvent.click(screen.getByRole('button', { name: /fortsetzen/i }))

    expect(onResume).toHaveBeenCalledWith(e)
  })

  it('the running row has no resume key', () => {
    setup([entry(1, { stopped_at: null })])
    expect(screen.queryByRole('button', { name: /fortsetzen/i })).toBeNull()
  })

  it('a row of an archived client cannot be resumed', () => {
    const { onResume } = setup([entry(1, { client_id: 3 })])
    const key = screen.getByRole('button', { name: /fortsetzen/i }) as HTMLButtonElement

    expect(key.disabled).toBe(true)
    fireEvent.click(key)
    expect(onResume).not.toHaveBeenCalled()
  })
})
