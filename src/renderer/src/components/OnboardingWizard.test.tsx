/**
 * Onboarding (PR 5b, owner review): a step change keeps the focus in the
 * dialog, the colour presets are named 44 px keys with `aria-pressed`, and
 * the "created" line follows the app language.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { OnboardingWizard } from './OnboardingWizard'
import { I18nProvider } from '../contexts/I18nContext'
import { useSettingsStore } from '../store/settingsStore'
import type { Settings } from '../../../shared/types'

afterEach(() => {
  cleanup()
  useSettingsStore.setState({ settings: null })
})

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    backups: { list: async () => ({ ok: true as const, data: [] }) },
    clients: { create: async () => ({ ok: true as const, data: { id: 1 } }) },
    settings: { set: async () => ({ ok: true as const, data: null }) }
  }
})

async function renderWizard(): Promise<void> {
  render(
    <I18nProvider>
      <OnboardingWizard open onFinish={() => {}} />
    </I18nProvider>
  )
  await act(async () => {})
}

describe('OnboardingWizard', () => {
  it('restores the latest backup with its folder origin (#512)', async () => {
    window.api.backups.list = async () => ({
      ok: true,
      data: [
        {
          filename: 'backup-daily-2026-11-05.sqlite',
          folder: 'default',
          fullPath: '',
          reason: 'daily',
          createdAt: '2026-11-05T12:00:00Z',
          sizeBytes: 1024
        }
      ]
    })
    window.api.backups.restore = vi.fn(async () => ({
      ok: true as const,
      data: { safetyBackupPath: '' }
    }))
    window.api.app = {
      relaunch: vi.fn(async () => ({ ok: true as const, data: undefined }))
    } as unknown as Window['api']['app']
    await renderWizard()
    for (let step = 0; step < 3; step++) {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
      })
    }
    fireEvent.click(screen.getByRole('button', { name: 'Wiederherstellen' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Wiederherstellen' }))
    })
    expect(window.api.backups.restore).toHaveBeenCalledWith(
      'backup-daily-2026-11-05.sqlite',
      'default'
    )
    expect(window.api.app.relaunch).toHaveBeenCalled()
  })

  it('each step change puts focus on the new step: name field, then the finish key', async () => {
    await renderWizard()
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
    await act(async () => {})
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: /Kundenname/ }))

    fireEvent.change(screen.getByRole('textbox', { name: /Kundenname/ }), {
      target: { value: 'Acme' }
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Kunden anlegen' }))
    })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Loslegen' }))
    expect(screen.getByText('✓ Acme angelegt.')).toBeTruthy()
  })

  it('colour presets: named, aria-pressed, 44 px keys', async () => {
    await renderWizard()
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
    await act(async () => {})
    const group = screen.getByRole('group', { name: 'Farbe' })
    const keys = within(group).getAllByRole('button')
    expect(keys.length).toBeGreaterThan(1)
    expect(keys[0].getAttribute('aria-pressed')).toBe('true')
    expect(keys[1].getAttribute('aria-pressed')).toBe('false')
    expect(keys[1].getAttribute('aria-label')).toMatch(/Violett|violet/i)
    expect(keys[1].className).toContain('h-11 w-11')
    fireEvent.click(keys[1])
    expect(keys[1].getAttribute('aria-pressed')).toBe('true')
  })

  it('the "created" line is English in the English UI', async () => {
    useSettingsStore.setState({ settings: { language: 'en' } as Settings })
    await renderWizard()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await act(async () => {})
    fireEvent.change(screen.getByRole('textbox', { name: /Client name/ }), {
      target: { value: 'Acme' }
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create client' }))
    })
    expect(screen.getByText('✓ Acme created.')).toBeTruthy()
  })
})
