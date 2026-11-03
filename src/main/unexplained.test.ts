import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { formatTimeHHMM } from '../shared/date'
import type { GapEntry } from '../shared/gaps'
import { trayTooltip } from './mainI18n'
import type { MiniState } from './miniWindow'
import { createUnexplainedRefresh } from './unexplained'

const local = (hour: number, minute = 0, day = 2): Date => new Date(2026, 10, day, hour, minute)
const entry = (start: number, end: number): GapEntry => ({
  started_at: local(start).toISOString(),
  stopped_at: local(end).toISOString()
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

interface TestData {
  entries: GapEntry[]
  workingHours: string | undefined
}

function setup(): {
  refresh: ReturnType<typeof createUnexplainedRefresh>
  read: Mock<() => TestData>
  data: TestData
  pushMiniState: Mock<(next: MiniState) => void>
  tooltip: Mock
  state: () => MiniState
} {
  let state: MiniState = {
    running: false,
    label: 'Acme',
    startedAt: local(9).toISOString(),
    unexplainedSince: null
  }
  const data = { entries: [entry(9, 13)], workingHours: undefined as string | undefined }
  const read = vi.fn(() => data)
  const pushMiniState = vi.fn((next: MiniState) => {
    state = next
  })
  const tooltip = vi.fn()
  const refresh = createUnexplainedRefresh({
    read,
    now: () => new Date(),
    isRunning: () => state.running,
    lastState: () => state,
    pushMiniState,
    updateTooltip: () =>
      tooltip(
        trayTooltip(
          'de',
          state.running,
          state.label,
          '01:30',
          state.unexplainedSince ? formatTimeHHMM(state.unexplainedSince) : null
        )
      )
  })
  return { refresh, read, data, pushMiniState, tooltip, state: () => state }
}

describe('main unexplained refresh', () => {
  it('refreshes at startup and clears the tooltip at window end without tray:update', () => {
    vi.setSystemTime(local(17, 59))
    const test = setup()
    test.refresh.start()
    expect(test.tooltip).toHaveBeenLastCalledWith(
      'TimeTrack — Bereit · ungeklärt seit 13:00 · Heute 01:30'
    )
    vi.advanceTimersByTime(60_000)
    expect(test.tooltip).toHaveBeenLastCalledWith('TimeTrack — Heute 01:30')
    expect(test.pushMiniState).toHaveBeenLastCalledWith({
      running: false,
      label: 'Acme',
      startedAt: local(9).toISOString(),
      unexplainedSince: null
    })
    test.refresh.stop()
  })

  it('does not push unchanged values, and stops its interval', () => {
    vi.setSystemTime(local(14))
    const test = setup()
    test.refresh.start()
    test.refresh.start()
    expect(vi.getTimerCount()).toBe(1)
    test.tooltip.mockClear()
    test.pushMiniState.mockClear()
    test.refresh.refresh()
    vi.advanceTimersByTime(120_000)
    expect(test.tooltip).not.toHaveBeenCalled()
    expect(test.pushMiniState).not.toHaveBeenCalled()
    test.refresh.stop()
    const calls = test.read.mock.calls.length
    vi.advanceTimersByTime(60_000)
    expect(test.read).toHaveBeenCalledTimes(calls)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows the gap after five minutes and preserves every other mini field', () => {
    vi.setSystemTime(local(13, 4))
    const test = setup()
    const before = test.state()
    test.refresh.start()
    expect(test.pushMiniState).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(test.pushMiniState).toHaveBeenCalledExactlyOnceWith({
      ...before,
      unexplainedSince: local(13).toISOString()
    })
    test.refresh.stop()
  })

  it('re-reads backfills and working hours on the interval', () => {
    vi.setSystemTime(local(14))
    const test = setup()
    test.refresh.start()
    test.data.entries.push(entry(13, 15))
    vi.advanceTimersByTime(60_000)
    expect(test.state().unexplainedSince).toBeNull()
    test.data.entries = [entry(9, 13)]
    vi.advanceTimersByTime(60_000)
    expect(test.state().unexplainedSince).toBe(local(13).toISOString())
    test.data.workingHours = JSON.stringify({ start: '08:00', end: '14:00', days: [1] })
    vi.advanceTimersByTime(60_000)
    expect(test.state().unexplainedSince).toBeNull()
    test.refresh.stop()
  })

  it('re-evaluates the local day across midnight', () => {
    vi.setSystemTime(local(23, 58))
    const test = setup()
    test.data.workingHours = JSON.stringify({ start: '08:00', end: '23:59', days: [1, 2] })
    test.refresh.start()
    expect(test.state().unexplainedSince).toBe(local(13).toISOString())
    vi.advanceTimersByTime(120_000)
    expect(test.state().unexplainedSince).toBeNull()
    vi.setSystemTime(local(10, 0, 3))
    vi.advanceTimersByTime(60_000)
    expect(test.state().unexplainedSince).toBeNull()
    test.refresh.stop()
  })

  it('treats unavailable or closed databases as null and recovers on the next tick', () => {
    vi.setSystemTime(local(14))
    const test = setup()
    test.read.mockImplementation(() => {
      throw new Error('database closed')
    })
    expect(() => test.refresh.start()).not.toThrow()
    expect(test.state().unexplainedSince).toBeNull()
    test.read.mockImplementation(() => test.data)
    vi.advanceTimersByTime(60_000)
    expect(test.state().unexplainedSince).toBe(local(13).toISOString())
    test.read.mockImplementation(() => {
      throw new Error('database closed')
    })
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow()
    expect(test.state().unexplainedSince).toBeNull()
    expect(test.tooltip).toHaveBeenLastCalledWith('TimeTrack — Heute 01:30')
    test.refresh.stop()
  })

  it('preserves a running mini state when clearing a stale unexplained value', () => {
    vi.setSystemTime(local(14))
    const test = setup()
    test.refresh.start()
    test.pushMiniState({ ...test.state(), running: true })
    test.refresh.refresh()
    expect(test.state()).toEqual({
      running: true,
      label: 'Acme',
      startedAt: local(9).toISOString(),
      unexplainedSince: null
    })
    test.refresh.stop()
  })

  it('merges a tray update into mini state even when the unexplained value stays null', () => {
    vi.setSystemTime(local(13, 4))
    const test = setup()
    const timerState = { running: true, label: 'New client', startedAt: local(13, 4).toISOString() }
    test.refresh.refresh(timerState)
    expect(test.state()).toEqual({ ...timerState, unexplainedSince: null })
    expect(test.tooltip).not.toHaveBeenCalled()
  })
})
