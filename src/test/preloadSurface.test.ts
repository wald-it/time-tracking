/**
 * #272 — the preload hands the renderer the app's own API and nothing else:
 * no generic `ipcRenderer`, no `process.env` (what `window.electron` from
 * `@electron-toolkit/preload` used to expose).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const exposed: string[] = []
let exposedApi: { review: Record<string, unknown> }

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: typeof exposedApi) => {
      exposed.push(name)
      exposedApi = api
    }
  },
  ipcRenderer: {
    send: () => undefined,
    sendSync: () => null,
    invoke: () => Promise.resolve(),
    on: () => undefined,
    removeListener: () => undefined
  }
}))

let hadContextIsolated: boolean
let previousContextIsolated: unknown

beforeEach(() => {
  exposed.length = 0
  hadContextIsolated = 'contextIsolated' in process
  previousContextIsolated = (process as { contextIsolated?: unknown }).contextIsolated
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  vi.stubGlobal('document', { addEventListener: () => undefined })
})

afterEach(() => {
  if (hadContextIsolated) {
    Object.defineProperty(process, 'contextIsolated', {
      value: previousContextIsolated,
      configurable: true
    })
  } else {
    delete (process as { contextIsolated?: unknown }).contextIsolated
  }
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('preload surface', () => {
  it('exposes exactly one global, `api`', async () => {
    await import('../preload/index')
    expect(exposed).toEqual(['api'])
    expect(Object.keys(exposedApi.review).sort()).toEqual([
      'billingPreview',
      'changedSinceRun',
      'exportDayGrid'
    ])
  })
})
