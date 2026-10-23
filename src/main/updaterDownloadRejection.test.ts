/**
 * #309 — a failed update download must not leave an unhandled promise
 * rejection (main.log `unhandledRejection:`) for an error the UI already shows
 * through the updater's `error` event.
 *
 * Two paths start a download (autoDownload): the start-up check and "Check
 * now". In electron-updater 6.8.11, `checkForUpdatesAndNotify` chains
 * `void it.downloadPromise.then(() => notification)` (AppUpdater.js:294): that
 * `.then` makes a new promise nobody handles, so a `.catch` on
 * `downloadPromise` from outside cannot silence it. The mock below reproduces
 * that method 1:1, so the start-up path is tested against the real trap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Handler = (...args: unknown[]) => unknown

const ipcHandlers = vi.hoisted(() => new Map<string, Handler>())
const updaterEvents = vi.hoisted(() => new Map<string, Handler>())
const sent = vi.hoisted(() => [] as Array<{ channel: string; payload: unknown }>)
const notifications = vi.hoisted(() => [] as Array<{ title: string; body: string }>)

interface CheckResult {
  updateInfo: { version: string }
  downloadPromise: Promise<string[]> | null
}

const updater = vi.hoisted(() => {
  const u = {
    logger: null as unknown,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    on: (event: string, fn: Handler) => updaterEvents.set(event, fn),
    checkForUpdates: vi.fn<() => Promise<CheckResult | null>>(),
    // electron-updater 6.8.11, AppUpdater.checkForUpdatesAndNotify (out/AppUpdater.js:286-300).
    checkForUpdatesAndNotify: vi.fn(async (): Promise<CheckResult | null> => {
      const it = await u.checkForUpdates()
      if (!it?.downloadPromise) return it
      void it.downloadPromise.then(() => {
        notifications.push({
          title: 'A new update is ready to install',
          body: `TimeTrack version ${it.updateInfo.version} has been downloaded and will be automatically installed on exit`
        })
      })
      return it
    })
  }
  return u
})

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', name: 'TimeTrack' },
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
  ipcMain: { handle: (channel: string, fn: Handler) => ipcHandlers.set(channel, fn) },
  Notification: class {
    constructor(private readonly content: { title: string; body: string }) {}
    show(): void {
      notifications.push(this.content)
    }
  }
}))
vi.mock('electron-log/main', () => ({
  default: { info: () => undefined, warn: () => undefined, error: () => undefined }
}))
vi.mock('electron-updater', () => ({ default: { autoUpdater: updater } }))

import { UPDATE_CHECK_SETTING_KEY } from '../shared/updateCheck'

let initAutoUpdater: typeof import('./updater').initAutoUpdater

/** A check that finds 9.9.9; its download (autoDownload) succeeds or fails. */
function findsUpdate(download: 'succeeds' | 'fails'): () => Promise<CheckResult> {
  return async () => {
    updaterEvents.get('update-available')!({ version: '9.9.9' })
    const downloadPromise =
      download === 'succeeds'
        ? Promise.resolve(['TimeTrack-9.9.9-setup.exe'])
        : new Promise<string[]>((_, reject) =>
            setTimeout(() => {
              // electron-updater reports the failure as `error`, then rejects.
              const err = new Error('download interrupted')
              updaterEvents.get('error')!(err)
              reject(err)
            }, 0)
          )
    return { updateInfo: { version: '9.9.9' }, downloadPromise }
  }
}

function lastStatus(): unknown {
  return sent.filter((s) => s.channel === 'update:status').at(-1)?.payload
}

/** Long enough for Node to report a rejection nobody handled. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10))
}

async function start(stored: string | undefined): Promise<void> {
  initAutoUpdater({
    isDev: false,
    getSetting: (key) => (key === UPDATE_CHECK_SETTING_KEY ? stored : undefined)
  })
  await settle()
}

const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason)
}

beforeEach(async () => {
  vi.resetModules()
  ;({ initAutoUpdater } = await import('./updater'))
  ipcHandlers.clear()
  updaterEvents.clear()
  sent.length = 0
  notifications.length = 0
  unhandled.length = 0
  updater.checkForUpdates.mockReset()
  updater.checkForUpdatesAndNotify.mockClear()
  process.on('unhandledRejection', onUnhandled)
})

afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
})

describe('a failed update download leaves no unhandled rejection (#309)', () => {
  it('start-up check: the background download fails', async () => {
    updater.checkForUpdates.mockImplementation(findsUpdate('fails'))
    await start(undefined)

    expect(unhandled).toEqual([])
    expect(notifications).toEqual([])
    // The UI still learns about it through the error event.
    expect(lastStatus()).toEqual({ status: 'error', message: 'download interrupted' })
  })

  it('"Check now": the download it starts fails', async () => {
    await start('0') // no start-up check, so only "Check now" downloads
    updater.checkForUpdates.mockImplementation(findsUpdate('fails'))

    expect(await ipcHandlers.get('update:check')!()).toEqual({ ok: true, data: undefined })
    await settle()

    expect(unhandled).toEqual([])
    expect(lastStatus()).toEqual({ status: 'error', message: 'download interrupted' })
  })

  it('start-up check: a finished download still shows the "ready to install" notification', async () => {
    updater.checkForUpdates.mockImplementation(findsUpdate('succeeds'))
    await start(undefined)

    expect(notifications).toEqual([
      {
        title: 'A new update is ready to install',
        body: 'TimeTrack version 9.9.9 has been downloaded and will be automatically installed on exit'
      }
    ])
    expect(unhandled).toEqual([])
  })
})
