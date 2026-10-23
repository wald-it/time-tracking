/**
 * Teams presence mirroring (#132) — state-driven, never event-driven.
 *
 * `reconcilePresence` is poked whenever the timer state may have changed (the
 * `tray:update` choke point covers every source: UI, tray, hotkey, mini-widget,
 * idle handlers, and — via the renderer resync — MCP writes and hardware keys).
 * It compares the DESIRED status message with the last one it applied and only
 * then talks to Graph. That makes it idempotent, cheap to poke, and immune to
 * the "stop happened via entries:update" class of blind spots an event hook
 * would have.
 *
 * Ownership rule: this module only ever clears a message it set itself. Before
 * clearing it reads the message back and leaves it alone when the user has
 * written their own in the meantime (#316); after a restart, when the exact
 * text is gone, it recognises a leftover by the shape desiredMessage produces
 * (#317). Our Busy session (sessionId = our client id) is always ours.
 *
 * Failures are logged and swallowed — presence must never affect the timer.
 * The applied state is only updated on success, so the next poke retries.
 *
 * Docs (verified 2026-07-29): POST /users/{id}/presence/setStatusMessage,
 * delegated scope Presence.ReadWrite, v1.0; personal Microsoft accounts are
 * "Not supported."; the only documented request form is /users/{id}/… — the
 * signed-in user's GUID is resolved once per run via GET /me?$select=id.
 * Clearing via empty content is community-established but undocumented.
 */
import type { RunningStatus } from './mcpBridgeCore'

export interface PresenceAccountView {
  connected: boolean
  personalAccount: boolean
  grantedScopes: string[]
}

export interface PresenceDeps {
  getSetting: (key: string) => string | undefined
  getAccountStatus: () => PresenceAccountView
  getAccessToken: () => Promise<string | null>
  /** The effective app client id — doubles as the presence session id. */
  getClientId: () => string
  fetchFn?: typeof fetch
  now?: () => number
  log?: (message: string) => void
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const REQUEST_TIMEOUT_MS = 15_000
/** Safety net: a crashed app must not leave "Fokus" standing forever. */
const EXPIRY_MS = 12 * 60 * 60 * 1000
/**
 * Presence sessions expire (PT5M–PT4H); we request PT1H and re-apply the
 * unchanged state every ~25 minutes. The 30-second heartbeat pokes make this
 * renewal reliable while a timer runs.
 */
const SESSION_DURATION = 'PT1H'
const REFRESH_AFTER_MS = 25 * 60 * 1000

interface AppliedState {
  /** The message content last successfully applied; '' after a clear; null = never touched. */
  message: string | null
  at: number
  userId: string | null
  /**
   * Whether this run has looked for a status a previous run left behind
   * (#317). The applied state lives in memory only, so after a crash or quit
   * nothing else would ever withdraw it.
   */
  swept: boolean
}

const state: AppliedState = { message: null, at: 0, userId: null, swept: false }

/** Test-only: forget everything this module has applied. */
export function resetPresenceStateForTests(): void {
  state.message = null
  state.at = 0
  state.userId = null
  state.swept = false
}

/**
 * Every message desiredMessage can produce: "🔴 Fokus" / "🔴 Focus", alone or
 * with ": client" and an optional " — project". Used to recognise our own
 * leftover after a restart (#317), when the exact text is no longer known.
 */
const OWN_MESSAGE = /^🔴 (Fokus|Focus)(: .+)?$/u

/**
 * Compare-ready form of a status message. How Graph returns a message set as
 * contentType "text" has not been observed against a real tenant: as set, or
 * HTML-wrapped (`<p>…</p>`, `&nbsp;`). Both reduce to the same plain text.
 */
function plainMessage(content: string): string {
  return content
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function scopeGranted(view: PresenceAccountView): boolean {
  return view.grantedScopes.some((s) => s.toLowerCase() === 'presence.readwrite')
}

/** The status message the current state calls for; '' means "clear". */
export function desiredMessage(
  running: Pick<RunningStatus, 'client_name' | 'project_name'> | null,
  showClient: boolean,
  language: string
): string {
  if (!running) return ''
  const focus = language === 'en' ? 'Focus' : 'Fokus'
  if (!showClient) return `🔴 ${focus}`
  const project = running.project_name ? ` — ${running.project_name}` : ''
  return `🔴 ${focus}: ${running.client_name}${project}`
}

/** UTC dateTimeTimeZone for Graph ("dateTime shouldn't include time zone"). */
function expiryAt(nowMs: number): { dateTime: string; timeZone: string } {
  return { dateTime: new Date(nowMs + EXPIRY_MS).toISOString().replace('Z', ''), timeZone: 'UTC' }
}

async function resolveUserId(
  fetchFn: typeof fetch,
  token: string,
  log: (m: string) => void
): Promise<string | null> {
  if (state.userId) return state.userId
  try {
    const res = await fetchFn(`${GRAPH_BASE}/me?$select=id`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!res.ok) {
      log(`presence: /me lookup failed with HTTP ${res.status}`)
      return null
    }
    const body = (await res.json()) as { id?: unknown }
    state.userId = typeof body.id === 'string' ? body.id : null
    return state.userId
  } catch (err) {
    log(`presence: /me lookup failed (${err instanceof Error ? err.name : 'error'})`)
    return null
  }
}

/**
 * Bring the Teams status message in line with the current timer state.
 * Safe to call often; talks to Graph only when something actually changed.
 */
export async function reconcilePresence(
  deps: PresenceDeps,
  running: RunningStatus | null
): Promise<void> {
  const log = deps.log ?? ((): void => {})
  const now = deps.now?.() ?? Date.now()
  const enabled = deps.getSetting('presence_enabled') === '1'
  // First poke of a run with the feature on and nothing applied yet: look for
  // a status a crashed or quit run left behind (#317).
  const sweepDue = enabled && !state.swept && state.message === null

  // Feature off: leave Teams alone — except to withdraw our own last message.
  const wantsClear = !enabled || running === null
  if (wantsClear && (state.message === null || state.message === '') && !sweepDue) return

  const view = deps.getAccountStatus()
  if (!view.connected || view.personalAccount) return
  if (!scopeGranted(view)) {
    log('presence: Presence.ReadWrite not granted — reconnect required')
    return
  }

  const message = wantsClear
    ? ''
    : desiredMessage(
        running,
        deps.getSetting('presence_show_client') === '1',
        deps.getSetting('language') ?? 'de'
      )
  const unchanged = state.message === message
  const fresh = now - state.at < REFRESH_AFTER_MS
  if (unchanged && (message === '' || fresh)) return

  const fetchFn = deps.fetchFn ?? fetch
  const token = await deps.getAccessToken()
  if (!token) return
  const userId = await resolveUserId(fetchFn, token, log)
  if (!userId) return

  const post = async (action: string, payload: unknown): Promise<boolean> => {
    try {
      const res = await fetchFn(
        `${GRAPH_BASE}/users/${encodeURIComponent(userId)}/presence/${action}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        }
      )
      // clearPresence answers 404 when no session exists — nothing to clear
      // counts as cleared.
      if (res.ok || (action === 'clearPresence' && res.status === 404)) return true
      log(`presence: ${action} failed with HTTP ${res.status}`)
      return false
    } catch (err) {
      log(`presence: ${action} failed (${err instanceof Error ? err.name : 'error'})`)
      return false
    }
  }

  const sessionId = deps.getClientId()
  const clearMessage = (): Promise<boolean> =>
    post('setStatusMessage', { statusMessage: { message: { content: '', contentType: 'text' } } })

  if (sweepDue && running === null) {
    // Nothing applied in this run, no timer: only a leftover can need
    // withdrawing. Recognised by its shape, since its exact text is gone with
    // the previous run; a message the user wrote is left alone.
    const current = await readPresence(fetchFn, token, userId, log)
    if (!current) return // retried at the next poke
    if (current.content !== null && OWN_MESSAGE.test(plainMessage(current.content))) {
      if (!((await clearMessage()) && (await post('clearPresence', { sessionId })))) return
      log('presence: withdrew a status message left from a previous run')
    }
    state.swept = true
    return
  }
  // A timer runs at the first poke: the set below replaces any leftover.
  state.swept = true

  let ok: boolean
  if (message === '') {
    // Clear only a message that is still ours (#316): the user may have
    // written their own in Teams while the timer ran. Our Busy session is
    // ours by definition and always ends.
    const current = await readPresence(fetchFn, token, userId, log)
    if (!current) return // retried at the next poke; erring toward keeping the user's text
    const ours =
      current.content !== null &&
      state.message !== null &&
      plainMessage(current.content) === plainMessage(state.message)
    if (current.content !== null && !ours) {
      log('presence: status message was changed in Teams — left as is')
    }
    ok = (!ours || (await clearMessage())) && (await post('clearPresence', { sessionId }))
  } else {
    // Busy/InACall is the only plain-"red" combination setPresence accepts;
    // DoNotDisturb/Presenting would suppress the user's notifications.
    ok =
      (await post('setStatusMessage', {
        statusMessage: {
          message: { content: message, contentType: 'text' },
          expiryDateTime: expiryAt(now)
        }
      })) &&
      (await post('setPresence', {
        sessionId,
        availability: 'Busy',
        activity: 'InACall',
        expirationDuration: SESSION_DURATION
      }))
  }
  if (!ok) return
  state.message = message
  state.at = now
  log(
    message === ''
      ? 'presence: cleared (session, message if ours)'
      : 'presence: set (message + Busy)'
  )
  await readBack(fetchFn, token, userId, message, log)
}

interface PresenceView {
  availability: string | null
  /** The status message as Graph returns it; null when there is none. */
  content: string | null
}

/** GET the signed-in user's presence; null when it could not be read. */
async function readPresence(
  fetchFn: typeof fetch,
  token: string,
  userId: string,
  log: (m: string) => void
): Promise<PresenceView | null> {
  try {
    const res = await fetchFn(`${GRAPH_BASE}/users/${encodeURIComponent(userId)}/presence`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!res.ok) {
      log(`presence: read failed with HTTP ${res.status}`)
      return null
    }
    const body = (await res.json()) as {
      availability?: unknown
      statusMessage?: { message?: { content?: unknown } } | null
    }
    const content = body.statusMessage?.message?.content
    return {
      availability: typeof body.availability === 'string' ? body.availability : null,
      content: typeof content === 'string' && plainMessage(content) !== '' ? content : null
    }
  } catch (err) {
    log(`presence: read failed (${err instanceof Error ? err.name : 'error'})`)
    return null
  }
}

/**
 * Read the presence back after a write and log what Graph ACTUALLY stored.
 * A 200 on setStatusMessage alone proves nothing — this makes a silent
 * no-op visible in the log instead of looking like success. It logs whether
 * the message is ours, never its text: that names clients and projects and
 * has no place in main.log (#318).
 */
async function readBack(
  fetchFn: typeof fetch,
  token: string,
  userId: string,
  expected: string,
  log: (m: string) => void
): Promise<void> {
  const current = await readPresence(fetchFn, token, userId, log)
  if (!current) return
  const message =
    current.content === null
      ? 'none'
      : expected !== '' && plainMessage(current.content) === plainMessage(expected)
        ? 'matches'
        : 'differs'
  log(`presence: read-back availability=${String(current.availability)} statusMessage=${message}`)
}
