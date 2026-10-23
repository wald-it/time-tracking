import { shell, type BrowserWindow } from 'electron'

/**
 * Which links leave the app for the system browser. Only web links: the app
 * opens its GitHub pages and the repositories in the licence list. Anything
 * else (`file:`, custom schemes that start other programs, `javascript:`) is
 * never handed to the operating system.
 */
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:'])

export function isExternalUrlAllowed(url: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}

/** The URL without its fragment: in-page anchors are not a navigation. */
function withoutHash(url: string): string {
  const i = url.indexOf('#')
  return i === -1 ? url : url.slice(0, i)
}

/**
 * The app is one page; its views change in React state, never by URL. Any
 * navigation to another document is blocked — the window must keep showing
 * the app, whatever a link or a script inside it asks for.
 */
export function isNavigationBlocked(currentUrl: string, targetUrl: string): boolean {
  return withoutHash(targetUrl) !== withoutHash(currentUrl)
}

/**
 * Attach both guards to an app window: new windows never open (web links go
 * to the system browser if allowed), and the window never navigates away.
 */
export function guardWindowLinks(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler((details) => {
    if (isExternalUrlAllowed(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isNavigationBlocked(win.webContents.getURL(), url)) event.preventDefault()
  })
}
