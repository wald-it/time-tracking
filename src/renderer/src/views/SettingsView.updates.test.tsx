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
import { cleanup, render, waitFor } from '@testing-library/react'
import { UpdatesSection } from './SettingsView'
import { I18nProvider } from '../contexts/I18nContext'
import { useUpdateStore } from '../store/updateStore'
import { de } from '../../../shared/locales/de'

// `globals` is off in vitest.config.ts, so Testing Library's auto-cleanup
// afterEach is never registered — unmount explicitly.
afterEach(cleanup)

const VERSION = '9.8.7'
const LAST_CHECK = '2026-10-23T08:00:00.000Z'

beforeEach(() => {
  const api = {
    settings: { getAll: async () => ({ ok: true as const, data: {} }) },
    // The version's only source since #281: a version row that came back
    // would read it here.
    app: { getVersion: async () => ({ ok: true as const, data: VERSION }) },
    update: {
      onStatus: () => () => {},
      getStatus: async () => ({ ok: true as const, data: { status: 'idle' as const } }),
      getLastCheck: async () => ({ ok: true as const, data: LAST_CHECK }),
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
        <UpdatesSection autoCheck onAutoCheckChange={() => {}} />
      </I18nProvider>
    )
    // Guards against a vacuous pass: init() has finished loading and the
    // section rendered, so the version's absence below is a finding, not a
    // render that ran before the store was filled.
    await waitFor(() => expect(useUpdateStore.getState().lastCheckedAt).toBe(LAST_CHECK))
    const text = container.textContent ?? ''
    expect(text).toContain(de['settings.update.checkNow'])
    expect(text).not.toContain(VERSION)
    // The removed row's label, in case it returns without a value. The test
    // renders the default locale (de) only.
    expect(text).not.toContain('Aktuelle Version')
  })
})
