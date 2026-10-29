import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { ApprovalWindow } from './mcpApproval'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { registerIpcHandlers, type IpcHooks } from './ipc'
import { startMcpBridge, stopMcpBridge, forgetMcpApproval, getMcpApprovalState } from './mcpBridge'

const test = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  db: undefined as Database.Database | undefined,
  approval: undefined as ApprovalWindow | undefined,
  broadcast: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: never) => test.handlers.set(channel, handler),
    on: vi.fn()
  },
  app: { getPath: () => '', getVersion: () => '2.0' },
  shell: {},
  dialog: {}
}))
vi.mock('./db', () => ({ getDb: () => test.db, getDbPath: () => 'test.sqlite' }))
vi.mock('net', () => ({
  default: { createServer: () => ({ on: vi.fn(), listen: vi.fn(), close: vi.fn() }) }
}))
vi.mock('./mcpApproval', async (original) => {
  const actual = await original<typeof import('./mcpApproval')>()
  return {
    ...actual,
    ApprovalWindow: class extends actual.ApprovalWindow {
      constructor(...args: ConstructorParameters<typeof actual.ApprovalWindow>) {
        super(...args)
        test.approval = this
      }
    }
  }
})

let Sqlite: DatabaseCtor
let settings: Record<string, string>
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
beforeEach(() => {
  vi.useFakeTimers()
  test.db = new Sqlite(':memory:')
  applyMigrations(test.db)
  settings = { mcp_write_enabled: '1', mcp_write_confirm_mode: 'session' }
  startMcpBridge({
    getDb: () => test.db!,
    getSetting: (key) => settings[key],
    broadcast: test.broadcast,
    getMainWindow: () => null,
    refreshTray: vi.fn()
  })
  registerIpcHandlers({ getMcpApprovalState } as IpcHooks)
  test.broadcast.mockClear()
})
afterEach(() => {
  stopMcpBridge()
  test.db?.close()
  vi.useRealTimers()
})

it('broadcasts grant, counted write and reset, and serves the same read-only IPC state', () => {
  test.approval!.grant('session')
  expect(test.broadcast).toHaveBeenLastCalledWith('mcp:approval-changed', {
    state: 'window',
    until: expect.any(Number),
    writesLeft: 20
  })
  expect(test.handlers.get('mcp:approval-state')!()).toEqual({
    ok: true,
    data: { state: 'window', until: expect.any(Number), writesLeft: 20 }
  })
  test.approval!.covers('start_timer', 'session')
  expect(test.broadcast).toHaveBeenLastCalledWith(
    'mcp:approval-changed',
    expect.objectContaining({ writesLeft: 19 })
  )
  forgetMcpApproval()
  expect(test.broadcast).toHaveBeenLastCalledWith('mcp:approval-changed', { state: 'off' })
  expect(test.broadcast).toHaveBeenCalledTimes(3)
})

it('broadcasts expiry, mode and access changes even while the bridge stays open', () => {
  test.approval!.grant('session')
  test.broadcast.mockClear()
  vi.advanceTimersByTime(1800000)
  expect(test.broadcast).toHaveBeenCalledExactlyOnceWith('mcp:approval-changed', { state: 'off' })
  settings.mcp_write_confirm_mode = 'silent'
  forgetMcpApproval()
  expect(test.broadcast).toHaveBeenLastCalledWith('mcp:approval-changed', { state: 'silent' })
  settings.mcp_write_enabled = '0'
  forgetMcpApproval()
  expect(test.broadcast).toHaveBeenLastCalledWith('mcp:approval-changed', { state: 'off' })
  settings.mcp_write_enabled = '1'
  forgetMcpApproval()
  expect(test.broadcast).toHaveBeenLastCalledWith('mcp:approval-changed', { state: 'silent' })
})
