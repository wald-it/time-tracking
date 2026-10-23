/**
 * Hours today / this week — the two numbers the "Heute" view shows as stat
 * cards, and the same two the Stream Deck dial shows on its ambient face
 * (#186).
 *
 * Electron-free and DB-injected, so both callers read from ONE definition:
 * the `dashboard:summary` IPC handler (app window) and the controller scope of
 * the write bridge (`get_summary`). "The dial shows what the main page shows"
 * is then true by construction instead of by assertion.
 */
import type Database from 'better-sqlite3'
import type { Entry } from '../shared/types'
import { billedMinutes } from '../shared/currency'
import {
  parseWeekStart,
  weekStartModifiers,
  WEEK_START_SETTING_KEY,
  type WeekStart
} from '../shared/weekStart'

type Db = Database.Database

/** Seconds of an entry; a running one counts up to now. */
const SECONDS = `CASE
       WHEN stopped_at IS NULL
         THEN CAST(strftime('%s', 'now') AS INTEGER) - CAST(strftime('%s', started_at) AS INTEGER)
       ELSE CAST(strftime('%s', stopped_at) AS INTEGER) - CAST(strftime('%s', started_at) AS INTEGER)
     END`

/**
 * Start of the week window, per the `week_start` setting (#188). Monday by
 * default — see `src/shared/weekStart.ts` for why, and for why the modifier
 * order is `'-6 days', 'weekday N'` and not the other way round.
 */
function weekStartExpr(db: Db): string {
  return `DATE('now', 'localtime', ${weekStartModifiers(readWeekStart(db))})`
}

/** The configured week start; absent or unreadable ⇒ the default (Monday). */
export function readWeekStart(db: Db): WeekStart {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(WEEK_START_SETTING_KEY) as
    | { value: string }
    | undefined
  return parseWeekStart(row?.value)
}

export interface DayWeekTotals {
  today_seconds: number
  week_seconds: number
}

/**
 * The rounding step (`pdf_round_minutes`). 0 = off.
 *
 * Since the Messinstrument UI the "Heute" page shows the RAW worked time
 * large and the rounded value only as a sub-line ("gerundet … h"); the dial
 * mirrors the raw number. That rounded value follows the invoice rule — each
 * entry rounded up (`readRoundedTotals`, `billedMinutes`) — and travels in
 * `get_summary` as `*_rounded_seconds`. The legacy `*_display_seconds` there
 * round the total in one piece (`roundDuration`) and exist only for older
 * plugin builds.
 */
export function readRoundMinutes(db: Db): number {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'pdf_round_minutes'`).get() as
    | { value: string }
    | undefined
  const n = parseInt(row?.value ?? '0', 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Both totals in one read. A running entry is always included in both windows
 * (`OR stopped_at IS NULL`) even when it was started before midnight — that is
 * what makes the tray, the stat cards and the dial agree while a timer runs.
 */
export function readTotals(db: Db): DayWeekTotals {
  const today = db
    .prepare(
      `SELECT COALESCE(SUM(${SECONDS}), 0) AS seconds
         FROM entries
        WHERE deleted_at IS NULL
          AND (DATE(started_at, 'localtime') = DATE('now', 'localtime')
               OR stopped_at IS NULL)`
    )
    .get() as { seconds: number }

  const week = db
    .prepare(
      `SELECT COALESCE(SUM(${SECONDS}), 0) AS seconds
         FROM entries
        WHERE deleted_at IS NULL
          AND (DATE(started_at, 'localtime') >= ${weekStartExpr(db)}
               OR stopped_at IS NULL)`
    )
    .get() as { seconds: number }

  return {
    today_seconds: Math.max(0, Math.floor(today.seconds ?? 0)),
    week_seconds: Math.max(0, Math.floor(week.seconds ?? 0))
  }
}

/**
 * The week total split by day, in `week_start` order (7 values) — the
 * WeekMeter on "Heute". Same window and same running-entry rule as
 * `readTotals`, so `days[today] === today_seconds` and the slots sum to
 * `week_seconds`: a running entry always sits in today's slot, even when it
 * started before midnight or before the week began.
 */
export function readWeekDaySeconds(db: Db): number[] {
  const ws = weekStartExpr(db)
  const rows = db
    .prepare(
      `SELECT CASE
                WHEN stopped_at IS NULL
                  THEN CAST(julianday(DATE('now', 'localtime')) - julianday(${ws}) AS INTEGER)
                ELSE CAST(julianday(DATE(started_at, 'localtime')) - julianday(${ws}) AS INTEGER)
              END AS idx,
              SUM(${SECONDS}) AS seconds
         FROM entries
        WHERE deleted_at IS NULL
          AND (DATE(started_at, 'localtime') >= ${ws}
               OR stopped_at IS NULL)
        GROUP BY idx`
    )
    .all() as Array<{ idx: number; seconds: number }>

  const days = [0, 0, 0, 0, 0, 0, 0]
  for (const r of rows) {
    if (r.idx >= 0 && r.idx < 7) days[r.idx] = Math.max(0, Math.floor(r.seconds ?? 0))
  }
  return days
}

/**
 * Every entry of today, newest first — the DayScale and the entry table on
 * "Heute" (B5). Same window as `today_seconds`: started today (local) or still
 * running. `recentEntries` (the last five overall) is a different list and
 * keeps its meaning.
 */
export function readTodayEntries(db: Db): Entry[] {
  return db
    .prepare(
      `SELECT * FROM entries
        WHERE deleted_at IS NULL
          AND (DATE(started_at, 'localtime') = DATE('now', 'localtime')
               OR stopped_at IS NULL)
        ORDER BY started_at DESC`
    )
    .all() as Entry[]
}

export interface RoundedTotals {
  today_rounded_seconds: number
  week_rounded_seconds: number
}

/**
 * Today and the week as the invoice bills them: each entry rounded up to the
 * step (`billedMinutes`, shared with the PDF and Heute's "gerundet … h"), so
 * the product has one "rounded" number. Same windows as `readTotals` (a
 * running entry counts up to now). With rounding off these equal the raw
 * totals — the sub-line is hidden then, and nothing is billed differently.
 */
export function readRoundedTotals(db: Db): RoundedTotals {
  const step = readRoundMinutes(db)
  const totals = readTotals(db)
  if (step <= 0) {
    return {
      today_rounded_seconds: totals.today_seconds,
      week_rounded_seconds: totals.week_seconds
    }
  }
  const rows = db
    .prepare(
      `SELECT started_at, stopped_at,
              (DATE(started_at, 'localtime') = DATE('now', 'localtime') OR stopped_at IS NULL)
                AS is_today
         FROM entries
        WHERE deleted_at IS NULL
          AND (DATE(started_at, 'localtime') >= ${weekStartExpr(db)}
               OR stopped_at IS NULL)`
    )
    .all() as Array<{ started_at: string; stopped_at: string | null; is_today: number }>

  const now = Date.now()
  let today = 0
  let week = 0
  for (const r of rows) {
    const end = r.stopped_at ? Date.parse(r.stopped_at) : now
    const secs = billedMinutes(Math.max(0, end - Date.parse(r.started_at)), step) * 60
    week += secs
    if (r.is_today) today += secs
  }
  return { today_rounded_seconds: today, week_rounded_seconds: week }
}

export interface TopClient30d {
  client_id: number
  name: string
  color: string
  seconds: number
  last_project_id: number | null
}

/**
 * The most-used ACTIVE clients of the last 30 days (max. 5, most hours first)
 * — the Schnellstart keys on "Heute" (HANDOFF §3.11). Inactive clients are
 * left out here, before the limit, so an archived client never takes a slot.
 *
 * `last_project_id` is what a key's click starts and what its sub-line shows,
 * so both read this one value:
 * - the project of the client's most recent entry, when that project is
 *   still active;
 * - if that project was archived or paused since, the client's most recently
 *   used project that is still active;
 * - null ("Kein Projekt") when the last entry had no project, or no active
 *   project of the client was ever used.
 */
export function readTopClients30d(db: Db): TopClient30d[] {
  const rows = db
    .prepare(
      `SELECT c.id AS client_id, c.name, c.color,
              COALESCE(SUM(
                CASE
                  WHEN e.stopped_at IS NULL
                    THEN CAST(strftime('%s', 'now') AS INTEGER) - CAST(strftime('%s', e.started_at) AS INTEGER)
                  ELSE CAST(strftime('%s', e.stopped_at) AS INTEGER) - CAST(strftime('%s', e.started_at) AS INTEGER)
                END
              ), 0) AS seconds,
              (SELECT project_id FROM entries
                 WHERE client_id = c.id AND deleted_at IS NULL
                 ORDER BY started_at DESC LIMIT 1) AS raw_last_project_id,
              (SELECT le.project_id FROM entries le
                 JOIN projects p ON p.id = le.project_id
                WHERE le.client_id = c.id AND le.deleted_at IS NULL
                  AND p.client_id = c.id AND p.status = 'active'
                ORDER BY le.started_at DESC LIMIT 1) AS active_last_project_id
         FROM clients c
         LEFT JOIN entries e ON e.client_id = c.id
           AND e.deleted_at IS NULL
           AND DATE(e.started_at, 'localtime')
                 >= DATE('now', 'localtime', '-30 days')
        WHERE c.active = 1
        GROUP BY c.id
       HAVING seconds > 0
        ORDER BY seconds DESC
        LIMIT 5`
    )
    .all() as Array<{
    client_id: number
    name: string
    color: string
    seconds: number
    raw_last_project_id: number | null
    active_last_project_id: number | null
  }>
  return rows.map((r) => ({
    client_id: r.client_id,
    name: r.name,
    color: r.color,
    seconds: Math.max(0, Math.floor(r.seconds ?? 0)),
    // The last entry had no project ⇒ "Kein Projekt" stays the last choice.
    last_project_id: r.raw_last_project_id == null ? null : (r.active_last_project_id ?? null)
  }))
}
