import { afterEach, expect, it, vi } from 'vitest'
import { ApprovalWindow, APPROVAL_WINDOW_MS, APPROVAL_MAX_WRITES } from './mcpApproval'

afterEach(() => vi.useRealTimers())

it('maps disabled access, modes and active windows without consuming writes', () => {
  const window = new ApprovalWindow(
    () => 1000,
    () => 1000
  )
  expect(window.getState(true, 'session')).toEqual({ state: 'off' })
  expect(window.getState(true, 'per-write')).toEqual({ state: 'off' })
  expect(window.getState(true, 'silent')).toEqual({ state: 'silent' })
  window.grant('per-write')
  expect(window.getState(false, 'silent')).toEqual({ state: 'off' })
  expect(window.getState(false, 'per-write')).toEqual({ state: 'off' })
  expect(window.getState(true, 'session')).toEqual({ state: 'off' })
  for (let i = 0; i < 2; i++) {
    expect(window.getState(true, 'per-write')).toEqual({
      state: 'window',
      until: 1000 + APPROVAL_WINDOW_MS,
      writesLeft: APPROVAL_MAX_WRITES
    })
  }
  window.reset()
})

it('notifies on grant, each counted write and reset, including budget exhaustion', () => {
  const changed = vi.fn()
  const window = new ApprovalWindow(
    () => 1000,
    () => 1000,
    changed
  )
  window.grant('session')
  expect(changed).toHaveBeenCalledTimes(1)
  expect(window.covers('add_entry', 'session')).toBe(false)
  expect(changed).toHaveBeenCalledTimes(1)
  window.covers('start_timer', 'session')
  expect(changed).toHaveBeenCalledTimes(2)
  expect(window.getState(true, 'session')).toMatchObject({ state: 'window', writesLeft: 19 })
  for (let i = 1; i < APPROVAL_MAX_WRITES; i++) window.covers('stop_running_timer', 'session')
  expect(window.getState(true, 'session')).toEqual({ state: 'off' })
  expect(changed).toHaveBeenCalledTimes(21)
  window.reset()
  expect(changed).toHaveBeenCalledTimes(22)
})

it('pushes expiry without a write and cancels the expiry timer on reset', () => {
  vi.useFakeTimers()
  const changed = vi.fn()
  const window = new ApprovalWindow(Date.now, Date.now, changed)
  window.grant('session')
  changed.mockClear()
  vi.advanceTimersByTime(APPROVAL_WINDOW_MS)
  expect(changed).toHaveBeenCalledTimes(1)
  expect(window.getState(true, 'session')).toEqual({ state: 'off' })
  window.grant('session')
  window.reset()
  changed.mockClear()
  vi.advanceTimersByTime(APPROVAL_WINDOW_MS)
  expect(changed).not.toHaveBeenCalled()
})

it('reports expiry on either clock, even if the other clock is moved backwards', () => {
  let wall = 1000
  let mono = 1000
  const window = new ApprovalWindow(
    () => wall,
    () => mono
  )
  window.grant('session')
  wall += APPROVAL_WINDOW_MS
  expect(window.getState(true, 'session')).toEqual({ state: 'off' })
  wall = 0
  mono += APPROVAL_WINDOW_MS
  expect(window.getState(true, 'session')).toEqual({ state: 'off' })
  window.reset()
})
