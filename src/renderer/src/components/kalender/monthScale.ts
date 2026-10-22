/**
 * MiniDayScale math for the calendar (Messinstrument, HANDOFF §3.8 / §3.9) —
 * pure functions, no React.
 *
 * The calendar draws one small time-of-day scale per cell. So that the cells
 * compare, the whole month shares ONE range: the §3.8 rule (07–20 by default,
 * widened to whole hours) applied to every entry of the month at ITS OWN
 * time of day, plus "now" when today lies in the displayed month.
 *
 * Clock seconds are measured within the local day an entry STARTED on — the
 * same day the calendar files it under. An entry that runs past midnight ends
 * at 24:00 on its start day's scale.
 */
import {
  clockSeconds,
  DEFAULT_END_HOUR,
  DEFAULT_START_HOUR,
  pctOf,
  type DayRange,
  type ScaleEntry
} from '../heute/dayScaleLayout'

/**
 * Smallest bar width in %. Larger than the Heute scale's (0.3 %), because a
 * calendar cell is ~100 px wide and a 0.3 % bar would vanish (canvas source:
 * `Math.max(0.8, …)`).
 */
export const MINI_MIN_BAR_WIDTH_PCT = 0.8

export interface MiniBar {
  left: number
  width: number
  running: boolean
}

/**
 * Start/end of an entry in clock seconds of the day it started on; a running
 * entry ends at `nowMs`. Both are clamped to [0, 86 400].
 */
export function entryClockSpan(
  entry: ScaleEntry,
  nowMs: number
): { startSec: number; endSec: number } {
  const startMs = new Date(entry.started_at).getTime()
  const endMs = entry.stopped_at === null ? nowMs : new Date(entry.stopped_at).getTime()
  const startSec = clockSeconds(startMs, startMs)
  const endSec = Math.max(startSec, clockSeconds(endMs, startMs))
  return { startSec, endSec }
}

function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
}

/**
 * The one range shared by every cell of the displayed month (`month` is any
 * date inside it): `start = min(07, floor(earliest))`,
 * `end = max(20, ceil(latest))`, capped at 24, over all entries of the month
 * and — only if today lies in that month — the current time.
 */
export function monthRange(entries: ScaleEntry[], month: Date, nowMs: number): DayRange {
  let earliest = Infinity
  let latest = -Infinity
  if (sameMonth(new Date(nowMs), month)) {
    const nowSec = clockSeconds(nowMs, nowMs)
    earliest = nowSec
    latest = nowSec
  }
  for (const e of entries) {
    const { startSec, endSec } = entryClockSpan(e, nowMs)
    if (startSec < earliest) earliest = startSec
    if (endSec > latest) latest = endSec
  }
  const startHour = Number.isFinite(earliest)
    ? Math.min(DEFAULT_START_HOUR, Math.floor(earliest / 3600))
    : DEFAULT_START_HOUR
  const endHour = Number.isFinite(latest)
    ? Math.min(24, Math.max(DEFAULT_END_HOUR, Math.ceil(latest / 3600)))
    : DEFAULT_END_HOUR
  return { startHour, endHour }
}

/** Bar geometry of one entry on the shared month range. */
export function miniBar(entry: ScaleEntry, range: DayRange, nowMs: number): MiniBar {
  const { startSec, endSec } = entryClockSpan(entry, nowMs)
  const left = pctOf(startSec, range)
  const width = Math.min(100 - left, Math.max(MINI_MIN_BAR_WIDTH_PCT, pctOf(endSec, range) - left))
  return { left, width, running: entry.stopped_at === null }
}

/**
 * Tick positions in %: every even hour strictly inside the range. For the
 * default 07–20 range that is exactly 08/10/12/14/16/18 (§3.9).
 */
export function miniTicks(range: DayRange): number[] {
  const ticks: number[] = []
  for (let h = range.startHour + 1; h < range.endHour; h++) {
    if (h % 2 === 0) ticks.push(pctOf(h * 3600, range))
  }
  return ticks
}

/** "07" — a range hour as the footnote prints it. */
export function formatRangeHour(hour: number): string {
  return String(hour).padStart(2, '0')
}
