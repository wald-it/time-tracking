import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import type { IpcResult, MonthQuery, AnalyticsSummary } from '../shared/types'
import { feeCentSql } from '../shared/currency'

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: String(error) }
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

/**
 * Core analytics computation — extracted so it can be tested without Electron IPC.
 * Returns `IpcResult<AnalyticsSummary>` so callers get the same shape as the IPC handler.
 */
export function buildAnalyticsSummary(
  db: Database.Database,
  query: MonthQuery
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

      // Read rounding step from settings (same rule as the PDF pipeline)
      const roundSetting = db
        .prepare(`SELECT value FROM settings WHERE key = 'pdf_round_minutes'`)
        .get() as { value: string } | undefined
      const roundStep = parseInt(roundSetting?.value ?? '0', 10) || 0

      // SQL helper: per-entry seconds, optionally rounded up to `roundStep` minutes.
      // Uses SQLite integer arithmetic for ceiling: (n + d - 1) / d * d
      const RAW_SEC = `(CAST(strftime('%s', e.stopped_at) AS INTEGER) - CAST(strftime('%s', e.started_at) AS INTEGER))`
      const ENTRY_SEC =
        roundStep > 0
          ? `(((${RAW_SEC} + 59) / 60 + ${roundStep} - 1) / ${roundStep} * ${roundStep} * 60)`
          : RAW_SEC
      // Revenue per entry exactly as the invoice bills it (shared/currency.ts).
      const FEE_CENT = feeCentSql(roundStep)

      // ── 1. Month stats ─────────────────────────────────────────────
      type MonthRow = {
        total_sec: number
        billable_sec: number
        revenue_cent: number
      }

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
          ), 0) AS revenue_cent
        FROM entries e
        JOIN clients c ON c.id = e.client_id
        LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.deleted_at IS NULL
          AND e.stopped_at IS NOT NULL
          AND strftime('%Y-%m', e.started_at, 'localtime') = ?`

      const mCur = db.prepare(monthSql).get(selMonthKey) as MonthRow
      const mPrev = db.prepare(monthSql).get(prevMonthKey) as MonthRow

      // Days in selected month + days elapsed (for current month ETA)
      const today = new Date()
      const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month
      const daysInMonth = new Date(year, month, 0).getDate()
      const daysElapsed = isCurrentMonth ? today.getDate() : daysInMonth

      const hasData = (mCur.total_sec ?? 0) > 0

      // hasRateConfigured: any client or project has rate_cent > 0
      const rateCheck = db
        .prepare(
          `SELECT 1 FROM clients WHERE rate_cent > 0
           UNION ALL
           SELECT 1 FROM projects WHERE rate_cent IS NOT NULL AND rate_cent > 0
           LIMIT 1`
        )
        .get() as { 1: number } | undefined
      const hasRateConfigured = rateCheck != null

      const totalSec = mCur.total_sec ?? 0
      const billableSec = mCur.billable_sec ?? 0

      // ── 2. Per-client breakdown ────────────────────────────────────
      type ClientRow = {
        client_id: number
        name: string
        color: string
        h: number
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
          COALESCE(SUM(
            CASE WHEN e.billable = 1 THEN ${FEE_CENT} ELSE 0 END
          ), 0) AS rev
        FROM entries e
        JOIN clients c ON c.id = e.client_id
        LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.deleted_at IS NULL
          AND e.stopped_at IS NOT NULL
          AND strftime('%Y-%m', e.started_at, 'localtime') = ?
        GROUP BY c.id
        ORDER BY h DESC`

      const byClient = (db.prepare(clientSql).all(selMonthKey) as ClientRow[]).map((r) => ({
        client_id: r.client_id,
        name: r.name,
        color: r.color,
        h: Math.round(r.h ?? 0),
        rev: Math.round(r.rev ?? 0)
      }))

      // ── 3. 12 weeks trailing to end of selected month ─────────────
      type WeekRow = { week_start: string; b: number; n: number }

      const weekSql = `
        SELECT
          DATE(e.started_at, 'localtime', '-' || ((CAST(strftime('%w', e.started_at, 'localtime') AS INTEGER) + 6) % 7) || ' days') AS week_start,
          COALESCE(SUM(
            CASE WHEN e.billable = 1 THEN
              ${ENTRY_SEC}
            ELSE 0 END
          ), 0) AS b,
          COALESCE(SUM(
            CASE WHEN e.billable = 0 THEN
              ${ENTRY_SEC}
            ELSE 0 END
          ), 0) AS n
        FROM entries e
        WHERE e.deleted_at IS NULL
          AND e.stopped_at IS NOT NULL
          AND DATE(e.started_at, 'localtime') <= ${anchorEnd}
          AND DATE(e.started_at, 'localtime') > DATE(${anchorEnd}, '-84 days')
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
          n: Math.round(row?.n ?? 0)
        })
      }

      // ── 4. 12 months trailing to end of selected month ────────────
      type MonthTrendRow = { month_key: string; h: number; r: number }

      const monthTrendSql = `
        SELECT
          strftime('%Y-%m', e.started_at, 'localtime') AS month_key,
          COALESCE(SUM(
            ${ENTRY_SEC}
          ), 0) AS h,
          COALESCE(SUM(
            CASE WHEN e.billable = 1 THEN ${FEE_CENT} ELSE 0 END
          ), 0) AS r
        FROM entries e
        JOIN clients c ON c.id = e.client_id
        LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.deleted_at IS NULL
          AND e.stopped_at IS NOT NULL
          AND DATE(e.started_at, 'localtime') <= ${anchorEnd}
          AND DATE(e.started_at, 'localtime') > DATE(${anchorEnd}, '-12 months')
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
          r: Math.round(row?.r ?? 0)
        })
      }

      // ── 5. Weekday average (last 90 days global) ───────────────────
      type WeekdayRow = { dow: number; avg_sec: number }

      const weekdaySql = `
        SELECT
          CAST(strftime('%w', e.started_at, 'localtime') AS INTEGER) AS dow,
          AVG(
            ${ENTRY_SEC}
          ) AS avg_sec
        FROM entries e
        WHERE e.deleted_at IS NULL
          AND e.stopped_at IS NOT NULL
          AND DATE(e.started_at, 'localtime') >= DATE('now', 'localtime', '-90 days')
        GROUP BY dow
        ORDER BY dow ASC`

      const weekdayRows = db.prepare(weekdaySql).all() as WeekdayRow[]
      const dowMap = new Map(weekdayRows.map((r) => [r.dow, r.avg_sec]))

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
          hoursPrev: Math.round(mPrev.total_sec ?? 0),
          revenue: Math.round(mCur.revenue_cent ?? 0),
          revenuePrev: Math.round(mPrev.revenue_cent ?? 0),
          billable: totalSec > 0 ? billableSec / totalSec : 0,
          billablePrev:
            (mPrev.total_sec ?? 0) > 0 ? (mPrev.billable_sec ?? 0) / (mPrev.total_sec ?? 0) : 0,
          daysElapsed,
          daysInMonth,
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
