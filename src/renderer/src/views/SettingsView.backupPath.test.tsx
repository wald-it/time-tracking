import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import SettingsView from './SettingsView'
import { I18nProvider } from '../contexts/I18nContext'
import { useSettingsStore } from '../store/settingsStore'
import type { BackupInfo, Settings } from '../../../shared/types'
import { useToastStore } from '../store/toastStore'
import { de } from '../../../shared/locales/de'
import { en } from '../../../shared/locales/en'

const CUSTOM = 'O:\\OneDrive\\TimeTrack'
const DEFAULT = 'C:\\Users\\me\\AppData\\Roaming\\time-tracking\\backups'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useSettingsStore.setState({ settings: null })
  useToastStore.setState({ toasts: [] })
})

async function openData(
  locale: 'de' | 'en',
  isReachable: boolean,
  backups: BackupInfo[] = []
): Promise<typeof en> {
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
    app: {
      getVersion: async () => ({ ok: true, data: '2.6.1' }),
      relaunch: vi.fn(async () => ({ ok: true }))
    },
    backups: {
      list: async () => ({ ok: true, data: backups }),
      restore: vi.fn(async () => ({ ok: true, data: { safetyBackupPath: '' } })),
      create: vi.fn(async () => ({
        ok: true,
        data: { path: DEFAULT + '/backup.sqlite', usedDefaultFolder: !isReachable }
      })),
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

describe('Settings backup origins (#512)', () => {
  const filename = 'backup-daily-2026-11-05.sqlite'
  const backups = ['custom', 'default'].map((folder) => ({
    filename,
    folder,
    fullPath: '',
    reason: 'daily',
    createdAt: '2026-11-05T12:00:00Z',
    sizeBytes: 1024
  })) as BackupInfo[]

  it.each(['de', 'en'] as const)(
    'offers both same-named entries with a default marker and restores that origin (%s)',
    async (locale) => {
      const strings = await openData(locale, true, backups)
      const select = screen.getByRole('combobox', { name: strings['settings.data.restoreBackup'] })
      const options = within(select).getAllByRole('option') as HTMLOptionElement[]
      expect(options).toHaveLength(2)
      expect(new Set(options.map((o) => o.value)).size).toBe(2)
      expect(options[0].textContent).not.toContain(
        locale === 'de' ? 'im Standardordner' : 'in default folder'
      )
      expect(options[1].textContent).toContain(
        locale === 'de' ? 'im Standardordner' : 'in default folder'
      )
      fireEvent.change(select, { target: { value: options[1].value } })
      fireEvent.click(screen.getByRole('button', { name: strings['settings.data.restoreBtn'] }))
      fireEvent.click(
        await screen.findByRole('button', { name: strings['settings.data.restoreConfirmOk'] })
      )
      await waitFor(() =>
        expect(window.api.backups.restore).toHaveBeenCalledWith(filename, 'default')
      )
      expect(window.api.app.relaunch).toHaveBeenCalled()
    }
  )

  it.each(['de', 'en'] as const)(
    'shows the fallback toast and keeps the success status (%s)',
    async (locale) => {
      const show = vi.spyOn(useToastStore.getState(), 'show').mockReturnValue(1)
      const strings = await openData(locale, false)
      fireEvent.click(screen.getByRole('button', { name: strings['settings.data.createBackup'] }))
      await screen.findByText(strings['settings.data.backupCreated'])
      expect(show).toHaveBeenCalledWith(
        locale === 'de'
          ? 'Backup im Standardordner gespeichert, der eigene Backup-Ordner ist nicht erreichbar.'
          : 'Backup saved in the default folder; your backup folder cannot be reached.'
      )
    }
  )

  it('does not toast when the manual backup uses the configured folder', async () => {
    const show = vi.spyOn(useToastStore.getState(), 'show').mockReturnValue(1)
    const strings = await openData('en', true)
    fireEvent.click(screen.getByRole('button', { name: strings['settings.data.createBackup'] }))
    await screen.findByText(strings['settings.data.backupCreated'])
    expect(show).not.toHaveBeenCalled()
  })
})
