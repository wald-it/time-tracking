/**
 * The Microsoft account connection as the rest of the app sees it (#130).
 *
 * One place that owns: which client id is in effect, whether a connection
 * exists, and how to get a usable access token. Everything above this — the IPC
 * handlers, and later the calendar import (#130b) — goes through here rather
 * than touching the flow or the store directly.
 *
 * The important piece is `getAccessToken`: callers must never have to think
 * about expiry or rotation. It refreshes when needed and writes the result
 * back, because Entra may hand out a new refresh token on every refresh and
 * forgetting to persist that one locks the user out hours later.
 */
import {
  CALENDAR_SCOPES,
  DEFAULT_CLIENT_ID,
  GraphAuthError,
  isPersonalAccount,
  needsRefresh,
  PRESENCE_SCOPE,
  hasScope
} from '../shared/graphAuth'
import type { AccountInfo, StoredTokens } from '../shared/graphAuth'
import { resolve as resolvePath } from 'node:path'
import { refreshTokens } from './graphAuth'
import type { GraphAuthConfig, GraphAuthDeps } from './graphAuth'
import { connectAccount } from './graphConnect'
import type { ConnectDeps } from './graphConnect'
import {
  clearTokens,
  isStorageAvailable,
  loadTokens,
  saveTokens,
  type TokenStoreDeps
} from './graphTokenStore'

/** Settings key holding a user-supplied client id that overrides the shipped one. */
export const CLIENT_ID_SETTING = 'graph_client_id'

export interface GraphAccountDeps {
  /** Reads a value from the settings table. */
  getSetting: (key: string) => string | undefined
  /** Opens the system browser (Electron `shell.openExternal`). */
  openExternal: (url: string) => Promise<void> | void
  /** Required — the token store has no default location, see graphTokenStore.ts. */
  store: TokenStoreDeps
  auth?: GraphAuthDeps
  log?: (message: string) => void
}

/** What the settings UI renders. Never contains token material. */
export interface AccountStatus {
  connected: boolean
  account: AccountInfo | null
  /** True for a personal Microsoft account — Teams presence (#132) is unavailable there. */
  personalAccount: boolean
  grantedScopes: string[]
  /** False when the OS keychain is missing; connecting is refused in that case. */
  storageAvailable: boolean
  /** True when a user-supplied client id is in effect instead of the shipped one. */
  usingCustomClientId: boolean
}

/**
 * The client id in effect: a user override if set, otherwise the shipped one.
 *
 * The override exists for tenants that refuse third-party applications and for
 * anyone who would rather use their own registration.
 */
export function effectiveClientId(deps: GraphAccountDeps): string {
  const custom = deps.getSetting(CLIENT_ID_SETTING)?.trim()
  return custom && custom.length > 0 ? custom : DEFAULT_CLIENT_ID
}

function configOf(deps: GraphAccountDeps): GraphAuthConfig {
  // Scopes follow the enabled features (#132): the presence scope is only
  // requested once mirroring is switched on, so a calendar-only user never
  // consents to more than the import needs.
  const scopes =
    deps.getSetting('presence_enabled') === '1'
      ? [...CALENDAR_SCOPES, PRESENCE_SCOPE]
      : [...CALENDAR_SCOPES]
  return { clientId: effectiveClientId(deps), scopes }
}

export function getStatus(deps: GraphAccountDeps): AccountStatus {
  const storageAvailable = isStorageAvailable(deps.store)
  const tokens = storageAvailable ? loadTokens(deps.store) : null
  const custom = deps.getSetting(CLIENT_ID_SETTING)?.trim()
  return {
    connected: tokens !== null,
    account: tokens?.account ?? null,
    personalAccount: isPersonalAccount(tokens?.account ?? null),
    grantedScopes: tokens?.grantedScopes ?? [],
    storageAvailable,
    usingCustomClientId: Boolean(custom && custom.length > 0)
  }
}

/**
 * Run the browser sign-in and persist the result.
 *
 * The storage check comes first on purpose: sending someone through a full
 * sign-in only to discard the tokens afterwards would be the rudest possible
 * ordering.
 */
export async function connect(
  deps: GraphAccountDeps,
  signal?: AbortSignal
): Promise<AccountStatus> {
  if (!isStorageAvailable(deps.store)) {
    throw new GraphAuthError(
      'Die sichere Ablage des Systems ist nicht verfügbar. Die Verbindung könnte nicht ' +
        'gespeichert werden, deshalb wird die Anmeldung gar nicht erst gestartet.',
      'storage_unavailable'
    )
  }
  const connectDeps: ConnectDeps = {
    openExternal: deps.openExternal,
    log: deps.log,
    ...deps.auth
  }
  const tokens = await connectAccount(configOf(deps), connectDeps, signal)
  saveTokens(tokens, deps.store)
  deps.log?.('graph account: connected')
  return getStatus(deps)
}

/** Forget the connection. Does not revoke anything server-side — that is the user's own account page. */
export function disconnect(deps: GraphAccountDeps): AccountStatus {
  clearTokens(deps.store)
  deps.log?.('graph account: disconnected')
  return getStatus(deps)
}

/**
 * A usable access token, refreshing first when the stored one is close to
 * expiry. Returns `null` when nothing is connected.
 *
 * On `invalid_grant` the stored connection is dropped: the grant is gone for
 * good (revoked, password changed, unused too long), and keeping a dead blob
 * around would make the settings page claim a connection that cannot work.
 * With a feature scope in the request, that holds for the calendar-only
 * retry (#308): a refused feature scope can arrive as `invalid_grant` too.
 */
export async function getAccessToken(deps: GraphAccountDeps): Promise<string | null> {
  const tokens = loadTokens(deps.store)
  if (!tokens) return null

  const now = deps.auth?.now?.() ?? Date.now()
  if (!needsRefresh(tokens, now)) return tokens.accessToken

  // #341: one refresh per token store at a time. The presence pokes and the
  // calendar import can ask at the same moment; a second refresh with the
  // same refresh token is sent with a spent token once Entra has rotated it.
  const key = storeKey(deps)
  const running = inFlight.get(key)
  if (running) return running
  const refresh = (async (): Promise<string | null> => {
    try {
      return await refreshAndStore(deps, tokens)
    } finally {
      // Before the callers see the result, so none of them can pick up a
      // settled refresh.
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, refresh)
  return refresh
}

/** Refreshes in progress, per token-store directory (#341). */
const inFlight = new Map<string, Promise<string | null>>()

/** One key per directory, however the path was spelled. */
function storeKey(deps: GraphAccountDeps): string {
  const dir = resolvePath(deps.store.dir)
  return process.platform === 'win32' ? dir.toLowerCase() : dir
}

async function refreshAndStore(
  deps: GraphAccountDeps,
  tokens: StoredTokens
): Promise<string | null> {
  let refreshed: StoredTokens
  try {
    refreshed = await refreshWithFallback(configOf(deps), tokens, deps)
  } catch (err) {
    if (err instanceof GraphAuthError && err.code === 'invalid_grant') {
      // #341: the connection is gone only if the store still holds the very
      // refresh token that was refused. A different one means someone else
      // refreshed or reconnected meanwhile; an empty or unreadable store is
      // nothing to delete.
      const current = loadTokens(deps.store)
      if (!current) return null
      if (current.refreshToken !== tokens.refreshToken) {
        deps.log?.('graph account: refresh token already replaced, using the stored one')
        const now = deps.auth?.now?.() ?? Date.now()
        return needsRefresh(current, now) ? refreshAndStore(deps, current) : current.accessToken
      }
      deps.log?.('graph account: grant no longer valid, connection dropped')
      clearTokens(deps.store)
      return null
    }
    throw err
  }
  // Must be persisted even when only the access token changed — the refresh
  // token may have rotated, and the old one stops working once it has.
  saveTokens(refreshed, deps.store)
  return refreshed.accessToken
}
/**
 * #308: Entra refreshes only scopes "equivalent to or a subset of" those
 * granted. With a feature switched on whose scope is not consented yet (Teams
 * presence before the reconnect, or a tenant that needs an admin for it), a
 * refresh asking for it is refused — and the calendar import with it. So a
 * refused refresh that carried feature scopes is retried once with the
 * calendar scopes alone. When the consent exists, the first refresh simply
 * succeeds; the outcome never depends on how the server spells its scopes.
 * Only a failure of the calendar-only refresh speaks for the connection.
 */
async function refreshWithFallback(
  cfg: GraphAuthConfig,
  tokens: StoredTokens,
  deps: GraphAccountDeps
): Promise<StoredTokens> {
  const base = CALENDAR_SCOPES as readonly string[]
  const extras = (cfg.scopes ?? base).filter((s) => !hasScope(base, s))
  try {
    return await refreshTokens(cfg, tokens, deps.auth)
  } catch (err) {
    // Only a refusal of the scopes; a network error, an outage or throttling
    // must not cost a consented feature its scope.
    if (extras.length === 0 || !(err instanceof GraphAuthError) || !isRefusal(err.code)) {
      throw err
    }
    deps.log?.(
      `graph account: refresh with ${extras.join(' ')} refused (${err.code}); retrying with the calendar scopes alone, if that fails too the grant itself is gone`
    )
    return refreshTokens({ ...cfg, scopes: [...CALENDAR_SCOPES] }, tokens, deps.auth)
  }
}

/** OAuth codes with which the token endpoint refuses a grant or its scopes. */
function isRefusal(code: string | null): boolean {
  return (
    code === 'invalid_grant' ||
    code === 'consent_required' ||
    code === 'interaction_required' ||
    code === 'invalid_scope'
  )
}

/** Outcome of "check connection" — proves the stored token is accepted by Graph. */
export interface VerifyResult {
  /** From Graph's own `/me`, not from the id_token — a second, independent source. */
  displayName: string | null
  mail: string | null
  /** True when this check had to renew the access token first. */
  refreshed: boolean
}

const GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me'
const GRAPH_TIMEOUT_MS = 15_000

/**
 * Call Graph once with the stored credentials.
 *
 * Worth having as a button rather than only as an internal helper: until
 * something actually calls Graph, "connected" only means "we hold a blob that
 * decrypts". This turns that into a statement about the live grant — and it
 * exercises the refresh path, which is otherwise only covered against fakes and
 * would first be tried for real an hour into someone's workday.
 */
export async function verifyConnection(deps: GraphAccountDeps): Promise<VerifyResult> {
  const before = loadTokens(deps.store)
  if (!before) {
    throw new GraphAuthError('Kein Microsoft-Konto verbunden.', 'not_connected')
  }
  const now = deps.auth?.now?.() ?? Date.now()
  const willRefresh = needsRefresh(before, now)

  const token = await getAccessToken(deps)
  if (!token) {
    throw new GraphAuthError(
      'Die Verbindung ist nicht mehr gültig. Bitte das Microsoft-Konto erneut verbinden.',
      'invalid_grant'
    )
  }

  const fetchFn = deps.auth?.fetchFn ?? fetch
  const res = await fetchFn(GRAPH_ME_URL, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS)
  })
  if (!res.ok) {
    // 401 here means the token was rejected despite looking fresh — worth
    // saying plainly rather than dressing it up as a network hiccup.
    throw new GraphAuthError(
      res.status === 401
        ? 'Microsoft hat das Zugriffstoken abgelehnt. Bitte erneut verbinden.'
        : `Microsoft Graph antwortete mit HTTP ${res.status}.`,
      `graph_${res.status}`
    )
  }
  const body = (await res.json()) as Record<string, unknown>
  deps.log?.(`graph account: verified via /me (refreshed=${willRefresh})`)
  return {
    displayName: typeof body.displayName === 'string' ? body.displayName : null,
    mail:
      typeof body.mail === 'string'
        ? body.mail
        : typeof body.userPrincipalName === 'string'
          ? body.userPrincipalName
          : null,
    refreshed: willRefresh
  }
}
