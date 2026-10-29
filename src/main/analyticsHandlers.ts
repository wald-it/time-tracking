import { ipcMain } from 'electron'
import { anyRateConfigured, roundingConfigured } from '../shared/billingProfile'
import { uniformRoundingRule } from '../shared/entryMoney'
import type Database from 'better-sqlite3'
import type { IpcResult, MonthQuery, AnalyticsSummary } from '../shared/types'

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** German short month name for a 1-based month number. */
const DE_MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mär',
  'Apr',
  'Mai',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Okt',
  'Nov',
  'Dez'
]

/** The weekday average covers this many completed days, ending yesterday. */
export const WEEKDAY_SPAN_DAYS = 90

/**
 * B2 switch (HANDOFF §6): while the selected month is the current one, the
 * previous-month figures cover only its first `daysElapsed` days, so a
 * half-finished month is not measured against a complete one. `false` brings
 * back full month against full month.
 */
export const SAME_PERIOD_COMPARISON = true

/**
 * Core analytics computation — extracted so it can be tested without Electron IPC.
 * Returns `IpcResult<AnalyticsSummary>` so callers get the same shape as the IPC handler.
 * `now` decides which month is the current one; injectable for tests.
 */
export function buildAnalyticsSummary(
  db: Database.Database,
  query: MonthQuery,
  now: Date = new Date()
): IpcResult<AnalyticsSummary> {
  try {
    const { year, month } = query
    if (
      !Number.isInteger(year) ||
      year < 2000 ||
      year > 2100 ||
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12
    ) {
      return fail('Ungültige Monatsangabe')
    }

    const result = db.transaction((): AnalyticsSummary => {
      const anchor = `${year}-${pad(month)}-01`
      // End of selected month (inclusive for BETWEEN)
      const anchorEnd = `DATE('${anchor}', '+1 month', '-1 day')`

      // Previous month boundaries
      const prevYear = month === 1 ? year - 1 : year
      const prevMonth = month === 1 ? 12 : month - 1
      const selMonthKey = `${year}-${pad(month)}`
      const prevMonthKey = `${prevYear}-${pad(prevMonth)}`

      // Money comes from the view billing_lines (design section 7): the rule,
      // the profile and the rate valid on the day are applied there, once.

      // Hours are worked time, to the second (owner decision 2026-10-22, HANDOFF
      // §2.2 — supersedes the per-entry rounded hours of v1.21). The rounded
      // figure exists once, for the month, as `hoursRounded`: per entry like the
      // invoice, then summed. Revenue follows the invoice rule (FEE_CENT).
      const ENTRY_SEC = `(CAST(strftime('%s', e.stopped_at) AS INTEGER) - CAST(strftime('%s', e.started_at) AS INTEGER))`
      const BILLED_SEC = `(e.billed_minutes * 60)`
      // Revenue per entry exactly as the invoice bills it (shared/currency.ts).
      const FEE_CENT = 'e.fee_cent'

      // ── 1. Month stats ─────────────────────────────────────────────
      type MonthRow = {
        total_sec: number
        billable_sec: number
        revenue_cent: number
        billed_sec: number
      }

      const monthSourceSql = `
        FROM billing_lines e
        JOIN clients c ON c.id = e.client_id
        LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.stopped_at IS NOT NULL
          AND substr(e.segment_date, 1, 7) = ?
          AND CAST(substr(e.segment_date, 9, 2) AS INTEGER) <= ?`
      const monthSql = `
        SELECT
          COALESCE(SUM(
            ${ENTRY_SEC}
          ), 0) AS total_sec,
          COALESCE(SUM(
            CASE WHEN e.billable = 1 THEN
              ${ENTRY_SEC}
            ELSE 0 END
          ), 0) AS billable_sec,
          COALESCE(SUM(
            CASE WHEN e.billable = 1 THEN ${FEE_CENT} ELSE 0 END
          ), 0) AS revenue_cent,
          COALESCE(SUM(${BILLED_SEC}), 0) AS billed_sec
        ${monthSourceSql}`

      // Days in selected month + days elapsed (for current month ETA)
      const isCurrentMonth = now.getFullYear() === year && now.getMonth() + 1 === month
      const daysInMonth = new Date(year, month, 0).getDate()
      const daysElapsed = isCurrentMonth ? now.getDate() : daysInMonth

      // B2: the current month is compared with the same days of the previous
      // one (1…daysElapsed, clamped to its length); a past month with all of it.
      const prevDaysInMonth = new Date(prevYear, prevMonth, 0).getDate()
      const samePeriod = SAME_PERIOD_COMPARISON && isCurrentMonth
      const prevPeriodDays = samePeriod ? Math.min(daysElapsed, prevDaysInMonth) : prevDaysInMonth

      const mCur = db.prepare(monthSql).get(selMonthKey, 31) as MonthRow
      const mPrev = db.prepare(monthSql).get(prevMonthKey, prevPeriodDays) as MonthRow
      const monthProfiles = db
        .prepare(`SELECT DISTINCT e.interval_min, e.min_unit_min ${monthSourceSql}`)
        .all(selMonthKey, 31) as { interval_min: number; min_unit_min: number }[]

      // A sub-second entry has no whole second of hours but bills a minute.
      const hasData = (mCur.total_sec ?? 0) > 0 || (mCur.revenue_cent ?? 0) > 0

      // hasRateConfigured: any client or project has a rate above 0
      const hasRateConfigured = anyRateConfigured(db)

      const totalSec = mCur.total_sec ?? 0
      const billableSec = mCur.billable_sec ?? 0

      // ── 2. Per-client breakdown ────────────────────────────────────
      type ClientRow = {
        client_id: number
        name: string
        color: string
        h: number
        b: number
        rev: number
      }

      const clientSql = `
        SELECT
          c.id AS client_id,
          c.name,
          c.color,
          COALESCE(SUM(
            ${ENTRY_SEC}
          ), 0) AS h,
          COALESCE(SUM(CASE WHEN e.billable = 1 THEN ${ENTRY_SEC} ELSE 0 END), 0) AS b,
          COALESCE(SUM(
            CASE WHEN e.billable = 1 THEN ${FEE_CENT} ELSE 0 END
          ), 0) AS rev
        FROM billing_lines e
        JOIN clients c ON c.id = e.client_id
        LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.stopped_at IS NOT NULL
          AND substr(e.segment_date, 1, 7) = ?
        GROUP BY c.id
        ORDER BY h DESC`

      const byClient = (db.prepare(clientSql).all(selMonthKey) as ClientRow[]).map((r) => ({
        client_id: r.client_id,
        name: r.name,
        color: r.color,
        h: Math.round(r.h ?? 0),
        b: Math.round(r.b ?? 0),
        rev: Math.round(r.rev ?? 0)
      }))

      // ── 3. 12 weeks trailing to end of selected month ─────────────
      type WeekRow = { week_start: string; b: number; n: number; r: number }

      const weekSql = `
        SELECT
          DATE(e.segment_date, '-' || ((CAST(strftime('%w', e.segment_date) AS INTEGER) + 6) % 7) || ' days') AS week_start,
          COALESCE(SUM(
            CASE WHEN e.billable = 1 THEN
              ${ENTRY_SEC}
            ELSE 0 END
          ), 0) AS b,
          COALESCE(SUM(
            CASE WHEN e.billable = 0 THEN
              ${ENTRY_SEC}
            ELSE 0 END
          ), 0) AS n,
          COALESCE(SUM(
            CASE WHEN e.billable = 1 THEN ${FEE_CENT} ELSE 0 END
          ), 0) AS r
        FROM billing_lines e
        JOIN clients c ON c.id = e.client_id
        LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.stopped_at IS NOT NULL
          AND e.segment_date <= ${anchorEnd}
          AND e.segment_date > DATE(${anchorEnd}, '-84 days')
        GROUP BY week_start
        ORDER BY week_start ASC`

      const weekRows = db.prepare(weekSql).all() as WeekRow[]

      // Map to labeled array; fill gaps for weeks with no entries
      const weekMap = new Map(weekRows.map((r) => [r.week_start, r]))
      // Build a list of 12 Monday dates going backwards from anchor end.
      //
      // Deliberately NOT following the `week_start` setting (#188): these bars
      // are labelled `KW##`, and ISO 8601 defines the calendar week as
      // Monday-based. A Sunday-anchored bucket under a `KW` label would be a
      // wrong number, not a preference.
      const anchorDate = new Date(year, month - 1, daysInMonth)
      // Find the Monday of the anchor-end's week
      const anchorDow = anchorDate.getDay() // 0=Sun..6=Sat
      const daysToMon = anchorDow === 0 ? -6 : 1 - anchorDow
      const anchorMonday = new Date(anchorDate)
      anchorMonday.setDate(anchorDate.getDate() + daysToMon)

      const weeks: AnalyticsSummary['weeks'] = []
      for (let i = 11; i >= 0; i--) {
        const mon = new Date(anchorMonday)
        mon.setDate(anchorMonday.getDate() - i * 7)
        const key = `${mon.getFullYear()}-${pad(mon.getMonth() + 1)}-${pad(mon.getDate())}`
        const weekNum = getIsoWeek(mon)
        const row = weekMap.get(key)
        weeks.push({
          lbl: `KW${pad(weekNum)}`,
          b: Math.round(row?.b ?? 0),
          n: Math.round(row?.n ?? 0),
          r: Math.round(row?.r ?? 0)
        })
      }

      // ── 4. 12 months trailing to end of selected month ────────────
      type MonthTrendRow = { month_key: string; h: number; b: number; n: number; r: number }

      const monthTrendSql = `
        SELECT
          substr(e.segment_date, 1, 7) AS month_key,
          COALESCE(SUM(
            ${ENTRY_SEC}
          ), 0) AS h,
          COALESCE(SUM(CASE WHEN e.billable = 1 THEN ${ENTRY_SEC} ELSE 0 END), 0) AS b,
          COALESCE(SUM(CASE WHEN e.billable = 0 THEN ${ENTRY_SEC} ELSE 0 END), 0) AS n,
          COALESCE(SUM(
            CASE WHEN e.billable = 1 THEN ${FEE_CENT} ELSE 0 END
          ), 0) AS r
        FROM billing_lines e
        JOIN clients c ON c.id = e.client_id
        LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.stopped_at IS NOT NULL
          AND e.segment_date <= ${anchorEnd}
          AND e.segment_date > DATE(${anchorEnd}, '-12 months')
        GROUP BY month_key
        ORDER BY month_key ASC`

      const monthTrendRows = db.prepare(monthTrendSql).all() as MonthTrendRow[]
      const monthTrendMap = new Map(monthTrendRows.map((r) => [r.month_key, r]))

      const months: AnalyticsSummary['months'] = []
      for (let i = 11; i >= 0; i--) {
        let m = month - i
        let y = year
        while (m <= 0) {
          m += 12
          y -= 1
        }
        const key = `${y}-${pad(m)}`
        const row = monthTrendMap.get(key)
        months.push({
          lbl: DE_MONTH_SHORT[m - 1],
          h: Math.round(row?.h ?? 0),
          b: Math.round(row?.b ?? 0),
          n: Math.round(row?.n ?? 0),
          r: Math.round(row?.r ?? 0)
        })
      }

      // ── 5. Weekday average (last 90 completed days, global) ────────
      // Per calendar day (owner decision 2026-10-22): for each weekday, the
      // worked seconds of the last 90 completed days (up to yesterday — today
      // is still running) divided by how often that weekday occurs in the span
      // (12 or 13). Days off count, so the seven values add up to the average
      // week. It used to be AVG over entries — the average entry length.
      type WeekdayRow = { dow: number; sec: number }
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      const spanStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - WEEKDAY_SPAN_DAYS
      )
      const ymd = (d: Date): string =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

      const weekdaySql = `
        SELECT
          CAST(strftime('%w', e.segment_date) AS INTEGER) AS dow,
          COALESCE(SUM(${ENTRY_SEC}), 0) AS sec
        FROM billing_lines e
        WHERE e.stopped_at IS NOT NULL
          AND e.segment_date BETWEEN ? AND ?
        GROUP BY dow`

      const weekdayRows = db.prepare(weekdaySql).all(ymd(spanStart), ymd(yesterday)) as WeekdayRow[]
      const secByDow = new Map(weekdayRows.map((r) => [r.dow, r.sec]))
      // How often each weekday (0 = Sunday … 6) occurs in the span.
      const daysByDow = new Map<number, number>()
      for (let i = 1; i <= WEEKDAY_SPAN_DAYS; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
        daysByDow.set(d.getDay(), (daysByDow.get(d.getDay()) ?? 0) + 1)
      }
      const dowMap = new Map(
        [...secByDow].map(([dow, sec]) => [dow, sec / (daysByDow.get(dow) ?? 1)])
      )

      // Map SQLite %w (0=Sun,1=Mon…6=Sat) to Mon-Sun order
      const DOW_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
      const DOW_SQLITE = [1, 2, 3, 4, 5, 6, 0]
      const weekday: AnalyticsSummary['weekday'] = DOW_LABELS.map((d, i) => ({
        d,
        h: Math.round(dowMap.get(DOW_SQLITE[i]) ?? 0)
      }))

      return {
        month: {
          hours: Math.round(totalSec),
          hoursRounded: roundingConfigured(db) ? Math.round(mCur.billed_sec ?? 0) : null,
          roundingRule: uniformRoundingRule(monthProfiles),
          hoursPrev: Math.round(mPrev.total_sec ?? 0),
          revenue: Math.round(mCur.revenue_cent ?? 0),
          revenuePrev: Math.round(mPrev.revenue_cent ?? 0),
          billable: totalSec > 0 ? billableSec / totalSec : 0,
          billablePrev:
            (mPrev.total_sec ?? 0) > 0 ? (mPrev.billable_sec ?? 0) / (mPrev.total_sec ?? 0) : 0,
          daysElapsed,
          daysInMonth,
          comparison: samePeriod ? 'samePeriod' : 'fullMonth',
          prevPeriodDays,
          hasData,
          hasRateConfigured
        },
        weeks,
        months,
        byClient,
        weekday
      }
    })

    return ok(result())
  } catch (e) {
    return fail(e)
  }
}

export function registerAnalyticsHandlers(db: Database.Database): void {
  ipcMain.handle('analytics:summary', (_e, query: MonthQuery): IpcResult<AnalyticsSummary> => {
    return buildAnalyticsSummary(db, query)
  })
}

/** Compute ISO 8601 week number (week starts Monday). */
function getIsoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}
