/**
 * Links that leave the app (release 1.22, owner decision: protocol
 * allowlist for openExternal). Only web links reach the system browser, and
 * an app window never navigates away from the app.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

import { shell } from 'electron'
import { guardWindowLinks, isExternalUrlAllowed, isNavigationBlocked } from './externalLinks'

describe('isExternalUrlAllowed', () => {
  it('allows web links', () => {
    expect(isExternalUrlAllowed('https://github.com/wald-it/time-tracking')).toBe(true)
    expect(isExternalUrlAllowed('http://example.com/lib')).toBe(true)
  })

  it('refuses everything else', () => {
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'ms-settings:privacy',
      'ssh://git@github.com/x/y.git',
      'mailto:a@b.c',
      'not a url',
      ''
    ]) {
      expect(isExternalUrlAllowed(url), url).toBe(false)
    }
  })
})

describe('isNavigationBlocked', () => {
  const app = 'file:///C:/Program%20Files/TimeTrack/resources/app.asar/out/renderer/index.html'
  it('lets an in-page anchor through', () => {
    expect(isNavigationBlocked(app, `${app}#top`)).toBe(false)
  })
  it('blocks any other document', () => {
    expect(isNavigationBlocked(app, 'https://example.com/')).toBe(true)
    expect(isNavigationBlocked(app, 'file:///C:/Users/x/evil.html')).toBe(true)
  })
})

describe('guardWindowLinks', () => {
  function fakeWindow(): {
    win: Parameters<typeof guardWindowLinks>[0]
    open: (url: string) => unknown
    navigate: (url: string) => boolean
  } {
    let openHandler: (d: { url: string }) => unknown = () => undefined
    let navHandler: (e: { preventDefault: () => void }, url: string) => void = () => {}
    const webContents = {
      setWindowOpenHandler: (h: typeof openHandler) => {
        openHandler = h
      },
      on: (_ev: string, h: typeof navHandler) => {
        navHandler = h
      },
      getURL: () => 'file:///app/index.html'
    }
    return {
      win: { webContents } as unknown as Parameters<typeof guardWindowLinks>[0],
      open: (url) => openHandler({ url }),
      navigate: (url) => {
        let prevented = false
        navHandler({ preventDefault: () => (prevented = true) }, url)
        return prevented
      }
    }
  }

  it('denies every new window and opens only web links outside', () => {
    const { win, open } = fakeWindow()
    guardWindowLinks(win)
    vi.mocked(shell.openExternal).mockClear()
    expect(open('https://github.com/wald-it/time-tracking')).toEqual({ action: 'deny' })
    expect(open('file:///C:/Windows/System32/calc.exe')).toEqual({ action: 'deny' })
    expect(vi.mocked(shell.openExternal).mock.calls).toEqual([
      ['https://github.com/wald-it/time-tracking']
    ])
  })

  it('blocks navigation away from the app', () => {
    const { win, navigate } = fakeWindow()
    guardWindowLinks(win)
    expect(navigate('https://example.com/')).toBe(true)
    expect(navigate('file:///app/index.html#x')).toBe(false)
  })
})

// Every window the main process opens gets the guards — a window added later
// without them would hand any link to the system again.
describe('every BrowserWindow is guarded', () => {
  it('each file under src/main that creates a BrowserWindow calls guardWindowLinks', async () => {
    const { readdirSync, readFileSync } = await import('fs')
    const { join } = await import('path')
    const dir = join(__dirname)
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => {
        const src = readFileSync(join(dir, f), 'utf8')
        return src.includes('new BrowserWindow(') && !src.includes('guardWindowLinks(')
      })
    expect(offenders).toEqual([])
  })
})
