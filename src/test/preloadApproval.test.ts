import { afterEach, expect, it, vi } from 'vitest'
import type { IpcResult, McpApprovalState } from '../shared/types'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue({ ok: true, data: { state: 'silent' } }),
  on: vi.fn(),
  removeListener: vi.fn(),
  expose: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener }
}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('exposes only a read and a removable approval subscription on fixed channels', async () => {
  vi.stubGlobal('document', { addEventListener: vi.fn() })
  const previous = Object.getOwnPropertyDescriptor(process, 'contextIsolated')
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  try {
    await import('../preload')
    const api = mocks.expose.mock.calls.find(([name]) => name === 'api')![1] as {
      mcpApproval: {
        get(): Promise<IpcResult<McpApprovalState>>
        onChanged(callback: (state: McpApprovalState) => void): () => void
      }
    }
    expect(Object.keys(api.mcpApproval).sort()).toEqual(['get', 'onChanged'])
    expect(await api.mcpApproval.get()).toEqual({ ok: true, data: { state: 'silent' } })
    expect(mocks.invoke).toHaveBeenCalledWith('mcp:approval-state')
    const callback = vi.fn()
    const remove = api.mcpApproval.onChanged(callback)
    const [channel, handler] = mocks.on.mock.calls[0]
    expect(channel).toBe('mcp:approval-changed')
    handler({ sender: 'not exposed' }, { state: 'silent' })
    expect(callback).toHaveBeenCalledExactlyOnceWith({ state: 'silent' })
    remove()
    expect(mocks.removeListener).toHaveBeenCalledWith(channel, handler)
  } finally {
    if (previous) Object.defineProperty(process, 'contextIsolated', previous)
    else delete (process as { contextIsolated?: boolean }).contextIsolated
  }
})
