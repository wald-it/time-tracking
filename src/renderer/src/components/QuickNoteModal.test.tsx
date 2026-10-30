/**
 * The quick-note prompt saves through entries:update. In 1.x that re-inserted
 * the row and defaulted every field it was not given, so the prompt had to
 * pass every field through. Since 2.0 (design D3) an update is a patch: the
 * prompt sends the description only, and project, billable, reference, note
 * and the times keep their values in main. This pins that nothing else is
 * sent, so a stale copy cannot overwrite what the entry has by then.
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
  it('sends the description only, as a patch; the other fields stay as they are in main', async () => {
    const update = vi.fn(async () => ({ ok: true as const, data: ENTRY }))
    // Q8: the prompt's field asks for suggestions; none here.
    const recentDescriptions = async (): Promise<{ ok: true; data: string[] }> => ({
      ok: true,
      data: []
    })
    ;(window as unknown as { api: unknown }).api = { entries: { update, recentDescriptions } }
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
      description: 'Rollout vorbereitet',
      source: 'quicknote'
    })
  })
})

// Q8, 2.2: the prompt suggests the recent texts of the stopped entry's
// client and project; a suggestion taken with ↓ Enter is saved by the next
// Enter, as typed text would be.
describe('QuickNoteModal — suggestions (Q8)', () => {
  it('suggests the stopped entry’s pair and saves a taken suggestion', async () => {
    const update = vi.fn(async () => ({ ok: true as const, data: ENTRY }))
    const recentDescriptions = vi.fn(async () => ({
      ok: true as const,
      data: ['Rollout: Planung', 'Review']
    }))
    ;(window as unknown as { api: unknown }).api = { entries: { update, recentDescriptions } }
    const onDone = vi.fn()
    render(
      <I18nProvider>
        <QuickNoteModal entry={ENTRY} onDone={onDone} />
      </I18nProvider>
    )
    await waitFor(() =>
      expect(recentDescriptions).toHaveBeenCalledWith({ clientId: 2, projectId: 8 })
    )

    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(update).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Rollout: Planung' })
    )
  })
})
