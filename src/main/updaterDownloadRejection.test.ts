/**
 * #309 — a failed update download must not leave an unhandled promise
 * rejection (main.log `unhandledRejection:`) for an error the UI already shows
 * through the updater's `error` event.
 *
 * Two paths start a download (autoDownload): the start-up check and "Check
 * now". In electron-updater 6.8.11, `checkForUpdatesAndNotify` chains
 * `void it.downloadPromise.then(() => notification)` (AppUpdater.js:294): that
 * `.then` makes a new promise nobody handles, so a `.catch` on
 * `downloadPromise` from outside cannot silence it. updater.ts therefore no
 * longer calls that method; the mock below reproduces it 1:1 so that going
 * back to it turns the start-up test red again.
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
        // formatDownloadNotification's default, with this.app.name = getName().
        notifications.push({
          title: 'A new update is ready to install',
          body: `time-tracking version ${it.updateInfo.version} has been downloaded and will be automatically installed on exit`
        })
      })
      return it
    })
  }
  return u
})

vi.mock('electron', () => ({
  // As in the packaged app: getName() is package.json's name, not productName.
  app: { getVersion: () => '0.0.0-test', name: 'time-tracking', getName: () => 'time-tracking' },
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
import { localeFromSetting } from '../shared/i18n'

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

/** The settings table as updater.ts reads it, at the moment it reads. */
const settings = new Map<string, string>()

async function start(updateCheck: string | undefined): Promise<void> {
  if (updateCheck !== undefined) settings.set(UPDATE_CHECK_SETTING_KEY, updateCheck)
  initAutoUpdater({
    isDev: false,
    getSetting: (key) => settings.get(key),
    // index.ts passes mainI18n.appLocale; here the same rule over the map,
    // read at the moment the notification fires.
    getLocale: () => localeFromSetting(settings.get('language'))
  })
  await settle()
}

const GERMAN = {
  title: 'Ein neues Update kann installiert werden',
  body: 'TimeTrack 9.9.9 wurde heruntergeladen. Zum Installieren klicke oben im TimeTrack-Fenster auf „Jetzt neu starten“.'
}
const ENGLISH = {
  title: 'A new update is ready to install',
  body: 'TimeTrack 9.9.9 has been downloaded. To install it, click "Restart now" in the banner at the top of the TimeTrack window.'
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
  settings.clear()
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
})

describe('the "update downloaded" notification (#309)', () => {
  it('in the default language, German', async () => {
    updater.checkForUpdates.mockImplementation(findsUpdate('succeeds'))
    await start(undefined)

    expect(notifications).toEqual([GERMAN])
    expect(unhandled).toEqual([])
  })

  it('in English when the app is set to English', async () => {
    settings.set('language', 'en')
    updater.checkForUpdates.mockImplementation(findsUpdate('succeeds'))
    await start(undefined)

    expect(notifications).toEqual([ENGLISH])
  })

  it('still shows, in German, when reading the language throws', async () => {
    updater.checkForUpdates.mockImplementation(findsUpdate('succeeds'))
    initAutoUpdater({
      isDev: false,
      getSetting: (key) => settings.get(key),
      getLocale: () => {
        throw new Error('database is locked')
      }
    })
    await settle()

    expect(notifications).toEqual([GERMAN])
    expect(unhandled).toEqual([])
  })

  it('in the language set when the download finishes, not at start', async () => {
    let finish: (files: string[]) => void = () => undefined
    updater.checkForUpdates.mockImplementation(async () => ({
      updateInfo: { version: '9.9.9' },
      downloadPromise: new Promise<string[]>((resolve) => (finish = resolve))
    }))
    await start(undefined) // German at start
    settings.set('language', 'en')
    finish(['TimeTrack-9.9.9-setup.exe'])
    await settle()

    expect(notifications).toEqual([ENGLISH])
  })

  it.each([undefined, 'en'])(
    'language %s: names TimeTrack, not the package name app.getName() returns',
    async (language) => {
      if (language) settings.set('language', language)
      updater.checkForUpdates.mockImplementation(findsUpdate('succeeds'))
      await start(undefined)

      expect(notifications).toHaveLength(1)
      expect(notifications[0].body).toMatch(/^TimeTrack 9\.9\.9 /)
      expect(notifications[0].body).not.toContain('time-tracking')
      // And it promises no install on quit: autoInstallOnAppQuit is false.
      expect(notifications[0].body).not.toMatch(/on exit|on quit|beim Beenden/)
    }
  )
})
