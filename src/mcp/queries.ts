/**
 * Pure, read-only query layer for the TimeTrack MCP server.
 *
 * These functions take a minimal SQLite handle (structurally compatible with
 * better-sqlite3's `Database`) and return LLM-friendly, privacy-filtered
 * shapes. They contain NO Electron, NO MCP-SDK, and NO I/O beyond the passed
 * DB — which keeps them trivially unit-testable against an in-memory DB seeded
 * with the app's real migrations.
 *
 * SQL here mirrors the app's IPC handlers (src/main/ipc.ts,
 * analyticsHandlers.ts) so the numbers match what the UI shows: soft-deleted
 * rows are excluded, durations use the same running-entry rule, and analytics
 * honour the `pdf_round_minutes` rounding step and the
 * `rate = project.rate ?? client.rate` precedence.
 */
import { deserializeTags } from '../shared/tags'
import { parseWeekStart, weekStartModifiers, WEEK_START_SETTING_KEY } from '../shared/weekStart'
import type { PrivacyConfig } from './privacy'

// ── Minimal driver interface (better-sqlite3 compatible) ───────────────────

export interface SqliteStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}
export interface SqliteDb {
  prepare(sql: string): SqliteStatement
}

// ── Output shapes ──────────────────────────────────────────────────────────

export interface McpClient {
  id: number
  name: string
  color: string
  active: boolean
  vat_id: string | null
  contact_person: string | null
  /** Only present when TIMETRACK_MCP_EXPOSE_RATES is enabled. */
  rate_cent?: number
}

export interface McpProject {
  id: number
  client_id: number | null
  name: string
  color: string
  status: 'active' | 'paused' | 'archived'
  external_project_number: string | null
  start_date: string | null
  end_date: string | null
  budget_minutes: number | null
  used_minutes: number | null
  entry_count: number
  last_used_at: string | null
  /** Only present when TIMETRACK_MCP_EXPOSE_RATES is enabled. */
  rate_cent?: number | null
}

export interface McpEntry {
  id: number
  client_id: number
  project_id: number | null
  description: string
  started_at: string
  stopped_at: string | null
  /** Wall-clock seconds; running entries measured to `now`. */
  duration_seconds: number
  running: boolean
  rounded_min: number | null
  tags: string[]
  reference: string
  billable: boolean
  /** Only present when TIMETRACK_MCP_EXPOSE_PRIVATE_NOTES is enabled. */
  private_note?: string
}

// ── Raw row types (as stored) ───────────────────────────────────────────────

interface ClientRow {
  id: number
  name: string
  color: string
  active: number
  rate_cent: number
  vat_id: string | null
  contact_person: string | null
}

interface ProjectRow {
  id: number
  client_id: number | null
  name: string
  color: string
  rate_cent: number | null
  status: 'active' | 'paused' | 'archived'
  external_project_number: string | null
  start_date: string | null
  end_date: string | null
  budget_minutes: number | null
  used_minutes: number | null
  entry_count: number
  last_used_at: string | null
}

interface EntryRow {
  id: number
  client_id: number
  project_id: number | null
  description: string
  started_at: string
  stopped_at: string | null
  rounded_min: number | null
  tags: string
  reference: string
  billable: number
  private_note: string
}

// ── Settings ─────────────────────────────────────────────────────────────

/** Read a single settings value, or undefined when the key is absent. */
export function getSetting(db: SqliteDb, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined
  return row?.value
}

/** Read the stored MCP privacy flags (mcp_expose_rates / _private_notes). */
export function readStoredPrivacy(db: SqliteDb): {
  exposeRates: boolean
  exposePrivateNotes: boolean
} {
  return {
    exposeRates: getSetting(db, 'mcp_expose_rates') === '1',
    exposePrivateNotes: getSetting(db, 'mcp_expose_private_notes') === '1'
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Seconds between two ISO timestamps; running entries measured to `nowMs`. */
export function durationSeconds(
  started_at: string,
  stopped_at: string | null,
  nowMs: number
): number {
  const start = Date.parse(started_at)
  if (Number.isNaN(start)) return 0
  const end = stopped_at ? Date.parse(stopped_at) : nowMs
  if (Number.isNaN(end)) return 0
  return Math.max(0, Math.floor((end - start) / 1000))
}

/**
 * Case-insensitive substring match for the lookup filters, done in JS because
 * SQLite's built-in LIKE folds ASCII only and would miss umlaut pairs like
 * MÜLLER/müller. An absent filter matches everything; a NULL field matches
 * only an absent filter. Filter input is always literal — no wildcards.
 */
function matchesFilter(field: string | null, filter: string | undefined): boolean {
  if (!filter) return true
  if (field == null) return false
  return field.toLowerCase().includes(filter.toLowerCase())
}

function shapeClient(row: ClientRow, privacy: PrivacyConfig): McpClient {
  const out: McpClient = {
    id: row.id,
    name: row.name,
    color: row.color,
    active: row.active === 1,
    vat_id: row.vat_id ?? null,
    contact_person: row.contact_person ?? null
  }
  if (privacy.exposeRates) out.rate_cent = row.rate_cent
  return out
}

function shapeProject(row: ProjectRow, privacy: PrivacyConfig): McpProject {
  const out: McpProject = {
    id: row.id,
    client_id: row.client_id ?? null,
    name: row.name,
    color: row.color,
    status: row.status,
    external_project_number: row.external_project_number ?? null,
    start_date: row.start_date ?? null,
    end_date: row.end_date ?? null,
    budget_minutes: row.budget_minutes ?? null,
    used_minutes: row.used_minutes ?? null,
    entry_count: row.entry_count ?? 0,
    last_used_at: row.last_used_at ?? null
  }
  if (privacy.exposeRates) out.rate_cent = row.rate_cent ?? null
  return out
}

function shapeEntry(row: EntryRow, privacy: PrivacyConfig, nowMs: number): McpEntry {
  const out: McpEntry = {
    id: row.id,
    client_id: row.client_id,
    project_id: row.project_id ?? null,
    description: row.description,
    started_at: row.started_at,
    stopped_at: row.stopped_at ?? null,
    duration_seconds: durationSeconds(row.started_at, row.stopped_at ?? null, nowMs),
    running: row.stopped_at == null,
    rounded_min: row.rounded_min ?? null,
    tags: deserializeTags(row.tags),
    reference: row.reference ?? '',
    billable: row.billable === 1
  }
  if (privacy.exposePrivateNotes) out.private_note = row.private_note ?? ''
  return out
}

// ── Queries ──────────────────────────────────────────────────────────────

export interface ListClientsOptions {
  includeArchived?: boolean
  /** Case-insensitive substring match on the client name. */
  name?: string
  /** Case-insensitive substring match on the contact person. */
  contactPerson?: string
}

export function listClients(
  db: SqliteDb,
  privacy: PrivacyConfig,
  opts: ListClientsOptions = {}
): McpClient[] {
  const where = opts.includeArchived ? '' : 'WHERE active = 1'
  const rows = db.prepare(`SELECT * FROM clients ${where} ORDER BY name ASC`).all() as ClientRow[]
  return rows
    .filter(
      (r) => matchesFilter(r.name, opts.name) && matchesFilter(r.contact_person, opts.contactPerson)
    )
    .map((r) => shapeClient(r, privacy))
}

export interface ListProjectsOptions {
  clientId?: number | null
  includeArchived?: boolean
  /** Case-insensitive substring match on the project name. */
  name?: string
  /** Case-insensitive substring match on the external project number. */
  externalProjectNumber?: string
}

export function listProjects(
  db: SqliteDb,
  privacy: PrivacyConfig,
  opts: ListProjectsOptions = {}
): McpProject[] {
  const base = `
    SELECT p.*,
      COALESCE(ec.cnt, 0) AS entry_count,
      ec.last_used_at,
      COALESCE(bud.used_minutes, 0) AS used_minutes
    FROM projects p
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS cnt, MAX(started_at) AS last_used_at
      FROM entries WHERE deleted_at IS NULL GROUP BY project_id
    ) ec ON ec.project_id = p.id
    LEFT JOIN (
      SELECT project_id, COALESCE(SUM(rounded_min), 0) AS used_minutes
      FROM entries
      WHERE deleted_at IS NULL AND stopped_at IS NOT NULL
      GROUP BY project_id
    ) bud ON bud.project_id = p.id`
  const filters: string[] = []
  const params: unknown[] = []
  if (opts.clientId === null) {
    filters.push('p.client_id IS NULL')
  } else if (typeof opts.clientId === 'number') {
    filters.push('p.client_id = ?')
    params.push(opts.clientId)
  }
  if (!opts.includeArchived) filters.push(`p.status != 'archived'`)
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
  const order = `ORDER BY CASE WHEN p.status = 'active' THEN 0 WHEN p.status = 'paused' THEN 1 ELSE 2 END, p.name`
  const rows = db.prepare(`${base} ${where} ${order}`).all(...params) as ProjectRow[]
  return rows
    .filter(
      (r) =>
        matchesFilter(r.name, opts.name) &&
        matchesFilter(r.external_project_number, opts.externalProjectNumber)
    )
    .map((r) => shapeProject(r, privacy))
}

export interface ListEntriesOptions {
  /** Inclusive ISO range start (e.g. '2026-06-01T00:00:00.000Z'). */
  from?: string
  /** Exclusive ISO range end. */
  to?: string
  /** Convenience: 1-based month window; overrides from/to when set. */
  year?: number
  month?: number
  clientId?: number
  projectId?: number
  tag?: string
  /** Hard cap on rows returned (default 1000). Never caps count/total_seconds. */
  limit?: number
  /** Return only count + total_seconds, no entries array. */
  summaryOnly?: boolean
}

export interface ListEntriesResult {
  /** Number of ALL matching entries (not capped by `limit`). */
  count: number
  /**
   * Unrounded wall-clock sum over ALL matching entries, running ones measured
   * to `now`. For billing-grade rounded totals use `getAnalytics` instead.
   */
  total_seconds: number
  /** Capped at `limit`; absent in summary-only mode. */
  entries?: McpEntry[]
}

/** Resolve month → [startISO, endISO) UTC window, matching entries:getByMonth. */
export function monthWindow(year: number, month: number): { start: string; end: string } {
  const start = `${year}-${String(month).padStart(2, '0')}-01T00:00:00.000Z`
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  const end = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00.000Z`
  return { start, end }
}

const ISO_TIMESTAMP =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/

/** Month and day exist in the calendar, read as written — before any offset shifts them. */
function isCalendarDate(year: string, month?: string, day?: string): boolean {
  if (month === undefined) return true
  const m = Number(month)
  if (m < 1 || m > 12) return false
  if (day === undefined) return true
  const d = Number(day)
  return d >= 1 && d <= new Date(Date.UTC(Number(year), m, 0)).getUTCDate()
}

/**
 * Normalise a caller's range boundary to the stored `toISOString()` form.
 * `started_at` is compared as text, so a raw `+02:00` or millisecond-less
 * boundary would compare its local digits against the stored UTC digits
 * (#228). A date-time without a zone designator stays UTC, as it always
 * compared; anything that is not an ISO timestamp is rejected, not guessed —
 * including a date Date.parse would silently roll over (2026-02-30).
 */
function toStoredInstant(value: string, name: 'from' | 'to'): string {
  // Upper-case first so a lowercase `t`/`z` takes the same path as `T`/`Z`.
  const upper = value.toUpperCase()
  const match = ISO_TIMESTAMP.exec(upper)
  const ms =
    match && isCalendarDate(match[1], match[2], match[3])
      ? Date.parse(match[4] && !match[5] ? `${upper}Z` : upper)
      : NaN
  if (Number.isNaN(ms)) {
    throw new Error(
      `${name} must be an ISO timestamp such as 2026-06-01T10:00:00+02:00 or 2026-06-01T08:00:00Z, got "${value}"`
    )
  }
  return new Date(ms).toISOString()
}

export function listEntries(
  db: SqliteDb,
  privacy: PrivacyConfig,
  opts: ListEntriesOptions,
  nowMs: number
): ListEntriesResult {
  const filters = ['deleted_at IS NULL']
  const params: unknown[] = []

  let from: string | undefined
  let to: string | undefined
  if (typeof opts.year === 'number' && typeof opts.month === 'number') {
    const w = monthWindow(opts.year, opts.month)
    from = w.start
    to = w.end
  } else {
    from = opts.from ? toStoredInstant(opts.from, 'from') : undefined
    to = opts.to ? toStoredInstant(opts.to, 'to') : undefined
  }
  if (from) {
    filters.push('started_at >= ?')
    params.push(from)
  }
  if (to) {
    filters.push('started_at < ?')
    params.push(to)
  }
  if (typeof opts.clientId === 'number') {
    filters.push('client_id = ?')
    params.push(opts.clientId)
  }
  if (typeof opts.projectId === 'number') {
    filters.push('project_id = ?')
    params.push(opts.projectId)
  }
  if (opts.tag) {
    // Exact whole-tag match against the `,tag1,tag2,` storage format.
    filters.push('tags LIKE ?')
    params.push(`%,${opts.tag.toLowerCase()},%`)
  }

  // One scan, no SQL LIMIT: count and total_seconds must cover the full match
  // (a capped entries array must never silently shrink the totals) AND stay
  // the exact sum of the per-entry duration_seconds a consumer sees — a
  // strftime('%s') aggregate truncates each timestamp's milliseconds and can
  // drift from that sum (a millisecond-exact julianday expression would be
  // needed should personal-scale DBs ever outgrow this scan). Only the
  // returned slice pays the shaping cost; summary-only shapes nothing.
  const rows = db
    .prepare(
      `SELECT * FROM entries WHERE ${filters.join(' AND ')}
       ORDER BY started_at ASC`
    )
    .all(...params) as EntryRow[]

  const total_seconds = rows.reduce(
    (sum, r) => sum + durationSeconds(r.started_at, r.stopped_at ?? null, nowMs),
    0
  )
  if (opts.summaryOnly) return { count: rows.length, total_seconds }
  const limit = Math.min(Math.max(1, opts.limit ?? 1000), 10000)
  return {
    count: rows.length,
    total_seconds,
    entries: rows.slice(0, limit).map((r) => shapeEntry(r, privacy, nowMs))
  }
}

export function getRunningTimer(
  db: SqliteDb,
  privacy: PrivacyConfig,
  nowMs: number
): McpEntry | null {
  const row = db
    .prepare(
      `SELECT * FROM entries
       WHERE stopped_at IS NULL AND deleted_at IS NULL
       ORDER BY started_at DESC LIMIT 1`
    )
    .get() as EntryRow | undefined
  return row ? shapeEntry(row, privacy, nowMs) : null
}

export interface McpDashboard {
  today_seconds: number
  week_seconds: number
  recent_entries: McpEntry[]
  top_clients_30d: Array<{
    client_id: number
    name: string
    color: string
    seconds: number
  }>
}

export function getDashboard(db: SqliteDb, privacy: PrivacyConfig, nowMs: number): McpDashboard {
  const SECS = `CASE
      WHEN stopped_at IS NULL
        THEN CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', started_at) AS INTEGER)
      ELSE CAST(strftime('%s', stopped_at) AS INTEGER) - CAST(strftime('%s', started_at) AS INTEGER)
    END`

  const today = db
    .prepare(
      `SELECT COALESCE(SUM(${SECS}), 0) AS seconds FROM entries
       WHERE deleted_at IS NULL
         AND (DATE(started_at,'localtime') = DATE('now','localtime') OR stopped_at IS NULL)`
    )
    .get() as { seconds: number }

  // Week window per the `week_start` setting (#188) — the same expression the
  // app's dashboard reads, so the MCP dashboard cannot answer a different week
  // than the window shows.
  const weekStart = parseWeekStart(getSetting(db, WEEK_START_SETTING_KEY))
  const week = db
    .prepare(
      `SELECT COALESCE(SUM(${SECS}), 0) AS seconds FROM entries
       WHERE deleted_at IS NULL
         AND (DATE(started_at,'localtime') >= DATE('now','localtime',${weekStartModifiers(weekStart)})
              OR stopped_at IS NULL)`
    )
    .get() as { seconds: number }

  const recentRows = db
    .prepare(
      `SELECT * FROM entries WHERE deleted_at IS NULL
       ORDER BY started_at DESC LIMIT 5`
    )
    .all() as EntryRow[]

  const topRows = db
    .prepare(
      `SELECT c.id AS client_id, c.name, c.color,
              COALESCE(SUM(
                CASE
                  WHEN e.stopped_at IS NULL
                    THEN CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', e.started_at) AS INTEGER)
                  ELSE CAST(strftime('%s', e.stopped_at) AS INTEGER) - CAST(strftime('%s', e.started_at) AS INTEGER)
                END
              ), 0) AS seconds
         FROM clients c
         LEFT JOIN entries e ON e.client_id = c.id
           AND e.deleted_at IS NULL
           AND DATE(e.started_at,'localtime') >= DATE('now','localtime','-30 days')
        GROUP BY c.id
        HAVING seconds > 0
        ORDER BY seconds DESC
        LIMIT 5`
    )
    .all() as Array<{ client_id: number; name: string; color: string; seconds: number }>

  return {
    today_seconds: Math.max(0, Math.floor(today.seconds ?? 0)),
    week_seconds: Math.max(0, Math.floor(week.seconds ?? 0)),
    recent_entries: recentRows.map((r) => shapeEntry(r, privacy, nowMs)),
    top_clients_30d: topRows.map((r) => ({
      client_id: r.client_id,
      name: r.name,
      color: r.color,
      seconds: Math.max(0, Math.floor(r.seconds ?? 0))
    }))
  }
}

export interface McpAnalytics {
  year: number
  month: number
  /**
   * Rounded per entry to the `rounding_minutes` step — the canonical
   * billing/PDF number. May exceed the raw sum from `listEntries`.
   */
  total_seconds: number
  billable_seconds: number
  /** Rounding step in minutes (app setting `pdf_round_minutes`); 0 = unrounded. */
  rounding_minutes: number
  /** Number of clients with recorded time in this month. */
  distinct_client_count: number
  /** Sorted by seconds descending, name as tiebreaker. */
  by_client: Array<{
    client_id: number
    name: string
    color: string
    seconds: number
    revenue_cent?: number
  }>
  /** Sorted by seconds descending, name as tiebreaker. */
  by_project: Array<{
    project_id: number | null
    /** The project's client; null for "(kein Projekt)" or client-less projects. */
    client_id: number | null
    name: string
    seconds: number
    revenue_cent?: number
  }>
  /** Total revenue in cents. Only present when rates are exposed. */
  revenue_cent?: number
}

/**
 * Monthly analytics mirroring analyticsHandlers.buildAnalyticsSummary:
 * completed entries only, rounding step from `pdf_round_minutes`, revenue via
 * `rate = project.rate ?? client.rate`. Revenue fields are omitted entirely
 * unless rates are exposed.
 */
export function getAnalytics(
  db: SqliteDb,
  privacy: PrivacyConfig,
  year: number,
  month: number
): McpAnalytics {
  const roundRow = db
    .prepare(`SELECT value FROM settings WHERE key = 'pdf_round_minutes'`)
    .get() as { value: string } | undefined
  const roundStep = parseInt(roundRow?.value ?? '0', 10) || 0

  const RAW_SEC = `(CAST(strftime('%s', e.stopped_at) AS INTEGER) - CAST(strftime('%s', e.started_at) AS INTEGER))`
  const ENTRY_SEC =
    roundStep > 0
      ? `(((${RAW_SEC} + 59) / 60 + ${roundStep} - 1) / ${roundStep} * ${roundStep} * 60)`
      : RAW_SEC
  const REVENUE = `(COALESCE(p.rate_cent, c.rate_cent, 0) * ${ENTRY_SEC} / 3600.0)`
  const monthKey = `${year}-${String(month).padStart(2, '0')}`

  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(${ENTRY_SEC}), 0) AS total_sec,
         COALESCE(SUM(CASE WHEN e.billable = 1 THEN ${ENTRY_SEC} ELSE 0 END), 0) AS billable_sec,
         COALESCE(SUM(CASE WHEN e.billable = 1 THEN ${REVENUE} ELSE 0 END), 0) AS revenue_cent
       FROM entries e
       JOIN clients c ON c.id = e.client_id
       LEFT JOIN projects p ON p.id = e.project_id
       WHERE e.deleted_at IS NULL AND e.stopped_at IS NOT NULL
         AND strftime('%Y-%m', e.started_at, 'localtime') = ?`
    )
    .get(monthKey) as { total_sec: number; billable_sec: number; revenue_cent: number }

  const byClient = db
    .prepare(
      `SELECT c.id AS client_id, c.name, c.color,
              COALESCE(SUM(${ENTRY_SEC}), 0) AS seconds,
              COALESCE(SUM(CASE WHEN e.billable = 1 THEN ${REVENUE} ELSE 0 END), 0) AS revenue_cent
         FROM entries e
         JOIN clients c ON c.id = e.client_id
         LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.deleted_at IS NULL AND e.stopped_at IS NOT NULL
          AND strftime('%Y-%m', e.started_at, 'localtime') = ?
        GROUP BY c.id
        HAVING seconds > 0
        ORDER BY seconds DESC, c.name ASC`
    )
    .all(monthKey) as Array<{
    client_id: number
    name: string
    color: string
    seconds: number
    revenue_cent: number
  }>

  const byProject = db
    .prepare(
      `SELECT e.project_id AS project_id,
              pr.client_id AS client_id,
              COALESCE(pr.name, '(kein Projekt)') AS name,
              COALESCE(SUM(${ENTRY_SEC}), 0) AS seconds,
              COALESCE(SUM(CASE WHEN e.billable = 1 THEN ${REVENUE} ELSE 0 END), 0) AS revenue_cent
         FROM entries e
         JOIN clients c ON c.id = e.client_id
         LEFT JOIN projects p ON p.id = e.project_id
         LEFT JOIN projects pr ON pr.id = e.project_id
        WHERE e.deleted_at IS NULL AND e.stopped_at IS NOT NULL
          AND strftime('%Y-%m', e.started_at, 'localtime') = ?
        GROUP BY e.project_id
        HAVING seconds > 0
        ORDER BY seconds DESC, name ASC`
    )
    .all(monthKey) as Array<{
    project_id: number | null
    client_id: number | null
    name: string
    seconds: number
    revenue_cent: number
  }>

  const result: McpAnalytics = {
    year,
    month,
    total_seconds: Math.max(0, Math.floor(totals.total_sec ?? 0)),
    billable_seconds: Math.max(0, Math.floor(totals.billable_sec ?? 0)),
    rounding_minutes: roundStep,
    distinct_client_count: byClient.length,
    by_client: byClient.map((r) => ({
      client_id: r.client_id,
      name: r.name,
      color: r.color,
      seconds: Math.max(0, Math.floor(r.seconds ?? 0)),
      ...(privacy.exposeRates ? { revenue_cent: Math.round(r.revenue_cent ?? 0) } : {})
    })),
    by_project: byProject.map((r) => ({
      project_id: r.project_id ?? null,
      client_id: r.client_id ?? null,
      name: r.name,
      seconds: Math.max(0, Math.floor(r.seconds ?? 0)),
      ...(privacy.exposeRates ? { revenue_cent: Math.round(r.revenue_cent ?? 0) } : {})
    }))
  }
  if (privacy.exposeRates) result.revenue_cent = Math.round(totals.revenue_cent ?? 0)
  return result
}
