/**
 * #273 — the update check at start honours the switch under Settings → About
 * → Updates, and the manual "Check now" works either way.
 *
 * Runs the real initAutoUpdater against a stubbed electron-updater: with the
 * switch off, the start path must not check (no request to GitHub, so nothing
 * to download), while the `update:check` handler still checks. Both call
 * checkForUpdates; the start path no longer uses checkForUpdatesAndNotify,
 * whose own download handler leaves an unhandled rejection (#309).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const updater = vi.hoisted(() => ({
  logger: null as unknown,
  autoDownload: false,
  autoInstallOnAppQuit: true,
  on: vi.fn(),
  checkForUpdates: vi.fn(async () => null),
  checkForUpdatesAndNotify: vi.fn(async () => null),
  downloadUpdate: vi.fn(async () => [])
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))
const logWarn = vi.hoisted(() => vi.fn())
vi.mock('electron-log/main', () => ({
  default: { info: () => undefined, warn: logWarn, error: () => undefined }
}))
vi.mock('electron-updater', () => ({ default: { autoUpdater: updater } }))

import { UPDATE_CHECK_SETTING_KEY } from '../shared/updateCheck'

// updater.ts keeps module-level state (last status, last check, the running
// start-up check), and the app calls initAutoUpdater once per run —
// so every test gets a fresh copy of the module.
let initAutoUpdater: typeof import('./updater').initAutoUpdater

function init(stored: string | undefined, isDev = false): void {
  initAutoUpdater({
    isDev,
    getSetting: (key) => (key === UPDATE_CHECK_SETTING_KEY ? stored : undefined)
  })
}

beforeEach(async () => {
  vi.resetModules()
  ;({ initAutoUpdater } = await import('./updater'))
  handlers.clear()
  logWarn.mockClear()
  updater.checkForUpdates.mockClear()
  updater.checkForUpdatesAndNotify.mockClear()
  updater.downloadUpdate.mockClear()
})

describe('update check at start (#273)', () => {
  it('switched off: no request at start and no download', async () => {
    init('0')
    await Promise.resolve()
    expect(updater.checkForUpdatesAndNotify).not.toHaveBeenCalled()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('switched off: "Check now" still checks', async () => {
    init('0')
    const res = await handlers.get('update:check')!()
    expect(res).toEqual({ ok: true, data: undefined })
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('switched on: checks at start', () => {
    init('1')
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(updater.checkForUpdatesAndNotify).not.toHaveBeenCalled()
  })

  it('never set (existing installations): checks at start', () => {
    init(undefined)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(updater.checkForUpdatesAndNotify).not.toHaveBeenCalled()
  })

  it('a failed settings read does not abort startup, skips the check at start and logs it', () => {
    expect(() =>
      initAutoUpdater({
        isDev: false,
        getSetting: () => {
          throw new Error('database is locked')
        }
      })
    ).not.toThrow()
    expect(updater.checkForUpdatesAndNotify).not.toHaveBeenCalled()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(handlers.has('update:check')).toBe(true)
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining('could not read the update-check setting'),
      expect.any(Error)
    )
  })

  it('dev mode: no check at start even when switched on', () => {
    init('1', true)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.checkForUpdatesAndNotify).not.toHaveBeenCalled()
  })
})
