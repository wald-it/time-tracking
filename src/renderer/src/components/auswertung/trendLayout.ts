/**
 * Pure geometry for the Verlauf chart (HANDOFF §3.15, B3): two bands that
 * share the x-axis, hours stacked on top and revenue below, each with its own
 * axis. No React here, so the axis and position maths can be tested on its own.
 */

/** Band heights in px (reference.html: `grid-template-rows: 200px 36px 100px 40px`). */
export const HOURS_BAND_PX = 200
export const REVENUE_BAND_PX = 100
/** Gap between the bands and the x-label row. */
export const BAND_GAP_PX = 36
export const LABEL_ROW_PX = 40
/**
 * The top tick sits at 92 % of the band height (184 of 200 px, 92 of 100 px),
 * so its label does not touch the band above.
 */
export const PLOT_FRACTION = 0.92
/** Gap between the billable and the non-billable segment of a column. */
export const STACK_GAP_PX = 2

/**
 * Axis steps per mode. Months follow the mockup (40 h up to at least 160 h,
 * 10 T€ up to at least 20 T€). A week holds about a quarter of that, so the
 * week axes are scaled down; with the month axes its columns came out flat.
 */
export const AXES = {
  month: { hoursStep: 40, hoursMinTop: 160, revenueStepK: 10, revenueMinTopK: 20 },
  week: { hoursStep: 10, hoursMinTop: 40, revenueStepK: 2, revenueMinTopK: 4 }
} as const
export const HOURS_STEP = AXES.month.hoursStep
export const HOURS_MIN_TOP = AXES.month.hoursMinTop
export const REVENUE_STEP_K = AXES.month.revenueStepK
export const REVENUE_MIN_TOP_K = AXES.month.revenueMinTopK

export interface Axis {
  /** Value at the top tick, in axis units (h or T€). */
  top: number
  /** Tick values from 0 to `top`, in axis units. */
  ticks: number[]
}

function axis(maxValue: number, step: number, minTop: number): Axis {
  const safe = Number.isFinite(maxValue) && maxValue > 0 ? maxValue : 0
  const top = Math.max(minTop, Math.ceil(safe / step) * step)
  const ticks: number[] = []
  for (let v = 0; v <= top; v += step) ticks.push(v)
  return { top, ticks }
}

/** Hours axis for the largest column, given in seconds. */
export function hoursAxis(maxSeconds: number, mode: 'week' | 'month' = 'month'): Axis {
  return axis(maxSeconds / 3600, AXES[mode].hoursStep, AXES[mode].hoursMinTop)
}

/** Revenue axis (T€) for the largest period, given in cents. */
export function revenueAxis(maxCents: number, mode: 'week' | 'month' = 'month'): Axis {
  return axis(maxCents / 100_000, AXES[mode].revenueStepK, AXES[mode].revenueMinTopK)
}

/** Height in px of `value` on an axis whose top tick is `top`, in a band of `bandPx`. */
export function valuePx(value: number, top: number, bandPx: number): number {
  if (!Number.isFinite(value) || value <= 0 || top <= 0) return 0
  return (value / top) * bandPx * PLOT_FRACTION
}

/** Bottom offset in px of an axis tick (also the gridline position). */
export function tickPx(tick: number, top: number, bandPx: number): number {
  return valuePx(tick, top, bandPx)
}

/**
 * Segment heights of one stacked column. The 2 px gap comes out of the
 * non-billable segment, so the column's total height stays true to the axis.
 * Without a billable segment there is no gap to leave.
 */
export function stackPx(
  billableSec: number,
  nonBillableSec: number,
  top: Axis['top']
): { billable: number; nonBillable: number } {
  const billable = valuePx(billableSec / 3600, top, HOURS_BAND_PX)
  const rawNon = valuePx(nonBillableSec / 3600, top, HOURS_BAND_PX)
  const nonBillable = billable > 0 ? Math.max(0, rawNon - STACK_GAP_PX) : rawNon
  return { billable, nonBillable }
}

/** Bottom offset in px of a revenue dot. */
export function revenuePx(cents: number, top: Axis['top']): number {
  return valuePx(cents / 100_000, top, REVENUE_BAND_PX)
}

/**
 * Polyline points for the revenue line in a `0 0 (n·10) 100` viewBox that is
 * stretched over the band: x at each column centre, y in band px from the top.
 */
export function revenuePoints(cents: number[], top: Axis['top']): string {
  return cents
    .map(
      (c, i) => `${((i + 0.5) * 10).toFixed(1)},${(REVENUE_BAND_PX - revenuePx(c, top)).toFixed(1)}`
    )
    .join(' ')
}

export interface YearMonth {
  year: number
  /** 1–12 */
  month: number
}

export interface Period {
  /** Year of the period (for weeks: the ISO week-year). */
  year: number
  /** 1–12 for months; the ISO week number for weeks. */
  index: number
  /** Show the year under the x label (first column, January / KW01). */
  showYear: boolean
}

/** The 12 months trailing to `anchor`, oldest first — the order `months[]` has. */
export function monthPeriods(anchor: YearMonth, count = 12): Period[] {
  const out: Period[] = []
  for (let i = count - 1; i >= 0; i--) {
    let m = anchor.month - i
    let y = anchor.year
    while (m <= 0) {
      m += 12
      y -= 1
    }
    out.push({ year: y, index: m, showYear: out.length === 0 || m === 1 })
  }
  return out
}

/** Local midnight of the Monday of the week that holds the anchor month's last day. */
function anchorMonday(anchor: YearMonth): Date {
  const last = new Date(anchor.year, anchor.month, 0)
  const dow = last.getDay() // 0 = Sunday
  const toMonday = dow === 0 ? -6 : 1 - dow
  return new Date(last.getFullYear(), last.getMonth(), last.getDate() + toMonday)
}

/** ISO 8601 week number and week-year of a local date. */
export function isoWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return { year: d.getUTCFullYear(), week }
}

/**
 * The Mondays of the 12 ISO weeks trailing to the end of the anchor month,
 * oldest first — the same buckets `analyticsHandlers` builds `weeks[]` from.
 */
export function weekMondays(anchor: YearMonth, count = 12): Date[] {
  const last = anchorMonday(anchor)
  const out: Date[] = []
  for (let i = count - 1; i >= 0; i--) {
    out.push(new Date(last.getFullYear(), last.getMonth(), last.getDate() - i * 7))
  }
  return out
}

/** The 12 week periods trailing to `anchor`, oldest first. */
export function weekPeriods(anchor: YearMonth, count = 12): Period[] {
  return weekMondays(anchor, count).map((mon, i) => {
    const { year, week } = isoWeek(mon)
    return { year, index: week, showYear: i === 0 || week === 1 }
  })
}

/**
 * Which column is still running at `nowMs`, or -1. Months: the last column,
 * if the anchor is the current month. Weeks: the column whose Monday–Sunday
 * holds today (in the current month that is not always the last column — the
 * last one can lie wholly in the future).
 */
export function runningIndex(mode: 'week' | 'month', anchor: YearMonth, nowMs: number): number {
  const now = new Date(nowMs)
  if (mode === 'month') {
    const count = 12
    return now.getFullYear() === anchor.year && now.getMonth() + 1 === anchor.month ? count - 1 : -1
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return weekMondays(anchor).findIndex((mon) => {
    const start = mon.getTime()
    const end = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7).getTime()
    return today >= start && today < end
  })
}

/** Roving tabindex: ArrowLeft/ArrowRight/Home/End move within `count` columns. */
export function moveIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, index - 1)
    case 'ArrowRight':
      return Math.min(count - 1, index + 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/** Billable share as whole percent ("89 %"); "–" when nothing was worked. */
export function formatQuota(billableSec: number, totalSec: number): string {
  if (!(totalSec > 0)) return '–'
  return `${Math.round((Math.max(0, billableSec) / totalSec) * 100)} %`
}

/** Revenue in whole euros with a thousands dot: "13.078 €" (cents rounded half-up). */
export function formatEurWhole(cents: number): string {
  const euros = Math.round((Number.isFinite(cents) ? cents : 0) / 100)
  const sign = euros < 0 ? '-' : ''
  const digits = Math.abs(euros)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${sign}${digits} €`
}
