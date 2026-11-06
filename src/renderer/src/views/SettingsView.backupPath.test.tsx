import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import SettingsView from './SettingsView'
import { I18nProvider } from '../contexts/I18nContext'
import { useSettingsStore } from '../store/settingsStore'
import type { Settings } from '../../../shared/types'
import { de } from '../../../shared/locales/de'
import { en } from '../../../shared/locales/en'

const CUSTOM = 'O:\\OneDrive\\TimeTrack'
const DEFAULT = 'C:\\Users\\me\\AppData\\Roaming\\time-tracking\\backups'

afterEach(() => {
  cleanup()
  useSettingsStore.setState({ settings: null })
})

async function openData(locale: 'de' | 'en', isReachable: boolean): Promise<typeof en> {
  const settings = { language: locale } as Settings
  useSettingsStore.setState({ settings })
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      getAll: async () => ({ ok: true, data: settings }),
      set: async () => ({ ok: true, data: undefined })
    },
    paths: {
      get: async () => ({
        ok: true,
        data: {
          db: '',
          backups: CUSTOM,
          logs: '',
          logFile: '',
          mcp: { command: '', args: [], env: {}, available: false }
        }
      })
    },
    app: { getVersion: async () => ({ ok: true, data: '2.6.1' }) },
    backups: {
      list: async () => ({ ok: true, data: [] }),
      getPathInfo: async () => ({
        ok: true,
        data: { dir: CUSTOM, defaultDir: DEFAULT, isCustom: true, isReachable }
      })
    },
    feedbackRules: { names: async () => ({ ok: true, data: [] }) }
  }
  render(
    <I18nProvider>
      <SettingsView />
    </I18nProvider>
  )
  const strings = locale === 'de' ? de : en
  fireEvent.click(await screen.findByRole('button', { name: strings['settings.nav.data'] }))
  return strings
}

describe('Settings backup folder warning (#506)', () => {
  it.each(['de', 'en'] as const)(
    'names the default folder the daily backup falls back to (%s)',
    async (locale) => {
      await openData(locale, false)
      expect(await screen.findByText(new RegExp(DEFAULT.replace(/\\/g, '\\\\')))).toBeTruthy()
    }
  )

  it('shows no warning while the custom folder is reachable', async () => {
    await openData('en', true)
    await screen.findByText(CUSTOM)
    expect(screen.queryByText(new RegExp(DEFAULT.replace(/\\/g, '\\\\')))).toBeNull()
  })
})
