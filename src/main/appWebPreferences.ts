import { join } from 'path'
import type { WebPreferences } from 'electron'

/** The app's preload, as built by electron-vite next to out/main. */
export function appPreloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

/**
 * #272 — the web preferences of every window that loads the app's own pages
 * (main window, mini widget, and the window the smoke test opens to check
 * them). Sandboxed: the renderer process runs with the OS sandbox, and the
 * preload gets only what a sandboxed preload may use (`electron`'s
 * contextBridge and ipcRenderer). It exposes nothing but `window.api`.
 *
 * One function, so the smoke test checks exactly what the app windows use.
 */
export function appWebPreferences(preload: string = appPreloadPath()): WebPreferences {
  return {
    preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false
  }
}
