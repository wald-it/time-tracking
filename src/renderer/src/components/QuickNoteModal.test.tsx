/**
 * The quick-note prompt saves through entries:update, which re-inserts the row
 * and defaults every field it is not given. After a quick-start switch (B1)
 * the prompt routinely gets entries with a project, so it must pass every
 * field through — not only the description.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QuickNoteModal } from './QuickNoteModal'
import { I18nProvider } from '../contexts/I18nContext'
import type { Entry } from '../../../shared/types'

afterEach(cleanup)

const ENTRY: Entry = {
  id: 42,
  client_id: 2,
  description: '',
  started_at: '2026-10-22T08:00:00.000Z',
  stopped_at: '2026-10-22T09:30:00.000Z',
  heartbeat_at: '2026-10-22T09:30:00.000Z',
  rounded_min: 90,
  deleted_at: null,
  created_at: '2026-10-22T08:00:00.000Z',
  link_id: null,
  tags: ',ops,',
  reference: 'JIRA-7',
  billable: 0,
  private_note: 'internal',
  project_id: 8
}

describe('QuickNoteModal', () => {
  it('keeps project, billable, reference and private note when saving the description', async () => {
    const update = vi.fn(async () => ({ ok: true as const, data: ENTRY }))
    ;(window as unknown as { api: unknown }).api = { entries: { update } }
    const onDone = vi.fn()
    render(
      <I18nProvider>
        <QuickNoteModal entry={ENTRY} onDone={onDone} />
      </I18nProvider>
    )

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Rollout vorbereitet' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(update).toHaveBeenCalledWith({
      id: 42,
      client_id: 2,
      description: 'Rollout vorbereitet',
      started_at: ENTRY.started_at,
      stopped_at: ENTRY.stopped_at,
      tags: ',ops,',
      project_id: 8,
      billable: 0,
      reference: 'JIRA-7',
      private_note: 'internal'
    })
  })
})
