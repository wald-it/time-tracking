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
import { localeFromSetting } from '../shared/i18n'

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
  /**
   * The last message Teams accepted from us, even when the Busy session in
   * the same set then failed: it is in Teams and ours, but `message` still
   * holds the previous text.
   */
  sent: string | null
  /**
   * The sweep withdrew a leftover message but ending the old Busy session
   * failed: the next sweep must end it even though the message, its only
   * trace, is gone and a manual availability may hide the Busy.
   */
  sessionPending: boolean
}

const state: AppliedState = {
  message: null,
  at: 0,
  userId: null,
  swept: false,
  sent: null,
  sessionPending: false
}

/** Test-only: forget everything this module has applied. */
export function resetPresenceStateForTests(): void {
  state.message = null
  state.at = 0
  state.userId = null
  state.swept = false
  state.sent = null
  state.sessionPending = false
  queue = Promise.resolve()
  latest = 0
}

/**
 * Every message desiredMessage can produce: "🔴 Fokus" / "🔴 Focus", alone or
 * with ": client" and an optional " — project". Used to recognise our own
 * leftover after a restart (#317), when the exact text is no longer known.
 */
const OWN_MESSAGE = /^🔴 (Fokus|Focus)(: .+)?$/u

function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** A numeric entity's character, or the entity unchanged when it names none. */
function codePoint(code: number, raw: string): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw
}

/**
 * Graph content of contentType "html" as plain text. How Graph returns a
 * message set as contentType "text" has not been observed against a real
 * tenant: as set, or as HTML (`<p>…</p>`, `&nbsp;`, entities). Graph names the
 * form in `contentType`, and only "html" is decoded: a user's plain "<OOO>"
 * stays text.
 */
function fromHtml(content: string): string {
  return flat(
    content
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, (raw, hex: string) => codePoint(parseInt(hex, 16), raw))
      .replace(/&#(\d+);/g, (raw, dec: string) => codePoint(Number(dec), raw))
      .replace(/&amp;/g, '&')
  )
}

/** Whether the message Teams holds (as plain text) is one we set. */
function isMessage(text: string, own: string): boolean {
  return text === flat(own)
}

/** Whether the message Teams holds has the shape of one we set (#317). */
function looksOurs(text: string): boolean {
  return OWN_MESSAGE.test(text)
}

function scopeGranted(view: PresenceAccountView): boolean {
  return view.grantedScopes.some((s) => s.toLowerCase() === 'presence.readwrite')
}

/** The status message the current state calls for; '' means "clear". */
export function desiredMessage(
  running: Pick<RunningStatus, 'client_name' | 'project_name'> | null,
  showClient: boolean,
  language: string | undefined
): string {
  if (!running) return ''
  const focus = localeFromSetting(language) === 'en' ? 'Focus' : 'Fokus'
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
 * Pokes are fire-and-forget (index.ts), and one reconcile awaits several
 * requests. Without a queue a start-up sweep still reading could clear the
 * message a parallel poke had just set; so every reconcile waits for the one
 * before it. Only the newest poke's snapshot is worth applying: a queued one
 * that has been overtaken returns at once, so a slow network neither builds
 * up a backlog nor replays stale timer states.
 */
let queue: Promise<void> = Promise.resolve()
let latest = 0

/**
 * Bring the Teams status message in line with the current timer state.
 * Safe to call often; talks to Graph only when something actually changed.
 */
export function reconcilePresence(
  deps: PresenceDeps,
  running: RunningStatus | null
): Promise<void> {
  const ticket = ++latest
  // The caller fires and forgets: whatever throws in here (a setting read
  // while the DB closes at quit, say) ends as a log line.
  const run = queue
    .then(() => (ticket === latest ? reconcileOnce(deps, running) : undefined))
    .catch((err: unknown) => {
      deps.log?.(`presence: reconcile failed (${err instanceof Error ? err.name : 'error'})`)
    })
  queue = run
  return run
}

async function reconcileOnce(deps: PresenceDeps, running: RunningStatus | null): Promise<void> {
  const log = deps.log ?? ((): void => {})
  const now = deps.now?.() ?? Date.now()
  const enabled = deps.getSetting('presence_enabled') === '1'
  // First poke of a run with the feature on and nothing applied yet: look for
  // a status a crashed or quit run left behind (#317).
  const sweepDue = enabled && !state.swept && state.message === null

  // Feature off: leave Teams alone — except to withdraw our own last message.
  const wantsClear = !enabled || running === null
  if (
    wantsClear &&
    (state.message === null || state.message === '') &&
    !sweepDue &&
    !state.sessionPending
  ) {
    return
  }

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
        deps.getSetting('language')
      )
  const unchanged = state.message === message
  const fresh = now - state.at < REFRESH_AFTER_MS
  if (unchanged && (message === '' || fresh) && !state.sessionPending) return

  const fetchFn = deps.fetchFn ?? fetch
  // The caller fires and forgets (index.ts): a refresh that throws (offline)
  // must end here as a log line, not as an unhandled rejection.
  let token: string | null
  try {
    token = await deps.getAccessToken()
  } catch (err) {
    log(`presence: no access token (${err instanceof Error ? err.name : 'error'})`)
    return
  }
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

  // Intents are recorded BEFORE the request they belong to, and dropped only
  // on confirmed success: a request can reach Teams and still fail on the way
  // back (timeout), and a failed one must stay due.
  if (state.sessionPending && !enabled) {
    // A session end the sweep still owes. Ending our own session is never
    // unasked-for, so it runs with the feature switched off, too.
    if (await post('clearPresence', { sessionId })) state.sessionPending = false
    return
  }

  if (sweepDue && running === null) {
    // Nothing applied in this run, no timer: only a leftover can need
    // withdrawing. The message is recognised by its shape, since its exact
    // text is gone with the previous run; a message the user wrote is left
    // alone. Our Busy session ends whenever Teams shows Busy, too: the user may
    // have replaced the message, or a previous clear may have stopped
    // half-way. (Ending our own session cannot touch anyone else's Busy.)
    const current = await readPresence(fetchFn, token, userId, log)
    if (!current) return // retried at the next poke
    const leftover = current.text !== null && looksOurs(current.text)
    if (leftover || current.availability === 'Busy') state.sessionPending = true
    if (leftover) {
      if (!(await clearMessage())) return
      log('presence: withdrew a status message left from a previous run')
    }
    if (state.sessionPending) {
      if (!(await post('clearPresence', { sessionId }))) return
      state.sessionPending = false
    }
    state.swept = true
    return
  }

  let ok: boolean
  if (message === '') {
    // Clear only a message that is still ours (#316): the user may have
    // written their own in Teams while the timer ran. Our Busy session is
    // ours by definition and always ends.
    const current = await readPresence(fetchFn, token, userId, log)
    if (!current) {
      // The message waits for a successful read (erring toward keeping the
      // user's text) and is retried at the next poke; Busy ends now. The
      // session is gone, so the next set must not count as a fresh repeat.
      if (await post('clearPresence', { sessionId })) {
        state.at = 0
        log('presence: ended the session; the status message waits for a read')
      }
      return
    }
    const ours =
      current.text !== null &&
      [state.message, state.sent].some((own) => !!own && isMessage(current.text!, own))
    if (current.text !== null && !ours) {
      log('presence: status message was changed in Teams — left as is')
    }
    ok = (!ours || (await clearMessage())) && (await post('clearPresence', { sessionId }))
  } else {
    // Busy/InACall is the only plain-"red" combination setPresence accepts;
    // DoNotDisturb/Presenting would suppress the user's notifications.
    // Ours from the moment it is sent: a write whose answer is lost may well
    // have reached Teams. An unsent candidate only widens the "is it ours"
    // match at stop, which is harmless.
    state.sent = message
    const accepted = await post('setStatusMessage', {
      statusMessage: {
        message: { content: message, contentType: 'text' },
        expiryDateTime: expiryAt(now)
      }
    })
    ok =
      accepted &&
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
  // Our session was just replaced (set) or ended (clear): nothing owed.
  state.sessionPending = false
  // Only now: a set that failed must leave a crash leftover to the sweep.
  state.swept = true
  if (message === '') {
    state.sent = null
    // The read before the clear already showed what Teams held.
    log('presence: cleared (session, message if ours)')
    return
  }
  log('presence: set (message + Busy)')
  await readBack(fetchFn, token, userId, message, log)
}

interface PresenceView {
  availability: string | null
  /**
   * The status message as plain, whitespace-normalised text (decoded only
   * when Graph says it is HTML); null when there is none.
   */
  text: string | null
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
      statusMessage?: { message?: { content?: unknown; contentType?: unknown } } | null
    }
    const content = body.statusMessage?.message?.content
    const html =
      typeof body.statusMessage?.message?.contentType === 'string' &&
      body.statusMessage.message.contentType.toLowerCase() === 'html'
    const text = typeof content === 'string' ? (html ? fromHtml(content) : flat(content)) : ''
    return {
      availability: typeof body.availability === 'string' ? body.availability : null,
      text: text === '' ? null : text
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
    current.text === null ? 'none' : isMessage(current.text, expected) ? 'matches' : 'differs'
  log(`presence: read-back availability=${String(current.availability)} statusMessage=${message}`)
}
