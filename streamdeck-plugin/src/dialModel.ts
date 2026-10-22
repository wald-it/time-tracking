/**
 * Pure model behind the "Timer dial" encoder action (#186).
 *
 * Everything here is free of the SDK, of `net` and of timers-as-globals, so
 * the whole interaction — which entry the wheel lands on, what a long press
 * targets, when a press counts as short — is testable without a Stream Deck
 * attached. The action module (`actions/timer-dial.ts`) only wires these
 * functions to events.
 */
import type { RunningTimer, TargetClient } from './bridge'

/** One position on the wheel. */
export interface DialTarget {
  /** Stable identity used to re-find the selection after the list changed. */
  key: string
  clientId: number
  projectId: number | null
  clientName: string
  projectName: string | null
  /** Raw client colour from the DB; normalized at render time. */
  color: string
}

export function targetKey(clientId: number, projectId: number | null): string {
  return `${clientId}:${projectId ?? ''}`
}

/**
 * Flattens the bridge's client/project tree into the wheel's list.
 *
 * A client **with** projects contributes one entry per project and does NOT
 * appear on its own — its project-less timer is reachable through the long
 * press instead (see {@link clientOnly}). A client **without** projects
 * contributes itself. Order is the bridge's order (clients alphabetical, each
 * client's projects alphabetical): a list that reorders itself by usage would
 * move under the user's fingers between two rotations.
 */
export function buildTargets(clients: TargetClient[]): DialTarget[] {
  const out: DialTarget[] = []
  for (const c of clients) {
    if (c.projects.length === 0) {
      out.push({
        key: targetKey(c.id, null),
        clientId: c.id,
        projectId: null,
        clientName: c.name,
        projectName: null,
        color: c.color
      })
      continue
    }
    for (const p of c.projects) {
      out.push({
        key: targetKey(c.id, p.id),
        clientId: c.id,
        projectId: p.id,
        clientName: c.name,
        projectName: p.name,
        color: c.color
      })
    }
  }
  return out
}

/**
 * The same client, but without a project — what a long press starts.
 * On an entry that is already project-less this is the identity, so a long
 * press there is simply the short press.
 */
export function clientOnly(target: DialTarget): DialTarget {
  if (target.projectId === null) return target
  return {
    key: targetKey(target.clientId, null),
    clientId: target.clientId,
    projectId: null,
    clientName: target.clientName,
    projectName: null,
    color: target.color
  }
}

/**
 * Re-find the selection by key, not by index: when a project is added or
 * archived somewhere above it, the selected entry stays selected instead of
 * silently sliding onto a neighbour. Unknown key ⇒ 0 (top of the list).
 */
export function indexOfKey(targets: DialTarget[], key: string | undefined): number {
  if (!key) return 0
  const at = targets.findIndex((t) => t.key === key)
  return at >= 0 ? at : 0
}

/** Wrap-around step; `length <= 0` stays at 0. */
export function step(index: number, ticks: number, length: number): number {
  if (length <= 0) return 0
  return (((index + ticks) % length) + length) % length
}

/** Does the running timer point at exactly this target? */
export function isRunning(target: DialTarget, running: RunningTimer | null): boolean {
  return (
    running !== null &&
    running.client_id === target.clientId &&
    (running.project_id ?? null) === target.projectId
  )
}

/**
 * What the stats face puts on screen: the worked (raw) seconds — the same
 * large number the app's Heute page shows since the Messinstrument UI (owner
 * decision 2026-10-22: hours are worked time; the rounded value is only a
 * sub-line there). The dial must keep matching the page: the first version
 * showed 6:24 against 6:30 in the app, back when the page showed the rounded
 * value.
 *
 * The bridge also sends the rounded pair (`*_rounded_seconds`, legacy
 * `*_display_seconds`); this face deliberately ignores it. A garbage value
 * still renders as 0 instead of "NaN:NaN".
 */
export interface SummaryTotals {
  today_seconds: number
  week_seconds: number
  today_display_seconds?: number
  week_display_seconds?: number
}

export function displayTotals(s: SummaryTotals): { today: number; week: number } {
  const safe = (raw: number): number => (Number.isFinite(raw) ? raw : 0)
  return { today: safe(s.today_seconds), week: safe(s.week_seconds) }
}

/** h:mm — the minute is the unit on the faces; the ring carries the seconds. */
export function formatHm(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`
}

/** Seconds a timer started at `startedAt` has been running at `nowMs`. */
export function elapsedSeconds(startedAt: string, nowMs: number): number {
  const t = Date.parse(startedAt)
  if (Number.isNaN(t)) return 0
  return Math.max(0, (nowMs - t) / 1000)
}

/**
 * Short vs. long press on the wheel.
 *
 * The touch strip reports `hold` on `touchTap`, but the wheel does not — for
 * `dialDown`/`dialUp` the distinction has to be measured here. The long action
 * fires when the threshold is reached, not on release: the confirmation
 * appears in the moment you have held long enough, which is the only feedback
 * that tells you the gesture registered.
 *
 * Timer functions are injected so a test can drive the clock.
 */
export interface PressGesture {
  down(): void
  /** @returns true when this was a short press — the caller starts the timer. */
  up(): boolean
  /** Rotating (or leaving) while pressed voids the gesture. */
  cancel(): void
}

export function createPressGesture(
  onLong: () => void,
  thresholdMs = 500,
  clock: {
    setTimeout: (fn: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  } = globalThis as never
): PressGesture {
  let handle: unknown = null
  let consumed = false

  function stop(): void {
    if (handle !== null) {
      clock.clearTimeout(handle)
      handle = null
    }
  }

  return {
    down(): void {
      stop()
      consumed = false
      handle = clock.setTimeout(() => {
        handle = null
        consumed = true
        onLong()
      }, thresholdMs)
    },
    up(): boolean {
      stop()
      const short = !consumed
      consumed = false
      return short
    },
    cancel(): void {
      stop()
      consumed = true
    }
  }
}
