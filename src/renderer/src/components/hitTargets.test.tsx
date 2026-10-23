/**
 * The keys of the toast and the update banner are 44 px targets (HANDOFF §8,
 * owner review PR 5b) — drawn as before, their hit area reaching into the
 * strip's padding through negative margins.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ToastTray } from './Toast'
import { UpdateBanner } from './UpdateBanner'
import { I18nProvider } from '../contexts/I18nContext'
import { useToastStore } from '../store/toastStore'
import { useUpdateStore } from '../store/updateStore'

afterEach(() => {
  cleanup()
  useToastStore.setState({ toasts: [] })
})

describe('44 px keys in toast and update banner', () => {
  it('toast: action and close', () => {
    render(
      <I18nProvider>
        <ToastTray />
      </I18nProvider>
    )
    act(() => {
      useToastStore.getState().show('Eintrag gelöscht', {
        label: 'Rückgängig',
        type: 'undo_delete',
        data: { entryId: 1 }
      })
    })
    expect(screen.getByRole('button', { name: 'Rückgängig' }).className).toContain('min-h-11')
    expect(screen.getByRole('button', { name: 'Schließen' }).className).toContain('h-11 w-11')
  })

  it('update banner: install and dismiss', async () => {
    ;(window as unknown as { api: unknown }).api = {
      update: {
        onStatus: () => () => {},
        getStatus: async () => ({
          ok: true as const,
          data: { status: 'ready' as const, version: '9.9.9' }
        }),
        getLastCheck: async () => ({ ok: true as const, data: null })
      }
    }
    useUpdateStore.setState({ status: { status: 'ready', version: '9.9.9' }, dismissed: false })
    render(
      <I18nProvider>
        <UpdateBanner />
      </I18nProvider>
    )
    await act(async () => {})
    expect(screen.getByRole('button', { name: 'Jetzt neu starten' }).className).toContain(
      'min-h-11'
    )
    expect(screen.getByRole('button', { name: 'Nicht jetzt' }).className).toContain('min-h-11')
  })
})
