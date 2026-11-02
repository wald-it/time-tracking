import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { powerMonitor, type BrowserWindow } from 'electron'
import {
  configureIdleWatcher,
  rearmIdleWatcher,
  setIdleThresholdMinutes,
  startIdleWatcher,
  stopIdleWatcher
} from './idle'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleTime: vi.fn() }) }
})

const events = ['suspend', 'lock-screen', 'resume', 'unlock-screen'] as const
const lockTime = new Date(2026, 5, 10, 18)
const send = vi.fn()
const isDestroyed = vi.fn(() => false)
const win = { isDestroyed, webContents: { send } } as unknown as BrowserWindow

function expectEmission(start: Date, seconds: number): void {
  expect(send).toHaveBeenCalledExactlyOnceWith('timer:idle-detected', {
    idleSince: start.toISOString(),
    idleSeconds: seconds
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(lockTime)
  vi.stubEnv('TIMETRACK_IDLE_PROBE', undefined)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  send.mockClear()
  isDestroyed.mockReturnValue(false)
  vi.mocked(powerMonitor.getSystemIdleTime).mockReset().mockReturnValue(0)
  configureIdleWatcher({ getWindow: () => win })
  setIdleThresholdMinutes(5)
})

afterEach(() => {
  stopIdleWatcher()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('idle watcher power events', () => {
  it('registers exactly four listeners only while active, even when started twice', () => {
    const counts = (): number[] => events.map((event) => powerMonitor.listenerCount(event))
    expect(counts()).toEqual([0, 0, 0, 0])
    expect(vi.getTimerCount()).toBe(0)
    startIdleWatcher()
    const listeners = events.map((event) => powerMonitor.listeners(event)[0])
    startIdleWatcher()
    expect(counts()).toEqual([1, 1, 1, 1])
    expect(vi.getTimerCount()).toBe(1)
    const remove = vi.spyOn(powerMonitor, 'removeListener')
    stopIdleWatcher()
    expect(counts()).toEqual([0, 0, 0, 0])
    expect(vi.getTimerCount()).toBe(0)
    events.forEach((event, i) => expect(remove).toHaveBeenCalledWith(event, listeners[i]))
  })

  it.each([['resume'], ['unlock-screen']] as const)(
    'emits a six-minute lock on %s with the lock time',
    (event) => {
      startIdleWatcher()
      powerMonitor.emit('lock-screen')
      vi.advanceTimersByTime(360_000)
      powerMonitor.emit(event)
      expectEmission(lockTime, 360)
      powerMonitor.emit('resume')
      powerMonitor.emit('unlock-screen')
      expect(send).toHaveBeenCalledTimes(1)
      expect(console.log).not.toHaveBeenCalled()
      expect(process.stdout.write).not.toHaveBeenCalled()
    }
  )

  it('clears a four-minute absence without emitting or retaining it', () => {
    startIdleWatcher()
    powerMonitor.emit('lock-screen')
    vi.advanceTimersByTime(240_000)
    powerMonitor.emit('unlock-screen')
    vi.advanceTimersByTime(120_000)
    powerMonitor.emit('resume')
    expect(send).not.toHaveBeenCalled()
  })

  it('includes the threshold boundary and floors partial seconds', () => {
    startIdleWatcher()
    powerMonitor.emit('suspend')
    vi.setSystemTime(lockTime.getTime() + 300_999)
    powerMonitor.emit('resume')
    expectEmission(lockTime, 300)
  })

  it('keeps the earliest lid-close event and ignores the second return', () => {
    startIdleWatcher()
    powerMonitor.emit('lock-screen')
    vi.advanceTimersByTime(2_000)
    powerMonitor.emit('suspend')
    vi.setSystemTime(lockTime.getTime() + 360_000)
    powerMonitor.emit('resume')
    powerMonitor.emit('unlock-screen')
    expectEmission(lockTime, 360)
  })

  it('deduplicates a poll during lock and permits a new absence after rearm', () => {
    startIdleWatcher()
    powerMonitor.emit('lock-screen')
    vi.mocked(powerMonitor.getSystemIdleTime).mockReturnValue(300)
    vi.setSystemTime(lockTime.getTime() + 270_000)
    vi.advanceTimersByTime(30_000)
    expectEmission(lockTime, 300)
    vi.setSystemTime(lockTime.getTime() + 360_000)
    powerMonitor.emit('unlock-screen')
    expect(send).toHaveBeenCalledTimes(1)
    rearmIdleWatcher()
    send.mockClear()
    vi.mocked(powerMonitor.getSystemIdleTime).mockReturnValue(0)
    const nextLock = new Date()
    powerMonitor.emit('lock-screen')
    vi.advanceTimersByTime(360_000)
    powerMonitor.emit('unlock-screen')
    expectEmission(nextLock, 360)
  })

  it('keeps an ongoing absence pending when rearmed', () => {
    startIdleWatcher()
    powerMonitor.emit('suspend')
    vi.setSystemTime(lockTime.getTime() + 120_000)
    rearmIdleWatcher()
    vi.setSystemTime(lockTime.getTime() + 360_000)
    powerMonitor.emit('resume')
    expectEmission(lockTime, 360)
  })

  it('ignores inactive events and clears an absence when stopped', () => {
    events.forEach((event) => powerMonitor.emit(event))
    powerMonitor.emit('suspend')
    vi.setSystemTime(lockTime.getTime() + 360_000)
    startIdleWatcher()
    powerMonitor.emit('resume')
    expect(send).not.toHaveBeenCalled()
    powerMonitor.emit('lock-screen')
    stopIdleWatcher()
    vi.setSystemTime(lockTime.getTime() + 720_000)
    events.forEach((event) => powerMonitor.emit(event))
    powerMonitor.emit('suspend')
    startIdleWatcher()
    powerMonitor.emit('resume')
    powerMonitor.emit('unlock-screen')
    expect(send).not.toHaveBeenCalled()
  })

  it('reports overnight sleep from local 18:00 to 08:00 as fourteen hours', () => {
    startIdleWatcher()
    powerMonitor.emit('suspend')
    vi.setSystemTime(new Date(2026, 5, 11, 8))
    powerMonitor.emit('resume')
    expectEmission(lockTime, 14 * 60 * 60)
  })

  it.each(['poll', 'resume', 'unlock-screen'] as const)(
    'logs one console line per %s emission only when enabled at start',
    (path) => {
      vi.stubEnv('TIMETRACK_IDLE_PROBE', '1')
      startIdleWatcher()
      vi.stubEnv('TIMETRACK_IDLE_PROBE', undefined)
      if (path === 'poll') {
        vi.mocked(powerMonitor.getSystemIdleTime).mockReturnValue(360)
        vi.advanceTimersByTime(30_000)
      } else {
        powerMonitor.emit('suspend')
        vi.setSystemTime(lockTime.getTime() + 360_000)
        powerMonitor.emit(path)
      }
      expect(process.stdout.write).toHaveBeenCalledExactlyOnceWith(
        `[idle-probe] ${path} ${new Date().toISOString()}\n`,
        expect.any(Function)
      )
      vi.advanceTimersByTime(30_000)
      powerMonitor.emit('resume')
      powerMonitor.emit('unlock-screen')
      expect(send).toHaveBeenCalledTimes(1)
      expect(process.stdout.write).toHaveBeenCalledTimes(1)
      // The global console is redirected to the file logger by index.ts.
      expect(console.log).not.toHaveBeenCalled()
    }
  )

  it('does not log poll emissions when the probe was disabled at start', () => {
    startIdleWatcher()
    vi.stubEnv('TIMETRACK_IDLE_PROBE', '1')
    vi.mocked(powerMonitor.getSystemIdleTime).mockReturnValue(360)
    vi.advanceTimersByTime(30_000)
    expect(send).toHaveBeenCalledTimes(1)
    expect(console.log).not.toHaveBeenCalled()
    expect(process.stdout.write).not.toHaveBeenCalled()
  })

  it.each(['missing', 'destroyed'] as const)(
    'both paths skip a %s window without consuming the episode',
    (state) => {
      configureIdleWatcher({ getWindow: () => (state === 'missing' ? null : win) })
      isDestroyed.mockReturnValue(state === 'destroyed')
      vi.stubEnv('TIMETRACK_IDLE_PROBE', '1')
      startIdleWatcher()
      powerMonitor.emit('lock-screen')
      vi.mocked(powerMonitor.getSystemIdleTime).mockReturnValue(360)
      vi.advanceTimersByTime(360_000)
      powerMonitor.emit('unlock-screen')
      expect(send).not.toHaveBeenCalled()
      expect(console.log).not.toHaveBeenCalled()
      expect(process.stdout.write).not.toHaveBeenCalled()
      configureIdleWatcher({ getWindow: () => win })
      isDestroyed.mockReturnValue(false)
      vi.advanceTimersByTime(30_000)
      expect(send).toHaveBeenCalledTimes(1)
      expect(process.stdout.write).toHaveBeenCalledTimes(1)
      expect(console.log).not.toHaveBeenCalled()
    }
  )
})
