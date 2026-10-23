import { describe, it, expect } from 'vitest'
import {
  CALENDAR_SCOPES,
  DEFAULT_CLIENT_ID,
  EXPIRY_SKEW_MS,
  GraphAuthError,
  MSA_TENANT_ID,
  REDIRECT_PATH,
  applyRefresh,
  authCodeBody,
  authorizeUrl,
  buildAuthorizeUrl,
  describeAuthorizeError,
  hasScope,
  isPersonalAccount,
  needsRefresh,
  parseCallbackQuery,
  parseErrorEnvelope,
  parseIdTokenClaims,
  PRESENCE_SCOPE,
  redirectUriForPort,
  refreshBody,
  tokenUrl,
  tokensFromResponse,
  type StoredTokens
} from './graphAuth'

/** Build an unsigned id_token with the given payload (header/signature unused). */
function fakeIdToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown): string =>
    Buffer.from(JSON.stringify(o), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  return `${b64({ alg: 'none' })}.${b64(payload)}.signature-not-verified`
}

const NOW = 1_800_000_000_000

function tokens(over: Partial<StoredTokens> = {}): StoredTokens {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAtMs: NOW + 3600_000,
    grantedScopes: ['Calendars.Read', 'offline_access'],
    account: { username: 'a@b.test', displayName: 'A B', tenantId: 'tid-1' },
    ...over
  }
}

describe('scopes and endpoints', () => {
  it('requests offline_access — without it no refresh token is issued', () => {
    expect(CALENDAR_SCOPES).toContain('offline_access')
  })

  it('does NOT request Presence.ReadWrite (that belongs to #132, on opt-in)', () => {
    expect(CALENDAR_SCOPES).not.toContain('Presence.ReadWrite')
    expect(CALENDAR_SCOPES.some((s) => s.toLowerCase().includes('presence'))).toBe(false)
  })

  it('asks for read-only calendar access, never write', () => {
    expect(CALENDAR_SCOPES).toContain('Calendars.Read')
    expect(CALENDAR_SCOPES.some((s) => s.includes('ReadWrite'))).toBe(false)
  })

  it('builds the common-authority endpoints', () => {
    expect(authorizeUrl('common')).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
    )
    expect(tokenUrl('common')).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token')
  })

  it('url-encodes a tenant GUID or a hostile tenant value', () => {
    expect(tokenUrl('contoso.onmicrosoft.com')).toContain('/contoso.onmicrosoft.com/')
    expect(authorizeUrl('a/../b')).not.toContain('a/../b')
  })

  it('ships a client id, since without one nothing can sign in', () => {
    expect(DEFAULT_CLIENT_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })
})

describe('loopback redirect', () => {
  it('carries the registered path — Entra ignores the port but not the path', () => {
    expect(redirectUriForPort(51234)).toBe(`http://localhost:51234${REDIRECT_PATH}`)
  })

  it('produces the same path for any port, which is what makes ephemeral ports work', () => {
    for (const port of [1024, 51234, 65535]) {
      expect(new URL(redirectUriForPort(port)).pathname).toBe(REDIRECT_PATH)
    }
  })

  it('uses http on localhost — allowed precisely because the hop never leaves the device', () => {
    const u = new URL(redirectUriForPort(1234))
    expect(u.protocol).toBe('http:')
    expect(u.hostname).toBe('localhost')
  })
})

const AUTHORIZE_PARAMS = {
  clientId: 'client-1',
  tenant: 'common' as const,
  scopes: CALENDAR_SCOPES,
  redirectUri: 'http://localhost:51234/timetrack',
  state: 'state-abc',
  codeChallenge: 'challenge-xyz'
}

describe('buildAuthorizeUrl', () => {
  it('requests a code with S256 — the point of PKCE', () => {
    const q = new URL(buildAuthorizeUrl(AUTHORIZE_PARAMS)).searchParams
    expect(q.get('response_type')).toBe('code')
    expect(q.get('code_challenge')).toBe('challenge-xyz')
    expect(q.get('code_challenge_method')).toBe('S256')
  })

  it('never sends the verifier itself, only the challenge', () => {
    const url = buildAuthorizeUrl(AUTHORIZE_PARAMS)
    expect(url).not.toContain('code_verifier')
  })

  it('passes redirect_uri and state through unchanged', () => {
    const q = new URL(buildAuthorizeUrl(AUTHORIZE_PARAMS)).searchParams
    expect(q.get('redirect_uri')).toBe('http://localhost:51234/timetrack')
    expect(q.get('state')).toBe('state-abc')
  })

  it('forces an account picker instead of silently reusing the browser session', () => {
    // A "connect an account" button that connects whatever account happens to
    // be signed in elsewhere is the wrong behaviour, and hard to notice.
    expect(new URL(buildAuthorizeUrl(AUTHORIZE_PARAMS)).searchParams.get('prompt')).toBe(
      'select_account'
    )
  })

  it('asks for the query response mode, which is what the loopback can read', () => {
    expect(new URL(buildAuthorizeUrl(AUTHORIZE_PARAMS)).searchParams.get('response_mode')).toBe(
      'query'
    )
  })

  it('space-separates the scopes', () => {
    expect(new URL(buildAuthorizeUrl(AUTHORIZE_PARAMS)).searchParams.get('scope')).toBe(
      CALENDAR_SCOPES.join(' ')
    )
  })
})

describe('request bodies', () => {
  it('exchanges the code with the verifier and the same redirect_uri', () => {
    const body = authCodeBody({
      clientId: 'client-1',
      code: 'the-code',
      codeVerifier: 'the-verifier',
      redirectUri: 'http://localhost:51234/timetrack',
      scopes: CALENDAR_SCOPES
    })
    expect(body).toContain('grant_type=authorization_code')
    expect(body).toContain('code=the-code')
    expect(body).toContain('code_verifier=the-verifier')
    expect(body).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A51234%2Ftimetrack')
  })

  it('sends grant_type=refresh_token when refreshing', () => {
    const body = refreshBody('client-1', 'refresh-1', ['Calendars.Read'])
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('refresh_token=refresh-1')
  })

  it('never puts a client secret in any body or URL (public client)', () => {
    const bodies = [
      authCodeBody({
        clientId: 'c',
        code: 'x',
        codeVerifier: 'v',
        redirectUri: 'http://localhost:1/timetrack',
        scopes: CALENDAR_SCOPES
      }),
      refreshBody('c', 'r', CALENDAR_SCOPES),
      buildAuthorizeUrl(AUTHORIZE_PARAMS)
    ]
    for (const body of bodies) expect(body).not.toContain('client_secret')
  })
})

describe('parseCallbackQuery', () => {
  it('reads code and state from the redirect', () => {
    expect(parseCallbackQuery('?code=abc&state=xyz')).toEqual({
      kind: 'code',
      code: 'abc',
      state: 'xyz'
    })
  })

  it('works with or without the leading question mark', () => {
    expect(parseCallbackQuery('code=abc&state=xyz')).toEqual({
      kind: 'code',
      code: 'abc',
      state: 'xyz'
    })
  })

  it('reports an OAuth error instead of pretending nothing arrived', () => {
    expect(
      parseCallbackQuery('?error=access_denied&error_description=User+cancelled&state=xyz')
    ).toEqual({
      kind: 'error',
      error: 'access_denied',
      description: 'User cancelled',
      state: 'xyz'
    })
  })

  it('returns null when neither a code nor an error is present', () => {
    // e.g. a browser prefetch or a favicon hit on the listener.
    expect(parseCallbackQuery('')).toBeNull()
    expect(parseCallbackQuery('?something=else')).toBeNull()
  })

  it('returns null for a code without state — state is the CSRF guard', () => {
    expect(parseCallbackQuery('?code=abc')).toBeNull()
  })
})

describe('describeAuthorizeError', () => {
  it('phrases a cancelled sign-in as cancelled, not as a failure', () => {
    const err = describeAuthorizeError('access_denied', null)
    expect(err.message).toMatch(/abgebrochen/)
    expect(err.code).toBe('access_denied')
  })

  it.each(['consent_required', 'interaction_required'])(
    'explains %s as the admin-approval case rather than a dead end',
    (code) => {
      const err = describeAuthorizeError(code, null)
      expect(err.message).toMatch(/Administrator/)
    }
  )

  it('falls back to the server description for anything else', () => {
    expect(describeAuthorizeError('weird_error', 'Serverdetail').message).toBe('Serverdetail')
  })

  it('still yields a message when the server sends no description', () => {
    expect(describeAuthorizeError('weird_error', null).message.length).toBeGreaterThan(0)
  })
})

describe('tokensFromResponse', () => {
  it('turns expires_in into an absolute expiry', () => {
    const t = tokensFromResponse(
      { access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: 'Calendars.Read' },
      NOW
    )
    expect(t.accessToken).toBe('at')
    expect(t.refreshToken).toBe('rt')
    expect(t.expiresAtMs).toBe(NOW + 3599_000)
    expect(t.grantedScopes).toEqual(['Calendars.Read'])
  })

  it('accepts expires_in delivered as a string', () => {
    const t = tokensFromResponse(
      { access_token: 'at', refresh_token: 'rt', expires_in: '600' },
      NOW
    )
    expect(t.expiresAtMs).toBe(NOW + 600_000)
  })

  it('fails loudly when offline_access was not granted', () => {
    expect(() => tokensFromResponse({ access_token: 'at', expires_in: 3600 }, NOW)).toThrow(
      /refresh_token/
    )
  })

  it('fails when there is no access token', () => {
    expect(() => tokensFromResponse({ refresh_token: 'rt' }, NOW)).toThrow(GraphAuthError)
  })

  it('picks the display account out of the id_token', () => {
    const t = tokensFromResponse(
      {
        access_token: 'at',
        refresh_token: 'rt',
        id_token: fakeIdToken({ preferred_username: 'r@wald-it.com', name: 'Robin', tid: 'tid-9' })
      },
      NOW
    )
    expect(t.account).toEqual({
      username: 'r@wald-it.com',
      displayName: 'Robin',
      tenantId: 'tid-9'
    })
  })
})

describe('applyRefresh — the rotation rule', () => {
  it('adopts a rotated refresh token when the server sends one', () => {
    const next = applyRefresh(
      tokens(),
      { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 },
      NOW
    )
    expect(next.refreshToken).toBe('refresh-2')
    expect(next.accessToken).toBe('access-2')
  })

  it('KEEPS the previous refresh token when the response omits one', () => {
    // The failure this guards: writing `undefined` here locks the user out at
    // the next refresh, hours later, with no way to tell why.
    const next = applyRefresh(tokens(), { access_token: 'access-2', expires_in: 3600 }, NOW)
    expect(next.refreshToken).toBe('refresh-1')
  })

  it('never leaves the refresh token empty', () => {
    for (const body of [
      { access_token: 'a', expires_in: 60 },
      { access_token: 'a', refresh_token: '', expires_in: 60 },
      { access_token: 'a', refresh_token: null, expires_in: 60 }
    ]) {
      expect(applyRefresh(tokens(), body, NOW).refreshToken).toBe('refresh-1')
    }
  })

  it('carries the account over — a refresh response has no id_token', () => {
    const next = applyRefresh(tokens(), { access_token: 'a', expires_in: 60 }, NOW)
    expect(next.account).toEqual(tokens().account)
  })

  it('carries the granted scopes over when the response omits them', () => {
    const next = applyRefresh(tokens(), { access_token: 'a', expires_in: 60 }, NOW)
    expect(next.grantedScopes).toEqual(['Calendars.Read', 'offline_access'])
  })

  it('takes fresh scopes when the response does list them', () => {
    const next = applyRefresh(
      tokens(),
      { access_token: 'a', expires_in: 60, scope: 'Calendars.Read User.Read' },
      NOW
    )
    expect(next.grantedScopes).toEqual(['Calendars.Read', 'User.Read'])
  })

  it('re-bases the expiry on the refresh time, not the original login', () => {
    const later = NOW + 5_000_000
    expect(applyRefresh(tokens(), { access_token: 'a', expires_in: 3600 }, later).expiresAtMs).toBe(
      later + 3600_000
    )
  })

  it('throws when the refresh response has no access token', () => {
    expect(() => applyRefresh(tokens(), { refresh_token: 'r' }, NOW)).toThrow(GraphAuthError)
  })
})

describe('needsRefresh', () => {
  it('is false for a token with plenty of life left', () => {
    expect(needsRefresh(tokens({ expiresAtMs: NOW + 3600_000 }), NOW)).toBe(false)
  })

  it('is true once expired', () => {
    expect(needsRefresh(tokens({ expiresAtMs: NOW - 1 }), NOW)).toBe(true)
  })

  it('refreshes early by the skew so a request cannot die in flight', () => {
    const justInside = tokens({ expiresAtMs: NOW + EXPIRY_SKEW_MS - 1 })
    const justOutside = tokens({ expiresAtMs: NOW + EXPIRY_SKEW_MS + 1 })
    expect(needsRefresh(justInside, NOW)).toBe(true)
    expect(needsRefresh(justOutside, NOW)).toBe(false)
  })
})

describe('parseIdTokenClaims', () => {
  it('returns null for absent or malformed input rather than throwing', () => {
    expect(parseIdTokenClaims(null)).toBeNull()
    expect(parseIdTokenClaims(undefined)).toBeNull()
    expect(parseIdTokenClaims('')).toBeNull()
    expect(parseIdTokenClaims('not-a-jwt')).toBeNull()
    expect(parseIdTokenClaims('a.!!!not-base64!!!.c')).toBeNull()
  })

  it('decodes base64url payloads containing non-ASCII names', () => {
    const claims = parseIdTokenClaims(fakeIdToken({ name: 'Renée Müller', tid: 't' }))
    expect(claims?.displayName).toBe('Renée Müller')
  })

  it('falls back to the email claim when preferred_username is absent', () => {
    expect(parseIdTokenClaims(fakeIdToken({ email: 'x@y.test' }))?.username).toBe('x@y.test')
  })

  it('returns null when the payload holds none of the display claims', () => {
    expect(parseIdTokenClaims(fakeIdToken({ aud: 'client', iss: 'entra' }))).toBeNull()
  })
})

describe('isPersonalAccount', () => {
  it('recognises the well-known MSA tenant (Teams presence is unavailable there)', () => {
    expect(isPersonalAccount({ username: null, displayName: null, tenantId: MSA_TENANT_ID })).toBe(
      true
    )
  })

  it('treats a work/school tenant and an unknown account as not personal', () => {
    expect(isPersonalAccount({ username: null, displayName: null, tenantId: 'tid-1' })).toBe(false)
    expect(isPersonalAccount(null)).toBe(false)
  })
})

describe('parseErrorEnvelope', () => {
  it('extracts code and description', () => {
    expect(parseErrorEnvelope({ error: 'slow_down', error_description: 'wait' })).toEqual({
      code: 'slow_down',
      description: 'wait'
    })
  })

  it('yields nulls for a body that is not an OAuth error envelope', () => {
    expect(parseErrorEnvelope('<html>502</html>')).toEqual({ code: null, description: null })
  })
})

describe('hasScope (#308)', () => {
  it('a scope matches without case and without the Graph resource prefix', () => {
    expect(hasScope(['presence.readwrite'], PRESENCE_SCOPE)).toBe(true)
    expect(hasScope(['https://graph.microsoft.com/Presence.ReadWrite'], PRESENCE_SCOPE)).toBe(true)
    expect(hasScope(['Presence.Read'], PRESENCE_SCOPE)).toBe(false)
    expect(hasScope([], PRESENCE_SCOPE)).toBe(false)
  })
})
