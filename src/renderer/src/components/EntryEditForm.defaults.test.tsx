import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { EntryEditForm } from './EntryEditForm'
import { I18nProvider } from '../contexts/I18nContext'
import type { Entry } from '../../../shared/types'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 7, 10, 12))
  window.api = {
    tags: { getAllWithCount: async () => ({ ok: true, data: [] }) }
  } as unknown as Window['api']
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

async function mount(defaultEnd?: Date, entry?: Entry): Promise<void> {
  await act(async () => {
    render(
      <I18nProvider>
        <EntryEditForm
          clients={[]}
          entry={entry}
          defaultDate={new Date(2026, 7, 10, 9)}
          defaultEnd={defaultEnd}
          onSaved={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>
    )
  })
}

describe('EntryEditForm create defaults', () => {
  it('uses defaultEnd in create mode', async () => {
    await mount(new Date(2026, 7, 10, 11, 30))
    expect(screen.getByLabelText('Start')).toHaveValue('09:00')
    expect(screen.getByLabelText('Ende')).toHaveValue('11:30')
  })

  it('keeps start plus one hour when defaultEnd is absent', async () => {
    await mount()
    expect(screen.getByLabelText('Ende')).toHaveValue('10:00')
  })

  it.each([false, true])('ignores defaultEnd in edit mode, running=%s', async (running) => {
    await mount(new Date(2026, 7, 10, 11, 30), {
      client_id: 0,
      started_at: new Date(2026, 7, 10, 8).toISOString(),
      stopped_at: running ? null : new Date(2026, 7, 10, 10, 15).toISOString()
    } as Entry)
    expect(screen.getByLabelText('Start')).toHaveValue('08:00')
    expect(screen.getByLabelText('Ende')).toHaveValue(running ? '09:00' : '10:15')
  })
})
