/**
 * Electron-free core of the MCP write bridge.
 *
 * `handleRequest` is the single guarded entry point that both the socket
 * server (mcpBridge.ts) and the unit tests drive. It contains no `net`, no
 * `electron`, and no I/O beyond the injected DB + callbacks — so the whole
 * guard chain (token, opt-in, allowlist, preview, confirm, backup, audit) is
 * testable with stubs.
 */
import type Database from 'better-sqlite3'
import {
  createManualEntry,
  updateManualEntry,
  startTimer,
  stopRunningTimer,
  validateManualEntry,
  validateProjectForClient
} from './entryMutations'
import type {
  Entry,
  CreateManualEntryInput,
  UpdateEntryInput,
  CreateEntryInput
} from '../shared/types'
import type { McpAuditEntry } from './mcpAudit'
import { readRoundMinutes, readRoundedTotals, readTotals } from './dashboardTotals'
import {
  formatLocalMoment,
  formatLocalSpan,
  offsetHint,
  parseZonedTimestamp,
  toLocalIso,
  zonedTimestampError
} from '../shared/zonedTimestamp'
import { roundDuration } from '../shared/duration'

type Db = Database.Database

export const WRITE_OPS = [
  'create_manual_entry',
  'update_entry_fields',
  'stop_running_timer',
  'start_timer'
] as const
export type WriteOp = (typeof WRITE_OPS)[number]

/**
 * Ops available to hardware-key controllers (#133 — Stream Deck & co.). The
 * two scopes are strictly separated by token: the MCP token cannot call
 * controller ops (they skip the confirm dialog — a physical key press IS the
 * confirmation, but an AI agent must never get that shortcut), and the
 * controller token cannot call the MCP write ops.
 */
export const CONTROLLER_OPS = [
  'toggle_timer',
  'get_timer_status',
  'list_targets',
  'get_summary'
] as const
export type ControllerOp = (typeof CONTROLLER_OPS)[number]

export interface BridgeRequest {
  v?: number
  token?: string
  op?: string
  args?: Record<string, unknown>
  preview?: boolean
}

export type BridgeResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string; code: BridgeErrorCode }

export type BridgeErrorCode =
  | 'invalid'
  | 'bad_token'
  | 'write_disabled'
  | 'not_allowed'
  | 'confirm_declined'

export interface BridgeCtx {
  db: Db
  /** Expected token; null/empty ⇒ treat as write-disabled. */
  token: string | null
  /** Re-checked per request from the settings table. */
  isWriteEnabled: () => boolean
  /** Controller-scope token (#133); null/undefined ⇒ controller scope unavailable. */
  controllerToken?: string | null
  /** Re-checked per request from the settings table. Absent ⇒ disabled. */
  isControllerEnabled?: () => boolean
  /** Ask the user; encapsulates per-write/session/silent. Resolves to approval. */
  confirm: (summary: string) => Promise<boolean>
  /** Make the one-per-session pre-write backup (idempotent). */
  ensureBackup: () => Promise<void>
  audit: (entry: McpAuditEntry) => void
  /** Broadcast + tray refresh after a committed change. */
  onChange: () => void
  /**
   * Fire outbound webhooks for the committed op (#134). Fire-and-forget, wired
   * in mcpBridge.ts; optional so tests can omit it. Kept out of this core so
   * the module stays Electron- and network-free.
   */
  emitWebhook?: (op: WriteOp, entry: Entry | null) => void
}

function err(code: BridgeErrorCode, error: string): BridgeResponse {
  return { ok: false, error, code }
}

// ── arg coercion ───────────────────────────────────────────────────────────

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}
function asBillable(v: unknown, fallback: number): number {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v === 0 ? 0 : 1
  return fallback
}
function asProjectId(v: unknown, fallback: number | null): number | null {
  if (v === null) return null
  if (typeof v === 'number') return v
  return fallback
}
/**
 * An MCP time field: real date, time of day and zone (owner decision
 * 2026-10-22). Returns the stored form (UTC, ms, `Z`) or an error that names
 * the field. MCP scope only — controller ops (#133) send no timestamps.
 */
function zonedField(
  field: string,
  value: unknown
): { iso: string; hint: string | null } | { error: string } {
  const r = parseZonedTimestamp(value)
  return r.ok
    ? { iso: r.iso, hint: offsetHint(r.iso, r.offsetMin) }
    : { error: zonedTimestampError(field, value, r.reason) }
}

/**
 * Offset notes for the confirmation dialog and the preview (owner review
 * 2026-10-22): a written offset that is not the local one on that day is
 * accepted but called out, usually summer time copied past the change.
 */
type OffsetHints = Partial<Record<'started_at' | 'stopped_at', string>>

const FIELD_LABEL = { started_at: 'Start', stopped_at: 'Ende' } as const

/** The confirmation text with one line per offset note. */
function withHints(summary: string, hints: OffsetHints): string {
  const lines = (Object.keys(hints) as Array<keyof OffsetHints>).map(
    (f) => `${FIELD_LABEL[f]}: ${hints[f]}`
  )
  return lines.length ? `${summary}\n${lines.join('\n')}` : summary
}

/** Preview fields; the notes sit under their own key so nothing overwrites them. */
function hintPreview(hints: OffsetHints): Record<string, unknown> {
  return Object.keys(hints).length ? { zeit_hinweise: hints } : {}
}

function durationMin(started_at: string, stopped_at: string): number {
  return Math.round((Date.parse(stopped_at) - Date.parse(started_at)) / 60000)
}

// ── op planning ──────────────────────────────────────────────────────────

interface Plan {
  summary: string
  preview: Record<string, unknown>
  run: () => { ok: true; data: Entry | null } | { ok: false; error: string }
  audit: (result: Entry | null) => McpAuditEntry
}

/** Build an executable plan for an op, or return an error string. */
function planOp(db: Db, op: WriteOp, args: Record<string, unknown>): Plan | { error: string } {
  switch (op) {
    case 'create_manual_entry': {
      const start = zonedField('started_at', args.started_at)
      if ('error' in start) return start
      const stop = zonedField('stopped_at', args.stopped_at)
      if ('error' in stop) return stop
      const hints: OffsetHints = {}
      if (start.hint) hints.started_at = start.hint
      if (stop.hint) hints.stopped_at = stop.hint
      const input: CreateManualEntryInput = {
        client_id: Number(args.client_id),
        description: asString(args.description),
        started_at: start.iso,
        stopped_at: stop.iso,
        tags: asString(args.tags),
        reference: asString(args.reference),
        billable: asBillable(args.billable, 1),
        private_note: asString(args.private_note),
        project_id: asProjectId(args.project_id, null)
      }
      const vErr = validateManualEntry(db, input)
      if (vErr) return { error: vErr }
      return {
        summary: withHints(
          `Eintrag nachtragen — Kunde ${input.client_id}, ${formatLocalSpan(input.started_at, input.stopped_at)} (${durationMin(input.started_at, input.stopped_at)} min): "${input.description}"`,
          hints
        ),
        preview: {
          action: 'create_manual_entry',
          client_id: input.client_id,
          started_at: input.started_at,
          stopped_at: input.stopped_at,
          started_local: toLocalIso(input.started_at),
          stopped_local: toLocalIso(input.stopped_at),
          duration_min: durationMin(input.started_at, input.stopped_at),
          project_id: input.project_id,
          ...hintPreview(hints)
        },
        run: () => createManualEntry(db, input),
        audit: (r) => ({
          op,
          id: r?.id ?? null,
          client_id: input.client_id,
          started_at: input.started_at,
          stopped_at: input.stopped_at,
          hasPrivateNote: (input.private_note ?? '') !== ''
        })
      }
    }
    case 'update_entry_fields': {
      const id = Number(args.id)
      const existing = db
        .prepare(`SELECT * FROM entries WHERE id = ? AND deleted_at IS NULL`)
        .get(id) as Entry | undefined
      if (!existing) return { error: 'Eintrag existiert nicht' }
      // Running timers are excluded from update_entry_fields entirely (matches
      // the tool description). Stop the timer via stop_running_timer first.
      if (existing.stopped_at === null) {
        return {
          error:
            'Laufende Einträge können nicht über update_entry_fields bearbeitet werden — erst stop_running_timer nutzen'
        }
      }
      // Only the time fields the caller actually passed are checked; an update
      // without them keeps the stored values and is not affected by the rule.
      const hints: OffsetHints = {}
      let startedAt = existing.started_at
      if (args.started_at !== undefined) {
        const r = zonedField('started_at', args.started_at)
        if ('error' in r) return r
        startedAt = r.iso
        if (r.hint) hints.started_at = r.hint
      }
      let stoppedAt = existing.stopped_at ?? ''
      if (args.stopped_at !== undefined) {
        const r = zonedField('stopped_at', args.stopped_at)
        if ('error' in r) return r
        stoppedAt = r.iso
        if (r.hint) hints.stopped_at = r.hint
      }
      const input: UpdateEntryInput = {
        id,
        client_id: args.client_id === undefined ? existing.client_id : Number(args.client_id),
        description:
          args.description === undefined ? existing.description : asString(args.description),
        started_at: startedAt,
        stopped_at: stoppedAt,
        tags: args.tags === undefined ? existing.tags : asString(args.tags),
        reference: args.reference === undefined ? existing.reference : asString(args.reference),
        billable:
          args.billable === undefined
            ? existing.billable
            : asBillable(args.billable, existing.billable),
        private_note:
          args.private_note === undefined ? existing.private_note : asString(args.private_note),
        project_id:
          'project_id' in args
            ? asProjectId(args.project_id, existing.project_id ?? null)
            : (existing.project_id ?? null)
      }
      const vErr = validateManualEntry(db, input, id, existing.link_id ?? undefined)
      if (vErr) return { error: vErr }
      return {
        summary: withHints(
          `Eintrag #${id} ändern — vorher ${formatLocalSpan(existing.started_at, existing.stopped_at)}, ` +
            `nachher ${formatLocalSpan(input.started_at, input.stopped_at)}: "${input.description}"`,
          hints
        ),
        preview: {
          action: 'update_entry_fields',
          id,
          before: {
            description: existing.description,
            started_at: existing.started_at,
            stopped_at: existing.stopped_at,
            started_local: toLocalIso(existing.started_at),
            stopped_local: toLocalIso(existing.stopped_at),
            tags: existing.tags,
            reference: existing.reference,
            billable: existing.billable,
            project_id: existing.project_id ?? null
          },
          after: {
            description: input.description,
            started_at: input.started_at,
            stopped_at: input.stopped_at,
            started_local: toLocalIso(input.started_at),
            stopped_local: toLocalIso(input.stopped_at),
            tags: input.tags,
            reference: input.reference,
            billable: input.billable,
            project_id: input.project_id
          },
          ...hintPreview(hints)
        },
        run: () => updateManualEntry(db, input),
        audit: (r) => ({
          op,
          id: r?.id ?? id,
          client_id: input.client_id,
          started_at: input.started_at,
          stopped_at: input.stopped_at,
          hasPrivateNote: (input.private_note ?? '') !== ''
        })
      }
    }
    case 'start_timer': {
      // Absent (or empty) means "now", as before; a given start must be zoned.
      let startedAt = new Date().toISOString()
      let given = false
      const hints: OffsetHints = {}
      if (args.started_at !== undefined && args.started_at !== '') {
        const r = zonedField('started_at', args.started_at)
        if ('error' in r) return r
        startedAt = r.iso
        given = true
        if (r.hint) hints.started_at = r.hint
      }
      const input: CreateEntryInput = {
        client_id: Number(args.client_id),
        description: asString(args.description),
        started_at: startedAt,
        project_id: asProjectId(args.project_id, null)
      }
      const client = db.prepare(`SELECT id FROM clients WHERE id = ?`).get(input.client_id) as
        | { id: number }
        | undefined
      if (!client) return { error: 'Kunde existiert nicht' }
      if (input.project_id != null) {
        const pErr = validateProjectForClient(db, input.project_id, input.client_id)
        if (pErr) return { error: pErr }
      }
      return {
        summary: withHints(
          `Timer starten — Kunde ${input.client_id}, ${given ? `ab ${formatLocalMoment(input.started_at)}` : 'ab jetzt'}: "${input.description}"`,
          hints
        ),
        preview: {
          action: 'start_timer',
          client_id: input.client_id,
          started_at: input.started_at,
          started_local: toLocalIso(input.started_at),
          project_id: input.project_id,
          ...hintPreview(hints)
        },
        run: () => startTimer(db, input),
        audit: (r) => ({
          op,
          id: r?.id ?? null,
          client_id: input.client_id,
          started_at: input.started_at
        })
      }
    }
    case 'stop_running_timer': {
      const running = db
        .prepare(
          `SELECT id, client_id FROM entries WHERE stopped_at IS NULL AND deleted_at IS NULL
           ORDER BY started_at DESC LIMIT 1`
        )
        .get() as { id: number; client_id: number } | undefined
      return {
        summary: running
          ? `Laufenden Timer stoppen (Eintrag #${running.id})`
          : 'Laufenden Timer stoppen (keiner aktiv)',
        preview: { action: 'stop_running_timer', running: running ?? null },
        run: () => stopRunningTimer(db),
        audit: (r) => ({ op, id: r?.id ?? null, client_id: r?.client_id ?? null })
      }
    }
  }
}

// ── controller scope (#133) ─────────────────────────────────────────────────

export interface RunningStatus {
  id: number
  client_id: number
  project_id: number | null
  description: string
  started_at: string
  client_name: string
  project_name: string | null
}

/** Current running timer with client/project names, or null.
 *  Exported for the presence reconciler (#132), which needs the same shape. */
export function readRunning(db: Db): RunningStatus | null {
  const row = db
    .prepare(
      `SELECT e.id, e.client_id, e.project_id, e.description, e.started_at,
              c.name AS client_name, p.name AS project_name
       FROM entries e
       JOIN clients c ON c.id = e.client_id
       LEFT JOIN projects p ON p.id = e.project_id
       WHERE e.stopped_at IS NULL AND e.deleted_at IS NULL
       ORDER BY e.started_at DESC LIMIT 1`
    )
    .get() as RunningStatus | undefined
  return row ?? null
}

/**
 * Controller ops run without the confirm dialog: the physical key press is the
 * user's confirmation. Everything else from the write path stays — opt-in
 * gate, one-per-session backup, audit (with `source: 'controller'`),
 * broadcast/tray refresh and outbound webhooks.
 */
async function handleControllerRequest(
  ctx: BridgeCtx,
  req: BridgeRequest
): Promise<BridgeResponse> {
  if (!(ctx.isControllerEnabled?.() ?? false)) {
    return err('write_disabled', 'Hardware-Tasten sind deaktiviert (Einstellungen → Integrationen)')
  }
  if (!(CONTROLLER_OPS as readonly string[]).includes(req.op!)) {
    return err('not_allowed', `Operation nicht erlaubt: ${req.op}`)
  }
  const db = ctx.db
  const op = req.op as ControllerOp
  const args = req.args ?? {}

  if (op === 'get_timer_status') {
    return { ok: true, data: { running: readRunning(db) } }
  }

  // get_summary — everything the Stream Deck dial polls for its ambient face
  // (#186) in ONE round trip: the running timer plus the two totals the app's
  // "Heute" page shows. Superset of get_timer_status; that op stays for the
  // key action, which does not need the totals.
  //
  // Raw and rounded seconds. Since the Messinstrument UI (owner decision
  // 2026-10-22) the app shows the RAW worked time large; surfaces that mirror
  // the page show the raw seconds.
  // - `*_rounded_seconds`: as the invoice bills it — each entry rounded up to
  //   `pdf_round_minutes` (readRoundedTotals), the same number as Heute's
  //   "gerundet … h". One rounding rule in the product.
  // - `*_display_seconds`: LEGACY, unchanged meaning — the total rounded in
  //   one piece, as the page showed it before. Kept only for plugin builds
  //   that already read it (the plugin ships separately); not the invoice rule.
  if (op === 'get_summary') {
    const totals = readTotals(db)
    const round_minutes = readRoundMinutes(db)
    return {
      ok: true,
      data: {
        running: readRunning(db),
        ...totals,
        round_minutes,
        ...readRoundedTotals(db),
        // Legacy: the total rounded in one piece — see above.
        today_display_seconds: roundDuration(totals.today_seconds, round_minutes),
        week_display_seconds: roundDuration(totals.week_seconds, round_minutes)
      }
    }
  }

  if (op === 'list_targets') {
    const clients = db
      .prepare(`SELECT id, name, color FROM clients WHERE active = 1 ORDER BY name ASC`)
      .all() as Array<{ id: number; name: string; color: string }>
    const projStmt = db.prepare(
      `SELECT id, name FROM projects WHERE client_id = ? AND status = 'active' ORDER BY name ASC`
    )
    return {
      ok: true,
      data: {
        clients: clients.map((c) => ({ ...c, projects: projStmt.all(c.id) }))
      }
    }
  }

  // toggle_timer — target is (client_id, project_id|null); stop on exact
  // match, otherwise start (startTimer stops any other running entry in the
  // same transaction — same implicit-switch semantics as the MCP op).
  const client_id = Number(args.client_id)
  const project_id = asProjectId(args.project_id, null)
  const description = asString(args.description)
  const client = db.prepare(`SELECT id FROM clients WHERE id = ?`).get(client_id) as
    | { id: number }
    | undefined
  if (!client) return err('invalid', 'Kunde existiert nicht')
  if (project_id != null) {
    const pErr = validateProjectForClient(db, project_id, client_id)
    if (pErr) return err('invalid', pErr)
  }

  const running = readRunning(db)
  const matches =
    running !== null &&
    running.client_id === client_id &&
    (running.project_id ?? null) === project_id

  if (req.preview) {
    return {
      ok: true,
      data: {
        preview: true,
        action: matches ? 'stop' : running ? 'switch' : 'start',
        client_id,
        project_id,
        running
      }
    }
  }

  await ctx.ensureBackup()

  if (matches) {
    const r = stopRunningTimer(db)
    if (!r.ok) return err('invalid', r.error)
    ctx.onChange()
    ctx.audit({
      op: 'toggle_timer',
      source: 'controller',
      id: r.data?.id ?? null,
      client_id
    })
    ctx.emitWebhook?.('stop_running_timer', r.data)
    return { ok: true, data: { action: 'stopped', entry: r.data } }
  }

  const r = startTimer(db, {
    client_id,
    description,
    started_at: new Date().toISOString(),
    project_id
  })
  if (!r.ok) return err('invalid', r.error)
  ctx.onChange()
  ctx.audit({
    op: 'toggle_timer',
    source: 'controller',
    id: r.data?.id ?? null,
    client_id,
    started_at: r.data?.started_at ?? null
  })
  ctx.emitWebhook?.('start_timer', r.data)
  return { ok: true, data: { action: running ? 'switched' : 'started', entry: r.data } }
}

/**
 * Guarded request handler. Order: shape → token → opt-in → allowlist → plan →
 * (preview short-circuits here) → confirm → backup → execute → broadcast + audit.
 * Controller-token requests branch into `handleControllerRequest` after the
 * token check; the two token scopes never unlock each other's ops.
 */
export async function handleRequest(ctx: BridgeCtx, req: BridgeRequest): Promise<BridgeResponse> {
  if (!req || req.v !== 1 || typeof req.op !== 'string') {
    return err('invalid', 'Ungültige Anfrage')
  }
  const mcpAuth = !!ctx.token && req.token === ctx.token
  const controllerAuth = !!ctx.controllerToken && req.token === ctx.controllerToken
  if (!mcpAuth && !controllerAuth) {
    return err('bad_token', 'Ungültiges oder fehlendes Token')
  }
  if (controllerAuth) {
    return handleControllerRequest(ctx, req)
  }
  if (!ctx.isWriteEnabled()) {
    return err('write_disabled', 'Schreibzugriff ist deaktiviert (Einstellungen → Integrationen)')
  }
  if (!(WRITE_OPS as readonly string[]).includes(req.op)) {
    return err('not_allowed', `Operation nicht erlaubt: ${req.op}`)
  }

  const plan = planOp(ctx.db, req.op as WriteOp, req.args ?? {})
  if ('error' in plan) return err('invalid', plan.error)

  if (req.preview) {
    return { ok: true, data: { preview: true, ...plan.preview } }
  }

  const approved = await ctx.confirm(plan.summary)
  if (!approved) return err('confirm_declined', 'Änderung wurde in TimeTrack abgelehnt')

  await ctx.ensureBackup()

  const result = plan.run()
  if (!result.ok) return err('invalid', result.error)

  ctx.onChange()
  ctx.audit(plan.audit(result.data))
  // Same emission point as the IPC handlers, one level up from the mutation.
  ctx.emitWebhook?.(req.op as WriteOp, result.data)
  return { ok: true, data: result.data }
}
