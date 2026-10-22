/**
 * DayScale math (Messinstrument, HANDOFF §3.8) — pure functions, no React.
 *
 * Everything is measured in "clock seconds" of the local day that contains
 * `nowMs` (0 = local midnight, 86 400 = next midnight). Positions are
 * percentages of the visible range, so the component can place bars, ticks,
 * labels and the needle with `position: absolute; left: x%`.
 */

export const DAY_SECONDS = 24 * 3600
export const DEFAULT_START_HOUR = 7
export const DEFAULT_END_HOUR = 20
/** Tick spacing: one tick every 15 minutes. */
export const TICK_STEP_SECONDS = 15 * 60
/** Smallest bar width in %, so a two-minute entry stays visible and clickable. */
export const MIN_BAR_WIDTH_PCT = 0.3

/** Tick lengths in px: hour, half hour, quarter hour. */
export const TICK_LENGTH = { hour: 14, half: 9, quarter: 5 } as const

/** The part of an entry the scale needs. */
export interface ScaleEntry {
  started_at: string
  stopped_at: string | null
}

export interface DayRange {
  startHour: number
  endHour: number
}

export interface Tick {
  sec: number
  left: number
  length: number
  /** After "now": drawn with opacity .35. */
  dim: boolean
}

export interface HourLabel {
  hour: number
  /** Two-digit label, e.g. "07". */
  label: string
  left: number
  /** After "now": `--ink3` instead of `--ink2`. */
  dim: boolean
}

export interface BarGeometry {
  left: number
  width: number
  running: boolean
  /** Clock seconds after clamping to the day. */
  startSec: number
  endSec: number
}

export interface DayScaleLayout {
  range: DayRange
  bars: BarGeometry[]
  ticks: Tick[]
  hours: HourLabel[]
  /** Needle position in % of the range. */
  needle: number
}

/** Local midnight of the day that contains `nowMs`. */
export function dayStartMs(nowMs: number): number {
  const d = new Date(nowMs)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Wall-clock seconds of `ms` within the day of `nowMs`, clamped to
 * [0, 86 400]. A running entry that started yesterday is clamped to the start
 * of today. Wall-clock fields (not ms offsets) keep 08:00 at 08:00 on a DST
 * switch day.
 */
export function clockSeconds(ms: number, nowMs: number): number {
  const start = dayStartMs(nowMs)
  if (ms <= start) return 0
  const next = new Date(start)
  next.setDate(next.getDate() + 1)
  if (ms >= next.getTime()) return DAY_SECONDS
  const d = new Date(ms)
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()
}

export function isRunning(entry: ScaleEntry): boolean {
  return entry.stopped_at === null
}

/** Start/end of an entry in clock seconds of today; a running entry ends at now. */
export function entrySpan(entry: ScaleEntry, nowMs: number): { startSec: number; endSec: number } {
  const startSec = clockSeconds(new Date(entry.started_at).getTime(), nowMs)
  const endMs = entry.stopped_at === null ? nowMs : new Date(entry.stopped_at).getTime()
  const endSec = Math.max(startSec, clockSeconds(endMs, nowMs))
  return { startSec, endSec }
}

/** Seconds of the entry that fall on today (running entries count up to now). */
export function entrySecondsToday(entry: ScaleEntry, nowMs: number): number {
  const { startSec, endSec } = entrySpan(entry, nowMs)
  return endSec - startSec
}

/**
 * Visible range, §3.8: 07–20 by default, extended to whole hours so that
 * every entry and the needle fit: `start = min(07, floor(earliest))`,
 * `end = max(20, ceil(latest or now))`. "Now" also takes part in `earliest`,
 * so a needle before 07:00 is not pinned to the left edge.
 */
export function dayRange(entries: ScaleEntry[], nowMs: number): DayRange {
  const nowSec = clockSeconds(nowMs, nowMs)
  let earliest = nowSec
  let latest = nowSec
  for (const e of entries) {
    const { startSec, endSec } = entrySpan(e, nowMs)
    if (startSec < earliest) earliest = startSec
    if (endSec > latest) latest = endSec
  }
  const startHour = Math.min(DEFAULT_START_HOUR, Math.floor(earliest / 3600))
  const endHour = Math.min(24, Math.max(DEFAULT_END_HOUR, Math.ceil(latest / 3600)))
  return { startHour, endHour }
}

/** Position of a clock second in % of the range, clamped to [0, 100]. */
export function pctOf(sec: number, range: DayRange): number {
  const s0 = range.startHour * 3600
  const span = (range.endHour - range.startHour) * 3600
  const p = ((sec - s0) / span) * 100
  return Math.max(0, Math.min(100, p))
}

export function tickLength(sec: number): number {
  if (sec % 3600 === 0) return TICK_LENGTH.hour
  if (sec % 1800 === 0) return TICK_LENGTH.half
  return TICK_LENGTH.quarter
}

/** Ticks every 15 minutes from range start to range end, both inclusive. */
export function scaleTicks(range: DayRange, nowSec: number): Tick[] {
  const ticks: Tick[] = []
  for (let t = range.startHour * 3600; t <= range.endHour * 3600; t += TICK_STEP_SECONDS) {
    ticks.push({ sec: t, left: pctOf(t, range), length: tickLength(t), dim: t > nowSec })
  }
  return ticks
}

/** One label per whole hour of the range, both ends inclusive. */
export function hourLabels(range: DayRange, nowSec: number): HourLabel[] {
  const labels: HourLabel[] = []
  for (let h = range.startHour; h <= range.endHour; h++) {
    labels.push({
      hour: h,
      label: String(h).padStart(2, '0'),
      left: pctOf(h * 3600, range),
      dim: h * 3600 > nowSec
    })
  }
  return labels
}

export function barGeometry(entry: ScaleEntry, range: DayRange, nowMs: number): BarGeometry {
  const { startSec, endSec } = entrySpan(entry, nowMs)
  const left = pctOf(startSec, range)
  const width = Math.min(100 - left, Math.max(MIN_BAR_WIDTH_PCT, pctOf(endSec, range) - left))
  return { left, width, running: isRunning(entry), startSec, endSec }
}

/** Everything the DayScale component draws, in one pass. Bars keep the input order. */
export function layoutDayScale(entries: ScaleEntry[], nowMs: number): DayScaleLayout {
  const range = dayRange(entries, nowMs)
  const nowSec = clockSeconds(nowMs, nowMs)
  return {
    range,
    bars: entries.map((e) => barGeometry(e, range, nowMs)),
    ticks: scaleTicks(range, nowSec),
    hours: hourLabels(range, nowSec),
    needle: pctOf(nowSec, range)
  }
}

/** "08:10" — local wall clock of a timestamp. */
export function formatClock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "4:52" — hours and minutes of a duration, minutes floored. */
export function formatHm(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
}
