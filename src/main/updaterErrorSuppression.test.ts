/**
 * #284 — the offline tolerance of the start-up check must not outlive it.
 *
 * initAutoUpdater swallows the first `error` event (broadcast `idle`, no red
 * banner) so that an offline app start stays quiet. That suppression belongs
 * to the start-up check alone: once it has succeeded, later errors — a
 * failing "Check now", or a download that fails after a check found an update
 * — must reach the renderer as `error` over `update:status`. The download
 * failure matters most: it is not part of the `update:check` result, so the
 * broadcast is the only way the UI learns about it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Handler = (...args: unknown[]) => unknown

const ipcHandlers = vi.hoisted(() => new Map<string, Handler>())
const updaterEvents = vi.hoisted(() => new Map<string, Handler>())
const sent = vi.hoisted(() => [] as Array<{ channel: string; payload: unknown }>)
const updater = vi.hoisted(() => ({
  logger: null as unknown,
  autoDownload: false,
  autoInstallOnAppQuit: true,
  on: (event: string, fn: Handler) => updaterEvents.set(event, fn),
  checkForUpdates: vi.fn(),
  checkForUpdatesAndNotify: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => sent.push({ channel, payload })
        }
      }
    ]
  },
  ipcMain: { handle: (channel: string, fn: Handler) => ipcHandlers.set(channel, fn) }
}))
vi.mock('electron-log/main', () => ({
  default: { info: () => undefined, warn: () => undefined, error: () => undefined }
}))
vi.mock('electron-updater', () => ({ default: { autoUpdater: updater } }))

import { UPDATE_CHECK_SETTING_KEY } from '../shared/updateCheck'

// updater.ts keeps module-level state, and the suppression flag is exactly
// that state — every test starts from a fresh module.
let initAutoUpdater: typeof import('./updater').initAutoUpdater

/** electron-updater's own order: emit `error`, then reject (AppUpdater.checkForUpdates). */
function failingCheck(message: string): () => Promise<never> {
  return async () => {
    const err = new Error(message)
    updaterEvents.get('error')!(err)
    throw err
  }
}

function emit(event: string, ...args: unknown[]): void {
  updaterEvents.get(event)!(...args)
}

function lastStatus(): unknown {
  return sent.filter((s) => s.channel === 'update:status').at(-1)?.payload
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function start(stored: string | undefined): Promise<void> {
  initAutoUpdater({
    isDev: false,
    getSetting: (key) => (key === UPDATE_CHECK_SETTING_KEY ? stored : undefined)
  })
  await settle()
}

beforeEach(async () => {
  vi.resetModules()
  ;({ initAutoUpdater } = await import('./updater'))
  ipcHandlers.clear()
  updaterEvents.clear()
  sent.length = 0
  updater.checkForUpdates.mockReset()
  updater.checkForUpdatesAndNotify.mockReset()
  // A start-up check that reaches GitHub and finds nothing new.
  updater.checkForUpdatesAndNotify.mockImplementation(async () => {
    emit('update-not-available', { version: '0.0.0-test' })
    return null
  })
})

describe('start-up error suppression is scoped to the start-up check (#284)', () => {
  it('after a successful start-up check, a failing "Check now" is broadcast as an error', async () => {
    await start(undefined)
    updater.checkForUpdates.mockImplementation(failingCheck('net::ERR_INTERNET_DISCONNECTED'))

    const res = await ipcHandlers.get('update:check')!()
    expect(res).toMatchObject({ ok: false })
    expect(lastStatus()).toEqual({ status: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' })
  })

  it('after a successful start-up check, a failed download of a found update is broadcast as an error', async () => {
    await start(undefined)
    updater.checkForUpdates.mockImplementation(async () => {
      emit('update-available', { version: '9.9.9' })
      return { downloadPromise: Promise.resolve([]) }
    })

    const res = await ipcHandlers.get('update:check')!()
    expect(res).toEqual({ ok: true, data: undefined })
    // autoDownload runs on its own; its failure arrives only as an event.
    emit('error', new Error('download interrupted'))
    expect(lastStatus()).toEqual({ status: 'error', message: 'download interrupted' })
  })

  it('switched off: no start-up check, so nothing is suppressed — a failing "Check now" is an error', async () => {
    await start('0')
    expect(updater.checkForUpdatesAndNotify).not.toHaveBeenCalled()
    updater.checkForUpdates.mockImplementation(failingCheck('offline'))

    await ipcHandlers.get('update:check')!()
    expect(lastStatus()).toEqual({ status: 'error', message: 'offline' })
  })

  it('an offline start-up check stays quiet: idle, no error', async () => {
    updater.checkForUpdatesAndNotify.mockImplementation(failingCheck('offline at start'))
    await start(undefined)
    expect(lastStatus()).toEqual({ status: 'idle' })
    expect(sent.some((s) => (s.payload as { status?: string }).status === 'error')).toBe(false)
  })

  it('after an offline start-up check, the next "Check now" error is broadcast', async () => {
    updater.checkForUpdatesAndNotify.mockImplementation(failingCheck('offline at start'))
    await start(undefined)
    updater.checkForUpdates.mockImplementation(failingCheck('still offline'))

    await ipcHandlers.get('update:check')!()
    expect(lastStatus()).toEqual({ status: 'error', message: 'still offline' })
  })
})
