/**
 * Shared webhook target schema + tolerant parser (v1.15 #134).
 *
 * The list of outbound-webhook targets lives as ONE JSON blob in the
 * `settings` table (key `webhook_targets`), exactly like `export_prefs`. Both
 * the renderer (settings UI) and the main process (delivery) need the same
 * shape and the same field-wise validation, so it lives here in shared/ with
 * no Electron, no crypto and no DB import.
 *
 * `parseWebhookTargets` NEVER throws and NEVER trusts the stored string blindly:
 * a corrupt blob, a non-array, a target without a usable URL or an unknown
 * event name must degrade to a safe value (drop the offending item / fall back
 * to []) instead of crashing a timer start or the settings view. This mirrors
 * the deliberately defensive `parsePrefs` in exportPrefs.ts.
 */

/** The four mutation moments a target can subscribe to. */
export const WEBHOOK_EVENTS = [
  'timer.started',
  'timer.stopped',
  'entry.created',
  'entry.updated'
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

export interface WebhookTarget {
  /** Stable id — React key in the UI, correlation id in the delivery log. */
  id: string
  /** Absolute http(s) endpoint. A target without one is dropped on parse. */
  url: string
  /** HMAC secret; '' means "sign nothing" (no signature header). */
  secret: string
  /** Subset of WEBHOOK_EVENTS this target wants. Unknown names are dropped. */
  events: WebhookEvent[]
  /** Only enabled targets ever fire. Missing/!== true ⇒ off (safe default). */
  enabled: boolean
  /**
   * Q32: the secret lives in the encrypted secret store, not in this blob
   * (`secret` is '' in the database). Not a secret itself.
   */
  secretStored?: boolean
  /**
   * Q32: the secret is stored but cannot be read on this machine (a restore
   * elsewhere, a changed key). Set on the way to the window and the delivery,
   * never stored; such a target is not delivered until a new secret is entered.
   */
  secretUnreadable?: boolean
}

function isWebhookEvent(v: unknown): v is WebhookEvent {
  return typeof v === 'string' && (WEBHOOK_EVENTS as readonly string[]).includes(v)
}

/** A url we are willing to POST to: a syntactically valid http/https URL. */
export function isValidWebhookUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.trim() === '') return false
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Generate a target id. Web Crypto is present in both the renderer and Node ≥18. */
export function newWebhookTargetId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  // Fallback for the unlikely case Web Crypto is unavailable — collision-safe
  // enough for a local settings list, and never security-relevant.
  return `wh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Parse the stored `webhook_targets` blob into a validated list. Invalid
 * targets are dropped rather than repaired: a target with no usable URL can't
 * be delivered anyway, and silently keeping half of it would hide the problem.
 */
export function parseWebhookTargets(raw: string | null | undefined): WebhookTarget[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: WebhookTarget[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const t = item as Record<string, unknown>
    if (!isValidWebhookUrl(t.url)) continue // no URL ⇒ undeliverable ⇒ drop
    const events = Array.isArray(t.events) ? t.events.filter(isWebhookEvent) : []
    out.push({
      id: typeof t.id === 'string' && t.id !== '' ? t.id : newWebhookTargetId(),
      url: t.url,
      secret: typeof t.secret === 'string' ? t.secret : '',
      events,
      // Safe default: only an explicit `true` arms a target. A blob missing the
      // flag never fires by accident.
      enabled: t.enabled === true,
      ...(t.secretStored === true ? { secretStored: true } : {}),
      ...(t.secretUnreadable === true ? { secretUnreadable: true } : {})
    })
  }
  return out
}

/** Serialize back to the JSON blob stored under the `webhook_targets` key. */
export function serializeWebhookTargets(targets: WebhookTarget[]): string {
  return JSON.stringify(targets)
}
