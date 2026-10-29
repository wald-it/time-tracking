/**
 * #272 — the smoke test's check of the renderer sandbox, run by `--smoke-test`
 * in the packaged app (scripts/package-smoke.mjs asserts the report).
 *
 * Opens a hidden window with exactly the web preferences of the app windows
 * (`appWebPreferences`), so it runs the real preload under the real sandbox,
 * and reports:
 * - `api`: typeof window.api — the preload ran sandboxed and exposed the API;
 * - `electron`: typeof window.electron — must stay 'undefined';
 * - `sandboxed`: the renderer process's flag from app.getAppMetrics().
 *
 * It loads a minimal data: page, not the app UI: the preload runs the same
 * way, while the React app would call IPC channels that smoke mode never
 * registers. The one call the preload itself makes before any page code, the
 * synchronous theme read, gets a temporary answer for the probe, so a missing
 * handler cannot block the renderer.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { appWebPreferences } from './appWebPreferences'
import { guardWindowLinks } from './externalLinks'

export interface SandboxProbe {
  api: string
  electron: string
  /** null when the platform does not report it (Linux). */
  sandboxed: boolean | null
}

const PROBE_TIMEOUT_MS = 20_000

export async function probeSandboxedWindow(): Promise<SandboxProbe> {
  const themeRead = (event: Electron.IpcMainEvent): void => {
    event.returnValue = null
  }
  ipcMain.on('settings:getSync', themeRead)
  const win = new BrowserWindow({ show: false, webPreferences: appWebPreferences() })
  try {
    guardWindowLinks(win)
    const load = win.loadURL('data:text/html,<!doctype html><title>smoke</title>')
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('sandbox probe: page did not load')),
        PROBE_TIMEOUT_MS
      )
    })
    try {
      await Promise.race([load, timeout])
      const seen = (await win.webContents.executeJavaScript(
        '({ api: typeof window.api, electron: typeof window.electron })'
      )) as { api: string; electron: string }
      const pid = win.webContents.getOSProcessId()
      const metric = app.getAppMetrics().find((m) => m.pid === pid)
      return { ...seen, sandboxed: metric?.sandboxed ?? null }
    } finally {
      clearTimeout(timer)
    }
  } finally {
    ipcMain.removeListener('settings:getSync', themeRead)
    win.destroy()
  }
}
