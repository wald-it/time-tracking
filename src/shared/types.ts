// Shared types between main process and renderer

export interface Client {
  id: number
  name: string
  color: string
  active: number
  rate_cent: number
  created_at: string
  // v1.11 #94 — Stammdaten-Erweiterung
  billing_address_line1?: string | null
  billing_address_line2?: string | null
  billing_address_line3?: string | null
  billing_address_line4?: string | null
  vat_id?: string | null
  contact_person?: string | null
  contact_email?: string | null
}

export interface Entry {
  id: number
  client_id: number
  description: string
  started_at: string
  stopped_at: string | null
  heartbeat_at: string | null
  rounded_min: number | null
  deleted_at: string | null
  created_at: string
  /**
   * v1.3 PR B: when an entry crosses local midnight, it's stored as
   * multiple rows that share the same UUID. NULL for plain single-day
   * entries. The Drawer offers a "auch zweite Hälfte löschen?" prompt
   * when the user deletes a row with a non-null link_id.
   */
  link_id: string | null
  /**
   * v1.4 PR C: comma-delimited serialized tags, e.g. `,bug,ux,`.
   * Empty string means untagged. Use `deserializeTags` from shared/tags.ts
   * to convert to an array for UI consumption.
   */
  tags: string
  /**
   * v1.8 #70: optional free-text reference (Jira ticket, GitHub issue, …).
   * Empty string means no reference. Never null — the DB column has
   * NOT NULL DEFAULT ''.
   */
  reference: string
  /**
   * v1.8 #71: 1 = billable (default), 0 = non-billable.
   * Non-billable entries are counted in total duration but excluded from
   * invoice exports (CSV, PDF) and the billable-hours summary.
   */
  billable: number
  /**
   * v1.8 #72: optional internal-only note, never written to any export.
   * Empty string means no note set.
   */
  private_note: string
  /**
   * v1.9 #75: optional project association. NULL means "no project / general".
   */
  project_id?: number | null
}

// ── Projects (v1.9 #75) ───────────────────────────────────────────────────

export interface Project {
  id: number
  /** NULL = orphaned / no client (E4 escape hatch). */
  client_id: number | null
  name: string
  /** '' = inherit client color. */
  color: string
  /** null = inherit client rate. */
  rate_cent: number | null
  /** 1 = active, 0 = archived. */
  active: number
  created_at: string
  /**
   * Only present in `projects:getAll` responses. Counts non-deleted entries.
   */
  entry_count?: number
  /**
   * Only present in `projects:getAll` responses. ISO timestamp of the most
   * recent entry's started_at, or null when no entries exist.
   */
  last_used_at?: string | null
  // v1.11 #94 — Stammdaten-Erweiterung
  /** External project number / reference (e.g. customer PO number). */
  external_project_number?: string | null
  /** Project start date as ISO date string (e.g. '2026-01-01'). */
  start_date?: string | null
  /** Project end date as ISO date string (e.g. '2026-12-31'). */
  end_date?: string | null
  /**
   * Total hour budget in minutes. Integer arithmetic, consistent with
   * `used_minutes`. null = no budget set.
   */
  budget_minutes?: number | null
  /**
   * Project lifecycle status. Supersedes the binary `active` flag.
   */
  status?: 'active' | 'paused' | 'archived'
  /**
   * Only present in `projects:getAll` responses.
   * Budget used, all-time: billed minutes of the project's completed,
   * billable entries, each rounded like the invoice (#285). 0 when none.
   */
  used_minutes?: number | null
  // v1.12 #105 — Project-level contact person
  /**
   * Project-specific contact person. When set, takes precedence over
   * `clients.contact_person` in the PDF recipient block.
   * null = fall back to the client's contact_person.
   */
  contact_person?: string | null
}

/** Project guaranteed to include entry_count (returned by projects:getAll). */
export type ProjectWithCount = Required<Pick<Project, 'entry_count'>> & Omit<Project, 'entry_count'>

export interface CreateProjectInput {
  client_id: number | null
  name: string
  color: string
  rate_cent?: number | null
  // v1.11 #94
  external_project_number?: string | null
  start_date?: string | null
  end_date?: string | null
  budget_minutes?: number | null
  status?: 'active' | 'paused' | 'archived'
  // v1.12 #105
  contact_person?: string | null
}

export interface UpdateProjectInput {
  id: number
  client_id: number | null
  name: string
  color: string
  rate_cent?: number | null
  active: number
  // v1.11 #94
  external_project_number?: string | null
  start_date?: string | null
  end_date?: string | null
  budget_minutes?: number | null
  status?: 'active' | 'paused' | 'archived'
  // v1.12 #105
  contact_person?: string | null
}

export interface Settings {
  company_name: string
  backup_path: string
  // v1.1
  idle_threshold_minutes: string
  language: string
  auto_start: string
  hotkey_toggle: string
  // v1.3 PR A — PDF template settings (seeded by migration 004).
  // All stored as strings in the key-value `settings` table; the renderer
  // parses pdf_round_minutes back to a number when needed.
  pdf_logo_path: string
  pdf_sender_address: string
  pdf_tax_id: string
  pdf_accent_color: string
  pdf_footer_text: string
  pdf_round_minutes: string
  // v1.4 — Mini-Widget (always-on-top 200x40 overlay).
  // Stored as strings; renderer parses '0'/'1' booleans and integer
  // positions. mini_x/mini_y of -1 means "never positioned, use default".
  mini_enabled: string
  mini_hotkey: string
  mini_x: string
  mini_y: string
  // v1.5 PR E — Onboarding wizard.
  // '0' = not yet completed, '1' = done (or existing user after upgrade).
  onboarding_completed: string
  // v1.8 #76 — Theme mode: 'light' | 'dark' | 'system'.
  theme_mode: string
  // v1.18 #188 — Where the week begins: 'monday' (default) | 'sunday'.
  // Drives the week total (Heute card, tray, Stream Deck dial, MCP dashboard),
  // the export quick filters and the calendar grid. NOT the KW axis in
  // Auswertung — the calendar week is ISO 8601, i.e. always Monday.
  week_start?: string
  // v1.11 #94 — Show external project number in square brackets.
  // '0' (default) = hidden, '1' = shown.
  show_project_number?: string
  // Main window size, position and maximized flag as a JSON blob, written by
  // the main process (see main/windowBounds.ts). Absent until the first move.
  window_bounds?: string
  // v1.13.2 — Export modal preferences as a JSON blob (see ExportModal.tsx).
  // Lives in the DB instead of localStorage so it survives hard exits,
  // second instances, and is included in backups. Absent until first change.
  export_prefs?: string
  // v1.14 #128 — MCP integration flags (seeded by migration 018). Stored as
  // '0'/'1' strings. The read-only MCP server reads the two expose_* flags
  // (env vars override); mcp_write_enabled gates the future write path (#127).
  mcp_expose_rates?: string
  mcp_expose_private_notes?: string
  mcp_write_enabled?: string
  // v1.14 #127 — MCP write-mode confirmation (seeded by migration 019):
  // 'per-write' (default) | 'session' | 'silent'.
  mcp_write_confirm_mode?: string
  // v1.15 #134 — Outbound-webhook targets as a JSON blob (see shared/webhooks.ts).
  // One settings row like export_prefs; seeded '[]' by migration 020.
  webhook_targets?: string
  // v1.16 #130 — Optional override for the shipped Entra client id, for tenants
  // that block third-party apps. Empty/absent means "use the bundled one".
  // The tokens themselves are NOT here — see main/graphTokenStore.ts.
  graph_client_id?: string
  // v1.17 #133 — Hardware-key controller scope (Stream Deck & co.), seeded by
  // migration 023. Gates the controller ops on the local write bridge; the
  // controller token file is separate from the MCP write token.
  controller_enabled?: string
  // v1.17 #132 — Teams presence mirroring (migration 024). Work/school
  // accounts only; presence_show_client gates whether the status message
  // names the client (default generic).
  presence_enabled?: string
  presence_show_client?: string
  // v1.17 #169 — subscribable iCal feed (migration 025). Local-only webcal
  // server; the token is persistent because subscribers store the URL.
  ical_feed_enabled?: string
  ical_feed_port?: string
  ical_feed_token?: string
  // #273 — automatic update check at app start, '1'/'0'. No migration: absent
  // means on (see shared/updateCheck.ts). Manual "Check now" is unaffected.
  update_check_enabled?: string
}

export interface CreateClientInput {
  name: string
  color: string
  /**
   * Hourly rate in cents. 0 = "no rate set" (PDF export omits the fee
   * column). Integer arithmetic prevents float drift on totals.
   */
  rate_cent?: number
  // v1.11 #94
  billing_address_line1?: string | null
  billing_address_line2?: string | null
  billing_address_line3?: string | null
  billing_address_line4?: string | null
  vat_id?: string | null
  contact_person?: string | null
  contact_email?: string | null
}

export interface UpdateClientInput {
  id: number
  name: string
  color: string
  active: number
  rate_cent?: number
  // v1.11 #94
  billing_address_line1?: string | null
  billing_address_line2?: string | null
  billing_address_line3?: string | null
  billing_address_line4?: string | null
  vat_id?: string | null
  contact_person?: string | null
  contact_email?: string | null
}

export interface CreateEntryInput {
  client_id: number
  description: string
  started_at: string
  /** v1.9 #75: optional project association. */
  project_id?: number | null
}

/**
 * Result of `entries:switch` (B1): the entry that now runs, and the one that
 * was stopped at the same instant (null when nothing ran).
 */
export interface SwitchTimerResult {
  entry: Entry
  stopped: Entry | null
}

/**
 *Manual-entry creation (Today "+ Eintrag nachtragen" / Calendar drawer
 * "+ Eintrag hinzufügen"). Distinct from CreateEntryInput because manual
 * entries always carry a stopped_at; running entries are created via
 * `entries:start` only.
 */
export interface CreateManualEntryInput {
  client_id: number
  description: string
  started_at: string
  stopped_at: string
  /** Serialized tags string (e.g. `,bug,ux,`). Optional — defaults to '' */
  tags?: string
  /** Free-text ticket/reference (e.g. 'JIRA-123'). Optional — defaults to '' */
  reference?: string
  /** 1 = billable (default), 0 = non-billable. Optional — defaults to 1 */
  billable?: number
  /** Internal-only note, never exported. Optional — defaults to '' */
  private_note?: string
  /** v1.9 #75: optional project association. */
  project_id?: number | null
}

export interface UpdateEntryInput {
  id: number
  client_id: number
  description: string
  started_at: string
  stopped_at: string
  /** Serialized tags string (e.g. `,bug,ux,`). Optional — defaults to '' */
  tags?: string
  /** Free-text ticket/reference (e.g. 'JIRA-123'). Optional — defaults to '' */
  reference?: string
  /** 1 = billable (default), 0 = non-billable. Optional — defaults to 1 */
  billable?: number
  /** Internal-only note, never exported. Optional — defaults to '' */
  private_note?: string
  /** v1.9 #75: optional project association. */
  project_id?: number | null
}

export interface MonthQuery {
  year: number
  month: number // 1-12
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export type BackupReason = 'daily' | 'manual' | 'pre-migration' | 'mcp'

export interface BackupInfo {
  filename: string
  fullPath: string
  reason: BackupReason
  createdAt: string
  sizeBytes: number
}

/**
 * v1.5 PR B — auto-update lifecycle status broadcast over `update:status` IPC.
 */
export type UpdateStatus =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; progress: number }
  | { status: 'ready'; version: string }
  | { status: 'not-available'; checkedAt: string }
  | { status: 'error'; message: string }

/** Aggregated dashboard view returned by `dashboard:summary`. */
export interface DashboardSummary {
  todaySeconds: number
  weekSeconds: number
  /**
   * The week split by day, 7 values in `week_start` order (Messinstrument
   * WeekMeter). Today's slot equals `todaySeconds`, the sum `weekSeconds`.
   */
  weekDaySeconds: number[]
  /** Last five entries overall, newest first. */
  recentEntries: Entry[]
  /** Every entry of today (started today or still running), newest first. */
  todayEntries: Entry[]
  /**
   * Up to five ACTIVE clients by hours in the last 30 days. `last_project_id`
   * is the last used project that is still active (see `readTopClients30d`).
   */
  topClients30d: Array<{
    client_id: number
    name: string
    color: string
    seconds: number
    last_project_id: number | null
  }>
}

/**
 * v1.5 PR F — one entry in resources/licenses.json, generated by
 * scripts/generate-licenses.mjs from the production dependency tree.
 */
export interface LicenseEntry {
  name: string
  version: string
  license: string
  repository?: string
  licenseText?: string | null
}

// ── Analytics (v1.10 #93) ─────────────────────────────────────────────────

export interface AnalyticsSummary {
  month: {
    /** Worked seconds in the selected month (raw, owner decision 2026-10-22). */
    hours: number
    /**
     * The same month rounded per entry like the invoice, then summed — for the
     * "gerundet … h" sub-line. null when no rounding step is set.
     */
    hoursRounded: number | null
    /** Worked seconds in the comparison period (see `comparison`). */
    hoursPrev: number
    /** Total revenue in cents for the selected month. */
    revenue: number
    /** Revenue in cents in the comparison period (see `comparison`). */
    revenuePrev: number
    /** Billable ratio 0–1 (billable seconds / total seconds). */
    billable: number
    /** Billable ratio in the comparison period (see `comparison`). */
    billablePrev: number
    /** Days elapsed in the selected month (capped at daysInMonth). */
    daysElapsed: number
    /** Total days in the selected month. */
    daysInMonth: number
    /**
     * What the *Prev fields cover (B2): `samePeriod` — the current month is
     * compared with days 1…`prevPeriodDays` of the previous month; `fullMonth`
     * — a past month with the whole previous month.
     */
    comparison: 'samePeriod' | 'fullMonth'
    /** Last day of the previous month the comparison covers. */
    prevPeriodDays: number
    /** True if at least one completed entry exists in the selected month. */
    hasData: boolean
    /** True if at least one client or project has rate_cent > 0. */
    hasRateConfigured: boolean
  }
  /** 12 calendar weeks trailing to end of selected month. b/n in worked seconds, r in cents. */
  weeks: Array<{ lbl: string; b: number; n: number; r: number }>
  /**
   * 12 calendar months trailing to end of selected month. h = b + n in worked
   * seconds (billable / non-billable), r in cents.
   */
  months: Array<{ lbl: string; h: number; b: number; n: number; r: number }>
  /** Hours by client for the selected month, sorted by hours desc. */
  byClient: Array<{
    client_id: number
    name: string
    color: string
    /** worked seconds */
    h: number
    /** worked seconds of billable entries; 0 ⇒ the client shows "intern" */
    b: number
    /** cents */
    rev: number
    rest?: boolean
  }>
  /**
   * Average worked seconds per calendar day by weekday (Mo–So) over the last
   * 90 completed days, global: the weekday's total divided by how often it
   * occurs in the span (days off count). The seven add up to the average week.
   */
  weekday: Array<{ d: string; h: number }>
}

// ── Budget (v1.11 #94) ────────────────────────────────────────────────────

export interface BudgetStatus {
  /** Total budget in minutes, or null when no budget is set. */
  budgetMinutes: number | null
  /** Billed minutes of completed, billable entries, all-time, as on the invoice (#285). */
  usedMinutes: number
}
