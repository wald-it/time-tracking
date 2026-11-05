import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { powerMonitor } from 'electron'
import { startDailyBackupSchedule } from './dailyBackupSchedule'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { powerMonitor: new EventEmitter() }
})

let stop: (() => void) | undefined
const run = vi.fn<() => Promise<void>>()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 4, 23, 59, 30))
  run.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('daily backup schedule', () => {
  it('arms one timer without running at startup', () => {
    stop = startDailyBackupSchedule(run)
    expect(run).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('runs at local midnight plus one second and re-arms for the next day', async () => {
    stop = startDailyBackupSchedule(run)
    await vi.advanceTimersByTimeAsync(30_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('runs on resume and replaces the stale timer after sleep', async () => {
    stop = startDailyBackupSchedule(run)
    vi.setSystemTime(new Date(2026, 10, 5, 9))
    powerMonitor.emit('resume')
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15 * 60 * 60 * 1000 - 30_000)
    expect(run).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it.each(['timer first', 'resume first'])(
    'runs once at a time and reruns once for triggers during a run: %s',
    async (order) => {
      let finish!: () => void
      run.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
      stop = startDailyBackupSchedule(run)
      if (order === 'timer first') {
        vi.advanceTimersByTime(31_000)
        powerMonitor.emit('resume')
      } else {
        vi.advanceTimersByTime(30_999)
        powerMonitor.emit('resume')
        vi.advanceTimersByTime(1)
      }
      expect(run).toHaveBeenCalledTimes(1)
      finish()
      // Timer first: the resume came during the run and is replayed once after
      // it. Resume first: the resume re-armed the timer for the next midnight,
      // so nothing came during the run.
      const afterRun = order === 'timer first' ? 2 : 1
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(afterRun))
      await vi.advanceTimersByTimeAsync(0)
      expect(run).toHaveBeenCalledTimes(afterRun)
      powerMonitor.emit('resume')
      expect(run).toHaveBeenCalledTimes(afterRun + 1)
    }
  )

  it('does not lose the new day when a run is still busy at midnight (#501 Gegenprobe)', async () => {
    vi.setSystemTime(new Date(2026, 10, 4, 23, 59, 58))
    let finish!: () => void
    run.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
    stop = startDailyBackupSchedule(run)
    powerMonitor.emit('resume') // run for Nov 4 starts and stays busy
    vi.advanceTimersByTime(3_000) // midnight + 1 s passes during that run
    expect(run).toHaveBeenCalledTimes(1)
    finish()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
  })

  it('stops timers and removes only its own resume listener, even during a run', async () => {
    const otherListener = vi.fn()
    powerMonitor.on('resume', otherListener)
    const before = powerMonitor.listenerCount('resume')
    let finish!: () => void
    run.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
    try {
      stop = startDailyBackupSchedule(run)
      expect(powerMonitor.listenerCount('resume')).toBe(before + 1)
      powerMonitor.emit('resume')
      stop()
      stop()
      finish()
      await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60 * 1000)
      powerMonitor.emit('resume')
      expect(run).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      expect(powerMonitor.listenerCount('resume')).toBe(before)
      expect(otherListener).toHaveBeenCalledTimes(2)
    } finally {
      powerMonitor.removeListener('resume', otherListener)
    }
  })

  it.each(['rejects', 'throws'])(
    'logs a runner that %s and still runs next midnight',
    async (kind) => {
      const error = new Error('database closed')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      run.mockImplementationOnce(() => {
        if (kind === 'throws') throw error
        return Promise.reject(error)
      })
      stop = startDailyBackupSchedule(run)
      await vi.advanceTimersByTimeAsync(31_000)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[backup]'), error)
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
      expect(run).toHaveBeenCalledTimes(2)
    }
  )

  it.each([new Date(2026, 2, 29), new Date(2026, 9, 25)])(
    'uses the next local midnight across clock changes starting %s',
    async (start) => {
      vi.setSystemTime(start)
      stop = startDailyBackupSchedule(run)
      const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
      await vi.advanceTimersByTimeAsync(next.getTime() - start.getTime() + 999)
      expect(run).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(run).toHaveBeenCalledTimes(1)
    }
  )
})
