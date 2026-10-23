/**
 * Settings → Über showed the app version three times (#274): the Updates row
 * put it in both its label ("Aktuelle Version: x") and its value, and the Über
 * row below repeats it. The Über row is the one that stays, so the Updates
 * section must not mention the version at all.
 *
 * The version is a value no other text in the section can contain, so a match
 * anywhere in the section means a version row came back.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { UpdatesSection } from './SettingsView'
import { I18nProvider } from '../contexts/I18nContext'

// `globals` is off in vitest.config.ts, so Testing Library's auto-cleanup
// afterEach is never registered — unmount explicitly.
afterEach(cleanup)

const VERSION = '9.8.7'

beforeEach(() => {
  const api = {
    settings: { getAll: async () => ({ ok: true as const, data: {} }) },
    update: {
      onStatus: () => () => {},
      getVersion: async () => ({ ok: true as const, data: VERSION }),
      getStatus: async () => ({ ok: true as const, data: { status: 'idle' as const } }),
      getLastCheck: async () => ({ ok: true as const, data: null }),
      check: async () => ({ ok: true as const, data: undefined }),
      install: async () => ({ ok: true as const, data: undefined })
    }
  }
  ;(window as unknown as { api: typeof api }).api = api
})

describe('Settings → Updates section (#274)', () => {
  it('has no version row', async () => {
    const { container } = render(
      <I18nProvider>
        <UpdatesSection />
      </I18nProvider>
    )
    // Let init() resolve so the store holds the version before we look.
    await act(async () => {})

    const text = container.textContent ?? ''
    // Guard against a vacuous pass: the section did render.
    expect(text).toContain('Jetzt nach Updates suchen')
    expect(text).not.toContain(VERSION)
    expect(text).not.toContain('Aktuelle Version')
  })
})
