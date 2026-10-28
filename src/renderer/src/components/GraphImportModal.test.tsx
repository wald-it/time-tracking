/**
 * Calendar import (owner review PR 5b): the take-it and learn checkboxes are
 * 44 px targets (HANDOFF §8) — the 16 px box sits in a 44 × 44 label.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { GraphImportModal } from './GraphImportModal'
import { I18nProvider } from '../contexts/I18nContext'
import type { Client } from '../../../shared/types'

afterEach(cleanup)

const ACME: Client = {
  short_code: null,
  id: 1,
  name: 'Acme',
  color: '#123456',
  active: 1,
  rate_cent: 0,
  created_at: '2026-01-01T00:00:00.000Z'
}

describe('GraphImportModal — hit targets', () => {
  it('take-it box and learn box sit in 44 px labels', async () => {
    ;(window as unknown as { api: unknown }).api = {
      graph: {
        calendarPreview: async () => ({
          ok: true as const,
          data: {
            drafts: [
              {
                graphEventId: 'e1',
                description: 'Workshop',
                startedAt: '2026-10-20T08:00:00.000Z',
                stoppedAt: '2026-10-20T10:00:00.000Z',
                clientId: 1,
                projectId: null,
                domains: ['acme.de'],
                clientHint: 'matched'
              }
            ],
            skipped: []
          }
        }),
        listDomains: async () => ({ ok: true as const, data: [] })
      },
      projects: { getAll: async () => ({ ok: true as const, data: [] }) }
    }
    render(
      <I18nProvider>
        <GraphImportModal open onClose={() => {}} clients={[ACME]} />
      </I18nProvider>
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Termine laden' }))
    })
    const take = screen.getByRole('checkbox', { name: 'Workshop' })
    expect(take.closest('label')?.className).toContain('h-11 w-11')
    const learn = screen.getAllByRole('checkbox').find((c) => c !== take) as HTMLInputElement
    expect(learn.closest('label')?.className).toContain('min-h-11')
  })
})
