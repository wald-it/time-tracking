/**
 * Outbound-webhook delivery core (v1.15 #134).
 *
 * Deliberately Electron-free: it takes a better-sqlite3 handle structurally
 * (the `SqliteDb` interface the read-only MCP layer already uses), imports only
 * `crypto` plus shared helpers, and injects `fetch`/`sleep`/`log` so the whole
 * thing is unit-testable against an in-memory DB with a mocked network. It is
 * NOT wired into entryMutations.ts — that file stays a pure DB writer. Emission
 * happens one level up, at the two surfaces that reach the mutations (the IPC
 * handlers and the MCP write bridge), so a single call there covers every UI
 * path (tray, mini-widget, hotkey, idle) which all funnel through them.
 *
 * The cardinal rule: **emission must never throw, never block, never fail a
 * timer.** `emitWebhooks` is fire-and-forget — it returns void, swallows every
 * error (bad config, DNS failure, timeout, a throwing payload build) and lets
 * deliveries run detached. A misconfigured webhook can never cost the user a
 * time entry.
 */
import { createHmac } from 'crypto'
import type Database from 'better-sqlite3'
import { effectiveRateCent } from '../shared/currency'
import { deserializeTags } from '../shared/tags'
import { parseWebhookTargets, type WebhookEvent, type WebhookTarget } from '../shared/webhooks'
import { resolvePrivacy } from '../mcp/privacy'
import { readStoredPrivacy } from '../mcp/queries'
import type { PrivacyConfig } from '../mcp/privacy'
import type { Entry } from '../shared/types'
import type { WriteOp } from './mcpBridgeCore'
import type { WebhookLogRecord } from './webhookLog'

type Db = Database.Database

// ── payload ────────────────────────────────────────────────────────────────

interface PayloadEntry {
  id: number
  description: string
  started_at: string
  stopped_at: string | null
  /** Wall-clock seconds; null while a timer is still running. */
  duration_seconds: number | null
  billable: boolean
  tags: string[]
  reference: string
  client: { id: number; name: string } | null
  project: { id: number; name: string } | null
  // The next two mirror the MCP privacy gates: fields are OMITTED when their
  // gate is off — never sent as null (matches src/mcp/queries.ts shapeEntry).
  rate_cent?: number
  revenue_cent?: number
  private_note?: string
}

export interface WebhookPayload {
  event: WebhookEvent
  delivery_id: string
  timestamp: string
  entry: PayloadEntry
}

/** Map an MCP write op to the webhook event it emits. */
export function eventForWriteOp(op: WriteOp): WebhookEvent {
  switch (op) {
    case 'create_manual_entry':
      return 'entry.created'
    case 'update_entry_fields':
      return 'entry.updated'
    case 'start_timer':
      return 'timer.started'
    case 'stop_running_timer':
      return 'timer.stopped'
  }
}

/**
 * Build the delivery payload for one entry. Reads the client/project names (and,
 * when rates are exposed, the effective hourly rate = project.rate ?? client.rate)
 * straight from the DB so the receiver gets human-readable context, not bare ids.
 */
export function buildWebhookPayload(
  db: Db,
  event: WebhookEvent,
  entry: Entry,
  privacy: PrivacyConfig,
  opts: { deliveryId: string; now: number }
): WebhookPayload {
  const durationSeconds =
    entry.stopped_at === null
      ? null
      : Math.max(
          0,
          Math.floor((Date.parse(entry.stopped_at) - Date.parse(entry.started_at)) / 1000)
        )

  const clientRow = db
    .prepare(`SELECT id, name, rate_cent FROM clients WHERE id = ?`)
    .get(entry.client_id) as { id: number; name: string; rate_cent: number } | undefined

  const projectId = entry.project_id ?? null
  const projectRow =
    projectId === null
      ? undefined
      : (db.prepare(`SELECT id, name, rate_cent FROM projects WHERE id = ?`).get(projectId) as
          | { id: number; name: string; rate_cent: number | null }
          | undefined)

  const payloadEntry: PayloadEntry = {
    id: entry.id,
    description: entry.description,
    started_at: entry.started_at,
    stopped_at: entry.stopped_at ?? null,
    duration_seconds: durationSeconds,
    billable: entry.billable === 1,
    tags: deserializeTags(entry.tags),
    reference: entry.reference ?? '',
    client: clientRow ? { id: clientRow.id, name: clientRow.name } : null,
    project: projectRow ? { id: projectRow.id, name: projectRow.name } : null
  }

  if (privacy.exposeRates && clientRow) {
    // Money comes from billing_lines (design section 7): the rate valid on the
    // day and the fee per segment, summed over the entry's segments so a
    // minimum unit or interval applies per day. A running entry has no fee yet
    // and falls back to today's rate columns for the informational rate.
    const lines = db
      .prepare(
        `SELECT rate_cent, fee_cent FROM billing_lines WHERE entry_id = ? ORDER BY segment_seq`
      )
      .all(entry.id) as Array<{ rate_cent: number | null; fee_cent: number | null }>
    payloadEntry.rate_cent =
      lines[0]?.rate_cent ?? effectiveRateCent(projectRow?.rate_cent, clientRow.rate_cent)
    if (entry.stopped_at !== null) {
      // The amount the invoice bills; non-billable time earns nothing.
      payloadEntry.revenue_cent =
        entry.billable === 1 ? lines.reduce((sum, l) => sum + (l.fee_cent ?? 0), 0) : 0
    }
  }
  if (privacy.exposePrivateNotes) {
    payloadEntry.private_note = entry.private_note ?? ''
  }

  return {
    event,
    delivery_id: opts.deliveryId,
    timestamp: new Date(opts.now).toISOString(),
    entry: payloadEntry
  }
}

// ── signature ────────────────────────────────────────────────────────────

/**
 * HMAC-SHA256 of the RAW body string, as the `X-TimeTrack-Signature` value
 * (`sha256=<hex>`). It MUST be computed over the exact string that goes on the
 * wire — signing a re-serialized object is the classic way to ship a signature
 * the receiver can't reproduce.
 */
export function signBody(secret: string, rawBody: string): string {
  const hex = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  return `sha256=${hex}`
}

// ── delivery ─────────────────────────────────────────────────────────────

export interface DeliveryResult {
  ok: boolean
  status?: number
  attempts: number
  error?: string
}

export interface DeliveryDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  attempts?: number
  baseDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 1_000

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A status is worth retrying only on a transient server-side condition. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * POST the signed body with bounded retries. Retries on a network/timeout error
 * and on 429/5xx; a 4xx is treated as the user's own misconfiguration and is
 * NOT retried. Backoff grows exponentially between attempts. Never throws.
 */
export async function deliverWebhook(
  target: WebhookTarget,
  event: WebhookEvent,
  rawBody: string,
  deliveryId: string,
  deps: DeliveryDeps = {}
): Promise<DeliveryResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxAttempts = deps.attempts ?? DEFAULT_ATTEMPTS
  const baseDelayMs = deps.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const sleep = deps.sleep ?? defaultSleep

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'TimeTrack-Webhook',
    'X-TimeTrack-Event': event,
    'X-TimeTrack-Delivery': deliveryId
  }
  // No secret ⇒ no signature header at all (rather than an empty one).
  if (target.secret) headers['X-TimeTrack-Signature'] = signBody(target.secret, rawBody)

  let lastStatus: number | undefined
  let lastError: string | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(target.url, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(timeoutMs)
      })
      lastStatus = res.status
      if (res.ok) return { ok: true, status: res.status, attempts: attempt }
      if (!isRetryableStatus(res.status)) {
        // 4xx (or other non-transient) — the config is wrong, retrying won't help.
        return { ok: false, status: res.status, attempts: attempt, error: `http_${res.status}` }
      }
      lastError = `http_${res.status}`
    } catch (e) {
      // Network error / DNS failure / AbortSignal timeout — transient, retry.
      lastError = e instanceof Error ? e.name : 'network_error'
    }
    if (attempt < maxAttempts) await sleep(baseDelayMs * 2 ** (attempt - 1))
  }
  return { ok: false, status: lastStatus, attempts: maxAttempts, error: lastError }
}

// ── orchestration ────────────────────────────────────────────────────────

export interface EmitDeps extends DeliveryDeps {
  now?: () => number
  newDeliveryId?: () => string
  log?: (record: WebhookLogRecord) => void
}

/**
 * The tail of the delivery chain per target. Deliveries to one target run one
 * after another, so a receiver sees events in the order they were emitted even
 * when one of them needs a retry: a switch emits `timer.stopped` before
 * `timer.started`, and a stateful receiver that got them the other way round
 * would show a stopped timer. Different targets stay independent.
 */
const deliveryChains = new Map<string, Promise<void>>()

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * Fire outbound webhooks for a committed mutation. FIRE-AND-FORGET: builds the
 * payload once, then launches one detached delivery per matching+enabled target.
 * Returns immediately; deliveries settle on their own. Every failure path is
 * swallowed so a broken webhook can never surface to — let alone break — the
 * caller (the timer/entry mutation that just succeeded).
 *
 * `entry` may be null (e.g. stop_running_timer with nothing running) — then
 * there's nothing to deliver and we simply return.
 */
export function emitWebhooks(
  db: Db,
  event: WebhookEvent,
  entry: Entry | null,
  deps: EmitDeps = {}
): void {
  try {
    if (!entry) return
    const raw = db.prepare(`SELECT value FROM settings WHERE key = 'webhook_targets'`).get() as
      | { value: string }
      | undefined
    const targets = parseWebhookTargets(raw?.value).filter(
      (t) => t.enabled && t.events.includes(event)
    )
    if (targets.length === 0) return

    const privacy = resolvePrivacy(readStoredPrivacy(db))
    const now = deps.now ? deps.now() : Date.now()
    const newDeliveryId = deps.newDeliveryId
    // Logging is injected by the caller (webhookLog.ts). Kept out of this core
    // so the module stays free of electron-log and trivially unit-testable.
    const log = deps.log ?? ((): void => {})

    for (const target of targets) {
      // Per-target so one bad target can't abort the others, and the whole
      // block is inside try/catch so a build error can't reach the caller.
      const deliveryId = newDeliveryId ? newDeliveryId() : freshId()
      const payload = buildWebhookPayload(db, event, entry, privacy, { deliveryId, now })
      const rawBody = JSON.stringify(payload)
      const previous = deliveryChains.get(target.id) ?? Promise.resolve()
      const delivery = previous
        .then(() => deliverWebhook(target, event, rawBody, deliveryId, deps))
        .then((result) => {
          log({
            delivery_id: deliveryId,
            event,
            target_id: target.id,
            host: safeHost(target.url),
            ok: result.ok,
            status: result.status,
            attempts: result.attempts,
            error: result.error
          })
        })
        .catch(() => {
          // deliverWebhook never rejects, but guard anyway — a throwing logger
          // must not become an unhandled rejection.
        })
      deliveryChains.set(target.id, delivery)
      void delivery.then(() => {
        if (deliveryChains.get(target.id) === delivery) deliveryChains.delete(target.id)
      })
    }
  } catch {
    // Absolutely nothing about webhook emission may propagate to the mutation.
  }
}

function freshId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `dl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}
