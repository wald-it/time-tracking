import type Database from 'better-sqlite3'
import { todayGaps, unexplainedSinceMs, type GapEntry } from '../shared/gaps'
import { parseWorkingHours } from '../shared/workingHours'
import { readTodayEntries } from './dashboardTotals'
import type { MiniState } from './miniWindow'

interface UnexplainedData {
  entries: GapEntry[]
  workingHours: string | undefined
}

/** The same entries and setting as Today; no separate entry query. */
export function readUnexplainedData(db: Database.Database): UnexplainedData {
  const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('working_hours') as
    | { value: string }
    | undefined
  return {
    entries: readTodayEntries(db),
    workingHours: setting?.value
  }
}

interface UnexplainedDeps {
  read: () => UnexplainedData
  now: () => Date
  isRunning: () => boolean
  lastState: () => MiniState
  pushMiniState: (state: MiniState) => void
  updateTooltip: () => void
}

/** Main owns this clock, including when every renderer is idle or hidden. */
export function createUnexplainedRefresh(deps: UnexplainedDeps): {
  refresh: (timerState?: Omit<MiniState, 'unexplainedSince'>) => boolean
  start: () => void
  stop: () => void
} {
  let interval: ReturnType<typeof setInterval> | undefined

  // Returns whether the tooltip was updated. A tray:update can then update
  // its ordinary total/label without sending the same tooltip twice.
  function refresh(timerState?: Omit<MiniState, 'unexplainedSince'>): boolean {
    let unexplainedSince: string | null = null
    try {
      const { entries, workingHours } = deps.read()
      const now = deps.now()
      const hours = parseWorkingHours(workingHours)
      const since = unexplainedSinceMs(todayGaps(entries, now, hours), now, deps.isRunning(), hours)
      unexplainedSince = since === null ? null : new Date(since).toISOString()
    } catch {
      // The DB may not be open yet, or its handle may be closed during restore.
    }

    const lastState = deps.lastState()
    const next = { ...lastState, ...timerState, unexplainedSince }
    const changed = unexplainedSince !== lastState.unexplainedSince
    if (
      changed ||
      next.running !== lastState.running ||
      next.label !== lastState.label ||
      next.startedAt !== lastState.startedAt
    ) {
      deps.pushMiniState(next)
    }
    if (changed) deps.updateTooltip()
    return changed
  }

  return {
    refresh,
    start: () => {
      if (interval !== undefined) return
      refresh()
      interval = setInterval(refresh, 60_000)
      interval.unref()
    },
    stop: () => {
      clearInterval(interval)
      interval = undefined
    }
  }
}
