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
 * Intents (#331): what this run may own or still owes in Teams is recorded
 * BEFORE the request that could create it and dropped only on a confirmed
 * result. A request can reach Teams and lose its answer; treating that as
 * "nothing happened" left messages and Busy sessions behind in every order
 * the reviews of #316–#318 found. graphPresence.sequences.test.ts drives
 * random failure sequences against these rules.
 *
 * One pass per poke, never a retry loop: whatever is still owed waits for the
 * next poke. Signed out, without the scope or without a token, nothing is
 * sent at all — a clean-up never asks for a sign-in.
 *
 * Failures are logged and swallowed — presence must never affect the timer.
 *
 * Docs (verified 2026-07-29): POST /users/{id}/presence/setStatusMessage,
 * delegated scope Presence.ReadWrite, v1.0; personal Microsoft accounts are
 * "Not supported."; the only documented request form is /users/{id}/… — the
 * signed-in user's GUID is resolved once per run via GET /me?$select=id.
 * Clearing via empty content is community-established but undocumented.
 */
import type { RunningStatus } from './mcpBridgeCore'
import { hasScope, PRESENCE_SCOPE } from '../shared/graphAuth'
import type { Locale } from '../shared/i18n'

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
  /**
   * The app language for the Teams status text (#347): index.ts passes
   * mainI18n.appLocale, the one way to the language in the main process.
   */
  getLocale: () => Locale
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
/**
 * How many unconfirmed texts are remembered exactly. Every text we send has
 * our form, so dropping the oldest falls back to recognising it by shape
 * (`shapeOwed`), like a leftover after a restart: the only cost is the one
 * the shape already has, a message the user typed in exactly our form.
 */
const MAX_POSSIBLY_OURS = 8

interface Intents {
  /**
   * The full status (message + Busy) last confirmed for a running timer, so an
   * unchanged state is not re-sent; null when none is confirmed. Never the
   * basis for clearing: that is `possiblyOurs`.
   */
  applied: string | null
  at: number
  userId: string | null
  /**
   * Every text sent with setStatusMessage since the last confirmed state,
   * whatever the answer: each may be in Teams now. Added before the request,
   * narrowed by a confirmed set, emptied once a read shows none of them left.
   */
  possiblyOurs: Set<string>
  /**
   * A message of ours may be in Teams whose exact text is not known: the
   * start-up read found one in our form, left by a previous run (#317), or a
   * sent text was dropped from `possiblyOurs`. Withdraw a message in our form.
   */
  shapeOwed: boolean
  /**
   * Our Busy session may exist: set before every setPresence and when the
   * start-up read shows Busy; dropped only when clearPresence is confirmed.
   */
  sessionOwed: boolean
  /** Whether this run has done its start-up read (#317). */
  checked: boolean
}

const state: Intents = {
  applied: null,
  at: 0,
  userId: null,
  possiblyOurs: new Set(),
  shapeOwed: false,
  sessionOwed: false,
  checked: false
}

/** Test-only: forget everything — what a crash or quit does to this module. */
export function resetPresenceStateForTests(): void {
  state.applied = null
  state.at = 0
  state.userId = null
  state.possiblyOurs = new Set()
  state.shapeOwed = false
  state.sessionOwed = false
  state.checked = false
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
 * Named entities an HTML-returning Graph may use for what our messages and
 * client names contain: the " — " before the project, quotes and
 * apostrophes, umlauts, ß, common accents, €. A whitelist: a client name with
 * a character named by an entity not listed here is not recognised exactly
 * (only by form, see `shapeOwed`). A Map, so "&constructor;" is no lookup
 * into Object.prototype. `&amp;` is decoded last, so `&amp;lt;` stays "&lt;".
 */
const NAMED_ENTITIES = new Map<string, string>(
  Object.entries({
    nbsp: ' ',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    mdash: '—',
    ndash: '–',
    hellip: '…',
    bull: '•',
    middot: '·',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    bdquo: '„',
    sbquo: '‚',
    laquo: '«',
    raquo: '»',
    euro: '€',
    copy: '©',
    reg: '®',
    trade: '™',
    auml: 'ä',
    ouml: 'ö',
    uuml: 'ü',
    Auml: 'Ä',
    Ouml: 'Ö',
    Uuml: 'Ü',
    szlig: 'ß',
    aacute: 'á',
    agrave: 'à',
    acirc: 'â',
    eacute: 'é',
    egrave: 'è',
    ecirc: 'ê',
    euml: 'ë',
    iacute: 'í',
    icirc: 'î',
    oacute: 'ó',
    ocirc: 'ô',
    oslash: 'ø',
    uacute: 'ú',
    ucirc: 'û',
    ccedil: 'ç',
    ntilde: 'ñ',
    aring: 'å',
    aelig: 'æ',
    Aacute: 'Á',
    Agrave: 'À',
    Eacute: 'É',
    Egrave: 'È',
    Oslash: 'Ø',
    Ccedil: 'Ç',
    Aring: 'Å',
    AElig: 'Æ'
  })
)

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
      .replace(/&([a-z]+);/gi, (raw, name: string) => NAMED_ENTITIES.get(name) ?? raw)
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

/** Remember a text as possibly ours, before the request that sends it. */
function rememberSent(text: string): void {
  state.possiblyOurs.delete(text) // re-insert as the newest
  state.possiblyOurs.add(text)
  while (state.possiblyOurs.size > MAX_POSSIBLY_OURS) {
    const oldest = state.possiblyOurs.values().next().value as string
    state.possiblyOurs.delete(oldest)
    state.shapeOwed = true
  }
}

function scopeGranted(view: PresenceAccountView): boolean {
  return hasScope(view.grantedScopes, PRESENCE_SCOPE)
}

/** The status message the current state calls for; '' means "clear". */
export function desiredMessage(
  running: Pick<RunningStatus, 'client_name' | 'project_name'> | null,
  showClient: boolean,
  locale: Locale
): string {
  if (!running) return ''
  const focus = locale === 'en' ? 'Focus' : 'Fokus'
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
 * requests. Without a queue a start-up read still running could clear the
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
  // Our status is wanted only with the feature on and a timer running.
  // Everything else is a clean-up, which also runs with the feature off:
  // withdrawing our own message and ending our own session is never
  // unasked-for.
  const want = enabled && running !== null
  // The first poke of a run with the feature on looks for a status a crashed
  // or quit run left behind (#317).
  const checkDue = enabled && !state.checked
  const owes = state.possiblyOurs.size > 0 || state.shapeOwed || state.sessionOwed

  const message = want
    ? desiredMessage(running, deps.getSetting('presence_show_client') === '1', deps.getLocale())
    : ''
  if (!checkDue) {
    if (!want && !owes) return
    if (
      want &&
      state.applied === message &&
      now - state.at < REFRESH_AFTER_MS &&
      !state.shapeOwed &&
      state.possiblyOurs.size === 1 &&
      state.possiblyOurs.has(message)
    ) {
      return
    }
  }

  const view = deps.getAccountStatus()
  if (!view.connected || view.personalAccount) return
  if (!scopeGranted(view)) {
    log('presence: Presence.ReadWrite not granted — reconnect required')
    return
  }

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

  let current: PresenceView | null = null
  if (checkDue) {
    current = await readPresence(fetchFn, token, userId, log)
    if (current) {
      state.checked = true
      // A message in our shape may be a previous run's: owe its withdrawal (a
      // set below replaces it anyway). A previous run's Busy session cannot be
      // read reliably: any availability the user sets (Away, Do not disturb,
      // even a manual Available) hides it. So every run ends our own session
      // once — one request per start, answered 404 when there is none.
      if (current.text !== null && looksOurs(current.text)) state.shapeOwed = true
      state.sessionOwed = true
    } else if (!want) {
      return // retried at the next poke
    }
    // With a timer running the read is not needed: a confirmed set below
    // replaces any leftover message and our session. It must not hold the set.
  }

  if (want) {
    // Unconfirmed from here until both writes succeed: a set that fails
    // half-way must not look like an unchanged state to the next poke.
    state.applied = null
    rememberSent(message)
    const accepted = await post('setStatusMessage', {
      statusMessage: {
        message: { content: message, contentType: 'text' },
        expiryDateTime: expiryAt(now)
      }
    })
    if (!accepted) return
    // Confirmed: Teams now shows this text, whatever was there before.
    state.possiblyOurs = new Set([message])
    state.shapeOwed = false
    // Busy/InACall is the only plain-"red" combination setPresence accepts;
    // DoNotDisturb/Presenting would suppress the user's notifications.
    state.sessionOwed = true
    const busy = await post('setPresence', {
      sessionId,
      availability: 'Busy',
      activity: 'InACall',
      expirationDuration: SESSION_DURATION
    })
    if (!busy) return
    state.applied = message
    state.at = now
    // Message and session both replaced: no leftover of a previous run can
    // remain, so the start-up read is no longer owed.
    state.checked = true
    log('presence: set (message + Busy)')
    await readBack(fetchFn, token, userId, message, log)
    return
  }

  // Clean-up: withdraw what may be ours, keep what the user wrote (#316).
  state.applied = null
  if (state.possiblyOurs.size > 0 || state.shapeOwed) {
    current ??= await readPresence(fetchFn, token, userId, log)
    if (!current) {
      // The message waits for a read (erring toward keeping the user's text);
      // our session can end now.
      if (state.sessionOwed && (await post('clearPresence', { sessionId }))) {
        state.sessionOwed = false
        log('presence: ended the session; the status message waits for a read')
      }
      return
    }
    const text = current.text
    const exact = text !== null && [...state.possiblyOurs].some((own) => isMessage(text, own))
    const byShape = !exact && text !== null && state.shapeOwed && looksOurs(text)
    if (exact || byShape) {
      const cleared = await post('setStatusMessage', {
        statusMessage: { message: { content: '', contentType: 'text' } }
      })
      if (!cleared) return
      if (byShape) log('presence: withdrew a status message recognised by its form')
    } else if (text !== null) {
      log('presence: status message was changed in Teams — left as is')
    }
    // Teams holds nothing of ours now: cleared, or what it shows is not ours.
    state.possiblyOurs = new Set()
    state.shapeOwed = false
  }
  if (state.sessionOwed) {
    if (!(await post('clearPresence', { sessionId }))) return
    state.sessionOwed = false
    log('presence: cleared (session, message if ours)')
  }
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
