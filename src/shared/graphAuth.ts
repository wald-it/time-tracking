/**
 * Microsoft Graph authentication — pure protocol logic (#130).
 *
 * Authorization Code + PKCE with a loopback redirect: the user clicks
 * "connect", the system browser opens Microsoft's sign-in page, and the reply
 * lands on a short-lived local listener. That is the flow behind the familiar
 * "connect your Microsoft account" button; the device-code flow this started
 * out as made the user re-type a code, and is additionally the flow most often
 * blocked by Conditional Access in company tenants.
 *
 * No Electron, no `fetch`, no clock, and no crypto here: everything is a total
 * function over its inputs, so the rotation rule and the expiry arithmetic can
 * be tested without a network. PKCE generation needs `node:crypto` and would
 * break the renderer (this module is renderer-safe, like `shared/webhooks.ts`),
 * so it lives in `src/main/graphAuth.ts` together with the I/O.
 *
 * Why hand-rolled instead of `@azure/msal-node`: this is a **public client** —
 * no client secret, nothing signed, no token parsed for a security decision. So
 * MSAL's `jsonwebtoken` subtree, which is what it pulls in along with seven
 * `lodash.*` packages, would be dead weight in a repo with twelve runtime
 * dependencies. What remains is two form POSTs, a URL, and one rotation rule.
 *
 * Protocol reference:
 * https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
 */

/** `common` also admits personal Microsoft accounts, which is the point (#130). */
export type GraphTenant = 'common' | 'organizations' | 'consumers' | (string & {})

export const DEFAULT_TENANT: GraphTenant = 'common'

/**
 * The app registration shipped with TimeTrack (wald-it, registered 2026-07-27).
 *
 * A public-client id is an identifier, not a secret: it is in every copy of the
 * installed app anyway, and without a user's own consent nothing can be read
 * with it. Tokens travel directly between the app and Microsoft — no server of
 * ours is involved at any point.
 *
 * Overridable in Settings → Integrationen, for tenants that refuse third-party
 * apps and for anyone who would rather use their own registration.
 *
 * Known limit (not a code problem): Entra's risk-based step-up consent blocks
 * *end users in other tenants* from consenting to a multitenant app registered
 * after 2020-11-08 whose publisher is unverified, once it asks for more than
 * basic sign-in — which `Calendars.Read` does. Until wald-it is a verified
 * publisher, users outside this registration's own tenant will see "Need admin
 * approval" instead of a consent prompt.
 * https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview
 */
export const DEFAULT_CLIENT_ID = '734cb982-f7b7-4dbf-91b1-cf95470bcd2a'

/**
 * Scopes for the calendar import.
 *
 * `offline_access` is what makes a refresh token be issued at all — without it
 * the connection dies with the first access token. `openid`/`profile` are only
 * there so the settings UI can name the connected account.
 *
 * Deliberately NOT here: `Presence.ReadWrite` for the Teams mirror (#132).
 * Asking for write access to someone's Teams presence while setting up a
 * calendar import would be the wrong order — that scope gets requested when the
 * feature is switched on, not before. #132 is parked anyway: presence is "Not
 * supported" for personal Microsoft accounts.
 */
export const CALENDAR_SCOPES = ['offline_access', 'openid', 'profile', 'Calendars.Read'] as const

/**
 * Delegated scope for Teams presence mirroring (#132). Requested only when the
 * feature is enabled — scopes stay minimal per feature, so enabling presence
 * on an existing connection requires reconnecting once for the extra consent.
 */
export const PRESENCE_SCOPE = 'Presence.ReadWrite'

/**
 * Whether `scope` is among the `granted` scopes of a token response. Compared
 * without case and without the Graph resource prefix, so `Presence.ReadWrite`,
 * `presence.readwrite` and `https://graph.microsoft.com/Presence.ReadWrite`
 * are the same scope.
 */
export function hasScope(granted: readonly string[], scope: string): boolean {
  const norm = (s: string): string =>
    s
      .trim()
      .toLowerCase()
      .replace(/^https:\/\/graph\.microsoft\.com\//, '')
  return granted.some((g) => norm(g) === norm(scope))
}

/**
 * Scopes for a refresh (#308). Entra refreshes only scopes "equivalent to or a
 * subset of" those granted, and a refresh asking for more fails — with Teams
 * presence switched on but not yet consented, that broke the calendar import.
 * So the calendar scopes, asked for at every connect, always go along; any
 * further feature scope only once it is granted. A new scope is asked for in
 * the interactive connect, never in a refresh.
 */
export function refreshScopes(wanted: readonly string[], granted: readonly string[]): string[] {
  const base = CALENDAR_SCOPES as readonly string[]
  return wanted.filter((s) => base.includes(s) || hasScope(granted, s))
}

export function authorityBase(tenant: GraphTenant): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}`
}

export function authorizeUrl(tenant: GraphTenant): string {
  return `${authorityBase(tenant)}/oauth2/v2.0/authorize`
}

export function tokenUrl(tenant: GraphTenant): string {
  return `${authorityBase(tenant)}/oauth2/v2.0/token`
}

/**
 * Path of the loopback redirect. Must match the app registration exactly.
 *
 * Entra ignores the **port** of a localhost redirect URI, which is what lets us
 * bind an ephemeral port without registering every one of them — but it does
 * NOT ignore the path. Hence a named path rather than a bare `http://localhost`.
 * https://learn.microsoft.com/en-us/entra/identity-platform/reply-url
 */
export const REDIRECT_PATH = '/timetrack'

export function redirectUriForPort(port: number): string {
  return `http://localhost:${port}${REDIRECT_PATH}`
}

/** Tokens plus an absolute expiry, so freshness never depends on when we asked. */
export interface StoredTokens {
  accessToken: string
  refreshToken: string
  /** Epoch ms. Absolute, not a duration. */
  expiresAtMs: number
  /** Scopes the server actually granted (may differ from what we asked for). */
  grantedScopes: string[]
  /** Display-only, from the id_token. Never used for authorization. */
  account: AccountInfo | null
}

export interface AccountInfo {
  /** `preferred_username` — usually the e-mail address. */
  username: string | null
  /** `name` — the display name. */
  displayName: string | null
  /** `tid` — lets the UI tell a work/school account from a personal one. */
  tenantId: string | null
}

/**
 * Personal Microsoft accounts always carry this well-known tenant id. Teams
 * presence (#132) is unavailable for them, so the UI needs to be able to say so
 * instead of offering a switch that cannot work.
 */
export const MSA_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad'

export function isPersonalAccount(account: AccountInfo | null): boolean {
  return account?.tenantId === MSA_TENANT_ID
}

// ── Request bodies ─────────────────────────────────────────────────────────

/**
 * The URL the system browser is sent to.
 *
 * `code_challenge_method=S256` is the whole point of PKCE: the verifier never
 * leaves this machine, so an authorization code intercepted on the loopback
 * hop is useless without it. `prompt=select_account` is deliberate — without it
 * Entra silently reuses whatever account the browser is already signed in with,
 * which is exactly wrong for a "connect an account" button.
 */
export function buildAuthorizeUrl(params: {
  clientId: string
  tenant: GraphTenant
  scopes: readonly string[]
  redirectUri: string
  state: string
  codeChallenge: string
}): string {
  const q = new URLSearchParams({
    client_id: params.clientId,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    response_mode: 'query',
    scope: params.scopes.join(' '),
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account'
  })
  return `${authorizeUrl(params.tenant)}?${q.toString()}`
}

export function authCodeBody(params: {
  clientId: string
  code: string
  codeVerifier: string
  redirectUri: string
  scopes: readonly string[]
}): string {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
    scope: params.scopes.join(' ')
  }).toString()
}

/** Outcome of the browser redirect landing on the loopback listener. */
export type CallbackResult =
  | { kind: 'code'; code: string; state: string }
  | { kind: 'error'; error: string; description: string | null; state: string | null }

/**
 * Read the callback query string.
 *
 * The `state` check itself is the caller's job — but note it must compare
 * against the value it generated, not merely check presence: state is the CSRF
 * guard for this flow, and a callback carrying someone else's code would
 * otherwise be accepted.
 */
export function parseCallbackQuery(search: string): CallbackResult | null {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const error = q.get('error')
  if (error) {
    return {
      kind: 'error',
      error,
      description: q.get('error_description'),
      state: q.get('state')
    }
  }
  const code = q.get('code')
  const state = q.get('state')
  if (!code || !state) return null
  return { kind: 'code', code, state }
}

export function refreshBody(
  clientId: string,
  refreshToken: string,
  scopes: readonly string[]
): string {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
    scope: scopes.join(' ')
  }).toString()
}

// ── Response parsing ───────────────────────────────────────────────────────

/** Thrown for a terminal protocol failure; the caller reverts to signed-out. */
export class GraphAuthError extends Error {
  constructor(
    message: string,
    /** OAuth `error` code when the server supplied one. */
    readonly code: string | null = null
  ) {
    super(message)
    this.name = 'GraphAuthError'
  }
}

/**
 * Turn an OAuth error from the authorize step into something a user can act on.
 *
 * `access_denied` is the ordinary "I clicked cancel" case and must not read
 * like a malfunction. `consent_required` / `interaction_required` are what the
 * publisher-verification restriction surfaces as for users in other tenants —
 * worth naming explicitly, because "Need admin approval" is otherwise a dead
 * end with no explanation.
 */
export function describeAuthorizeError(error: string, description: string | null): GraphAuthError {
  switch (error) {
    case 'access_denied':
      return new GraphAuthError('Die Anmeldung wurde abgebrochen.', error)
    case 'consent_required':
    case 'interaction_required':
      return new GraphAuthError(
        'Die Zustimmung muss von einem Administrator erteilt werden. ' +
          'In vielen Firmen-Tenants dürfen Nutzer Apps ohne verifizierten Herausgeber nicht selbst freigeben.',
        error
      )
    default:
      return new GraphAuthError(description || 'Die Anmeldung ist fehlgeschlagen.', error)
  }
}

/** Build absolute-expiry tokens from a `/token` success body. */
export function tokensFromResponse(json: unknown, nowMs: number): StoredTokens {
  const o = asRecord(json)
  const accessToken = str(o.access_token)
  const refreshToken = str(o.refresh_token)
  if (!accessToken) throw new GraphAuthError('Antwort ohne access_token.')
  if (!refreshToken) {
    // Means `offline_access` was not granted — the connection would silently
    // break at the first expiry, so fail loudly now instead.
    throw new GraphAuthError(
      'Antwort ohne refresh_token — offline_access wurde nicht erteilt. ' +
        'Ohne ihn müsste die Anmeldung stündlich wiederholt werden.'
    )
  }
  return {
    accessToken,
    refreshToken,
    expiresAtMs: nowMs + (num(o.expires_in) ?? 3600) * 1000,
    grantedScopes: (str(o.scope) ?? '').split(' ').filter(Boolean),
    account: parseIdTokenClaims(str(o.id_token))
  }
}

/**
 * Fold a refresh response onto the tokens we already hold.
 *
 * The rotation rule is the whole reason this is a named function: Entra may
 * return a NEW refresh token, and dropping it means the next refresh fails
 * after the old one is invalidated. If the response omits one, the previous
 * refresh token stays valid and must be carried over — writing `undefined`
 * there is how a hand-rolled client locks the user out a day later.
 *
 * The account claims are likewise carried over: a refresh response has no
 * id_token unless `openid` was re-requested, and losing the display name would
 * blank the settings UI for no reason.
 */
export function applyRefresh(previous: StoredTokens, json: unknown, nowMs: number): StoredTokens {
  const o = asRecord(json)
  const accessToken = str(o.access_token)
  if (!accessToken) throw new GraphAuthError('Erneuerung ohne access_token.')
  const rotated = str(o.refresh_token)
  const claims = parseIdTokenClaims(str(o.id_token))
  const scopes = (str(o.scope) ?? '').split(' ').filter(Boolean)
  return {
    accessToken,
    refreshToken: rotated ?? previous.refreshToken,
    expiresAtMs: nowMs + (num(o.expires_in) ?? 3600) * 1000,
    grantedScopes: scopes.length > 0 ? scopes : previous.grantedScopes,
    account: claims ?? previous.account
  }
}

/**
 * Treat a token as expired slightly early so a request cannot die in flight.
 * 120s covers both normal latency and modest clock skew against Entra.
 */
export const EXPIRY_SKEW_MS = 120_000

export function needsRefresh(tokens: StoredTokens, nowMs: number): boolean {
  return nowMs >= tokens.expiresAtMs - EXPIRY_SKEW_MS
}

/**
 * Read the display claims out of an id_token.
 *
 * Deliberately does NOT verify the signature, and the result must never gate
 * access to anything: the token arrived over TLS from the token endpoint in
 * direct response to our own request, and it is used only to print which
 * account is connected. Entra's own documentation warns against parsing tokens
 * for APIs you do not own — an id_token issued to this client is the one token
 * that is ours to read, and even so we only take three display fields from it.
 */
export function parseIdTokenClaims(idToken: string | null | undefined): AccountInfo | null {
  if (!idToken) return null
  const parts = idToken.split('.')
  if (parts.length < 2) return null
  try {
    const json = JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>
    const info: AccountInfo = {
      username: str(json.preferred_username) ?? str(json.email),
      displayName: str(json.name),
      tenantId: str(json.tid)
    }
    // All-null means nothing usable was in there; report absence, not an
    // object full of nulls the UI would have to special-case anyway.
    if (!info.username && !info.displayName && !info.tenantId) return null
    return info
  } catch {
    return null
  }
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
  const withPad = padded + '='.repeat((4 - (padded.length % 4)) % 4)
  return Buffer.from(withPad, 'base64').toString('utf8')
}

// ── Narrow helpers ─────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** OAuth error envelope, as far as we rely on it. */
export function parseErrorEnvelope(json: unknown): {
  code: string | null
  description: string | null
} {
  const o = asRecord(json)
  return { code: str(o.error), description: str(o.error_description) }
}
