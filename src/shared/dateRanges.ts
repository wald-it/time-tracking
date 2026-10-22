import { endOfMonth, endOfWeek, startOfMonth, startOfWeek, subMonths, subWeeks } from 'date-fns'
import { DEFAULT_WEEK_START, weekStartsOn, type WeekStart } from './weekStart'

/**
 * Quick-filter ranges for the calendar / PDF export hero path (#21).
 *
 * Returned `from` is the inclusive start (00:00:00.000 local) and `to` is
 * the inclusive end (23:59:59.999 local). DST-safe because date-fns
 * normalises to local wall-clock. The week anchor follows the `week_start`
 * setting (#188); callers that do not pass one get the default.
 */
export type QuickRangeKind = 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth'

export interface DateRange {
  from: Date
  to: Date
}

export function getQuickRange(
  kind: QuickRangeKind,
  now: Date,
  week: WeekStart = DEFAULT_WEEK_START
): DateRange {
  const opts = { weekStartsOn: weekStartsOn(week) } as const
  switch (kind) {
    case 'thisWeek':
      return { from: startOfWeek(now, opts), to: endOfWeek(now, opts) }
    case 'lastWeek': {
      const ref = subWeeks(now, 1)
      return { from: startOfWeek(ref, opts), to: endOfWeek(ref, opts) }
    }
    case 'thisMonth':
      return { from: startOfMonth(now), to: endOfMonth(now) }
    case 'lastMonth': {
      const ref = subMonths(now, 1)
      return { from: startOfMonth(ref), to: endOfMonth(ref) }
    }
  }
}

/**
 * `YYYY-MM-DD` for a Date's **local** calendar day.
 *
 * Deliberately not `toISOString().slice(0, 10)`, which converts to UTC first
 * and therefore reports the previous day for any local time before the UTC
 * offset (e.g. 00:30 in CEST). Used both for calendar grid keys and to hand a
 * quick range to the export modal, which expects local day boundaries.
 */
export function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export const QUICK_RANGE_LABELS: Record<QuickRangeKind, string> = {
  thisWeek: 'Diese Woche',
  lastWeek: 'Letzte Woche',
  thisMonth: 'Dieser Monat',
  lastMonth: 'Letzter Monat'
}

/**
 * Local calendar boundaries as UTC instants, for comparing against the stored
 * `started_at` (ISO, UTC, `…Z`). A day or month means the user's local one:
 * an entry started at 00:30 on the 1st belongs to that month, one at 23:30 on
 * the last day too — cutting at 00:00Z instead moves both into the neighbour
 * month for anyone east or west of UTC. Built with `new Date(y, m - 1, d)`,
 * so a day with a clock change keeps its real length (23 or 25 h).
 *
 * Every range is half-open: `started_at >= start AND started_at < end`.
 */
export interface InstantRange {
  start: string
  end: string
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function parseDay(dayIso: string): [number, number, number] {
  const m = DAY_RE.exec(dayIso)
  if (!m) throw new Error(`Ungültiges Datum: ${dayIso}`)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const probe = new Date(y, mo - 1, d)
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) {
    throw new Error(`Ungültiges Datum: ${dayIso}`)
  }
  return [y, mo, d]
}

/** Local days `fromDay` to `toDay`, both inclusive (`YYYY-MM-DD`). */
export function localDayRange(fromDay: string, toDay: string): InstantRange {
  const [fy, fm, fd] = parseDay(fromDay)
  const [ty, tm, td] = parseDay(toDay)
  return {
    start: new Date(fy, fm - 1, fd).toISOString(),
    end: new Date(ty, tm - 1, td + 1).toISOString()
  }
}

/** The local calendar month `month` (1–12) of `year`. */
export function localMonthRange(year: number, month: number): InstantRange {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Ungültiger Monat: ${year}-${month}`)
  }
  return {
    start: new Date(year, month - 1, 1).toISOString(),
    end: new Date(year, month, 1).toISOString()
  }
}
