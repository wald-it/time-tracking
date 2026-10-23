/**
 * #273 — the "Check for updates automatically" switch under Settings → About
 * → Updates: it reads `update_check_enabled` (absent = on), writes '0'/'1',
 * and the "Check now" key stays available when it is off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import SettingsView from './SettingsView'
import { I18nProvider } from '../contexts/I18nContext'
import { useSettingsStore } from '../store/settingsStore'
import { de } from '../../../shared/locales/de'
import type { Settings } from '../../../shared/types'

const ok = <T,>(data: T): { ok: true; data: T } => ({ ok: true, data })

function mockApi(stored: Partial<Settings>): {
  set: ReturnType<typeof vi.fn>
  check: ReturnType<typeof vi.fn>
} {
  const set = vi.fn(async () => ok(undefined))
  const check = vi.fn(async () => ok(undefined))
  ;(window as unknown as { api: unknown }).api = {
    settings: { getAll: async () => ok(stored as Settings), set },
    paths: {
      get: async () =>
        ok({
          db: 'db',
          backups: 'backups',
          logs: 'logs',
          logFile: 'main.log',
          mcp: { command: 'c', args: [], env: {}, available: false }
        })
    },
    app: { getVersion: async () => ok('0.0.0-test') },
    backups: {
      list: async () => ok([]),
      getPathInfo: async () => ok({ dir: 'backups', isCustom: false, isReachable: true })
    },
    update: {
      onStatus: () => () => undefined,
      getVersion: async () => ok('0.0.0-test'),
      getStatus: async () => ok({ status: 'idle' }),
      getLastCheck: async () => ok(null),
      check,
      install: async () => ok(undefined)
    }
  }
  return { set, check }
}

async function openUpdates(): Promise<void> {
  render(
    <I18nProvider>
      <SettingsView />
    </I18nProvider>
  )
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: de['settings.nav.about'] }))
  await act(async () => {})
}

function autoCheckSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: de['settings.update.autoCheck'] })
}

afterEach(() => {
  cleanup()
  useSettingsStore.setState({ settings: null })
})

describe('Settings → Updates: automatic check switch (#273)', () => {
  it('is on when the key was never stored, and switching it off writes 0', async () => {
    const { set } = mockApi({})
    await openUpdates()
    expect(autoCheckSwitch().getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      fireEvent.click(autoCheckSwitch())
    })
    expect(set).toHaveBeenCalledWith('update_check_enabled', '0')
    expect(autoCheckSwitch().getAttribute('aria-checked')).toBe('false')
  })

  it('stored off: shows off, and "Check now" still checks', async () => {
    const { set, check } = mockApi({ update_check_enabled: '0' })
    await openUpdates()
    expect(autoCheckSwitch().getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: de['settings.update.checkNow'] }))
    })
    expect(check).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(autoCheckSwitch())
    })
    expect(set).toHaveBeenCalledWith('update_check_enabled', '1')
  })
})
