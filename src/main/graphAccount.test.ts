import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_CLIENT_ID, MSA_TENANT_ID, type StoredTokens } from '../shared/graphAuth'
import {
  CLIENT_ID_SETTING,
  disconnect,
  effectiveClientId,
  getAccessToken,
  getStatus,
  type GraphAccountDeps
} from './graphAccount'
import { loadTokens, saveTokens, type SecretBox } from './graphTokenStore'

function fakeBox(available = true): SecretBox {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`),
    decryptString: (cipher) => {
      const s = cipher.toString('utf8')
      if (!s.startsWith('enc:')) throw new Error('bad ciphertext')
      return Buffer.from(s.slice(4), 'base64').toString('utf8')
    }
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-graph-acct-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const NOW = 1_800_000_000_000

function tokens(over: Partial<StoredTokens> = {}): StoredTokens {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAtMs: NOW + 3600_000,
    grantedScopes: ['Calendars.Read', 'offline_access'],
    account: { username: 'r@wald-it.com', displayName: 'Robin', tenantId: 'tid-1' },
    ...over
  }
}

function deps(over: Partial<GraphAccountDeps> = {}): GraphAccountDeps {
  const settings: Record<string, string> = {}
  return {
    getSetting: (k) => settings[k],
    openExternal: () => {},
    store: { dir, secretBox: fakeBox() },
    auth: { now: () => NOW },
    ...over
  }
}

function withSettings(
  settings: Record<string, string>,
  over: Partial<GraphAccountDeps> = {}
): GraphAccountDeps {
  return deps({ getSetting: (k) => settings[k], ...over })
}

describe('effectiveClientId', () => {
  it('uses the shipped id when nothing is configured', () => {
    expect(effectiveClientId(deps())).toBe(DEFAULT_CLIENT_ID)
  })

  it('prefers a user-supplied id — the escape hatch for locked-down tenants', () => {
    expect(effectiveClientId(withSettings({ [CLIENT_ID_SETTING]: 'own-id' }))).toBe('own-id')
  })

  it('ignores a blank override rather than sending an empty client id', () => {
    expect(effectiveClientId(withSettings({ [CLIENT_ID_SETTING]: '   ' }))).toBe(DEFAULT_CLIENT_ID)
  })
})

describe('getStatus', () => {
  it('reports disconnected before anything is stored', () => {
    const s = getStatus(deps())
    expect(s.connected).toBe(false)
    expect(s.account).toBeNull()
    expect(s.usingCustomClientId).toBe(false)
  })

  it('reports the connected account without leaking token material', () => {
    const d = deps()
    saveTokens(tokens(), d.store)
    const s = getStatus(d)
    expect(s.connected).toBe(true)
    expect(s.account?.username).toBe('r@wald-it.com')
    expect(JSON.stringify(s)).not.toContain('refresh-1')
    expect(JSON.stringify(s)).not.toContain('access-1')
  })

  it('flags a personal account, because Teams presence (#132) cannot work there', () => {
    const d = deps()
    saveTokens(
      tokens({ account: { username: 'a@outlook.com', displayName: 'A', tenantId: MSA_TENANT_ID } }),
      d.store
    )
    expect(getStatus(d).personalAccount).toBe(true)
  })

  it('does not flag a work account as personal', () => {
    const d = deps()
    saveTokens(tokens(), d.store)
    expect(getStatus(d).personalAccount).toBe(false)
  })

  it('reports storage as unavailable and stays disconnected without a keychain', () => {
    const d = deps({ store: { dir, secretBox: fakeBox(false) } })
    const s = getStatus(d)
    expect(s.storageAvailable).toBe(false)
    expect(s.connected).toBe(false)
  })

  it('says when a custom client id is in effect', () => {
    expect(getStatus(withSettings({ [CLIENT_ID_SETTING]: 'own-id' })).usingCustomClientId).toBe(
      true
    )
  })
})

describe('getAccessToken', () => {
  it('returns null when nothing is connected', async () => {
    await expect(getAccessToken(deps())).resolves.toBeNull()
  })

  it('returns the stored token without a network call while it is fresh', async () => {
    const fetchFn = vi.fn()
    const d = deps({ auth: { now: () => NOW, fetchFn: fetchFn as unknown as typeof fetch } })
    saveTokens(tokens(), d.store)
    await expect(getAccessToken(d)).resolves.toBe('access-1')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refreshes when the token is near expiry and returns the new one', async () => {
    const d = deps({
      auth: {
        now: () => NOW,
        fetchFn: (async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'access-2',
              refresh_token: 'rt-2',
              expires_in: 3600
            })
          }) as unknown as Response) as unknown as typeof fetch
      }
    })
    saveTokens(tokens({ expiresAtMs: NOW + 1000 }), d.store)
    await expect(getAccessToken(d)).resolves.toBe('access-2')
  })

  it('PERSISTS the rotated refresh token — otherwise the next refresh fails', async () => {
    const d = deps({
      auth: {
        now: () => NOW,
        fetchFn: (async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'access-2',
              refresh_token: 'rt-2',
              expires_in: 3600
            })
          }) as unknown as Response) as unknown as typeof fetch
      }
    })
    saveTokens(tokens({ expiresAtMs: NOW + 1000 }), d.store)
    await getAccessToken(d)

    // Read the file back rather than trusting the return value: the rotated
    // token has to be ON DISK. Keeping it only in memory is exactly the bug
    // that locks the user out after the old one is invalidated.
    const onDisk = loadTokens(d.store)
    expect(onDisk?.refreshToken).toBe('rt-2')
    expect(onDisk?.accessToken).toBe('access-2')
    expect(onDisk?.expiresAtMs).toBe(NOW + 3600_000)
  })

  it('persists the refreshed access token even when nothing rotated', async () => {
    const d = deps({
      auth: {
        now: () => NOW,
        fetchFn: (async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'access-2', expires_in: 3600 })
          }) as unknown as Response) as unknown as typeof fetch
      }
    })
    saveTokens(tokens({ expiresAtMs: NOW + 1000 }), d.store)
    await getAccessToken(d)
    const onDisk = loadTokens(d.store)
    expect(onDisk?.accessToken).toBe('access-2')
    expect(onDisk?.refreshToken).toBe('refresh-1') // carried over, not blanked
  })

  it('drops the connection on invalid_grant instead of claiming it still works', async () => {
    const d = deps({
      auth: {
        now: () => NOW,
        fetchFn: (async () =>
          ({
            ok: false,
            status: 400,
            json: async () => ({ error: 'invalid_grant' })
          }) as unknown as Response) as unknown as typeof fetch
      }
    })
    saveTokens(tokens({ expiresAtMs: NOW + 1000 }), d.store)
    await expect(getAccessToken(d)).resolves.toBeNull()
    expect(getStatus(d).connected).toBe(false)
  })

  it('keeps the connection on a transient server error and propagates it', async () => {
    const d = deps({
      auth: {
        now: () => NOW,
        fetchFn: (async () =>
          ({
            ok: false,
            status: 503,
            json: async () => ({ error: 'temporarily_unavailable' })
          }) as unknown as Response) as unknown as typeof fetch
      }
    })
    saveTokens(tokens({ expiresAtMs: NOW + 1000 }), d.store)
    await expect(getAccessToken(d)).rejects.toThrow()
    // A blip must not sign the user out.
    expect(getStatus(d).connected).toBe(true)
  })
})

describe('disconnect', () => {
  it('forgets the connection and reports it', () => {
    const d = deps()
    saveTokens(tokens(), d.store)
    expect(getStatus(d).connected).toBe(true)
    expect(disconnect(d).connected).toBe(false)
  })

  it('is safe when nothing is connected', () => {
    expect(() => disconnect(deps())).not.toThrow()
  })
})

// #308: Entra refreshes only scopes "equivalent to or a subset of" the ones
// granted. With Teams presence switched on but not yet consented (no
// reconnect, or the tenant needs an admin), every refresh asked for
// Presence.ReadWrite and failed — the calendar import stopped working.
describe('a refused refresh with feature scopes falls back to the calendar scopes (#308)', () => {
  /** Answers each refresh in turn and records the scopes it asked for. */
  function server(...answers: Array<'ok' | string>): {
    asked: string[][]
    fetchFn: typeof fetch
  } {
    const asked: string[][] = []
    const fetchFn = (async (_url: unknown, init?: { body?: unknown }) => {
      const scope = new URLSearchParams(String(init?.body ?? '')).get('scope') ?? ''
      asked.push(scope.split(' ').filter(Boolean))
      const a = answers[asked.length - 1] ?? 'ok'
      return (a === 'ok'
        ? {
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'access-2', expires_in: 3600, scope })
          }
        : {
            ok: false,
            status: 400,
            json: async () => ({ error: a, error_description: 'AADSTS65001' })
          }) as unknown as Response
    }) as unknown as typeof fetch
    return { asked, fetchFn }
  }

  function presenceOn(fetchFn: typeof fetch): GraphAccountDeps {
    return withSettings({ presence_enabled: '1' }, { auth: { now: () => NOW, fetchFn } })
  }

  for (const code of ['invalid_grant', 'consent_required', 'interaction_required']) {
    it(`presence not consented (${code}): the import still gets a token, the connection stays`, async () => {
      const s = server(code, 'ok')
      const d = presenceOn(s.fetchFn)
      saveTokens(tokens({ expiresAtMs: NOW + 1000 }), d.store)
      await expect(getAccessToken(d)).resolves.toBe('access-2')
      expect(s.asked).toHaveLength(2)
      expect(s.asked[0]).toContain('Presence.ReadWrite')
      expect(s.asked[1]).toEqual(['offline_access', 'openid', 'profile', 'Calendars.Read'])
      expect(loadTokens(d.store)?.accessToken).toBe('access-2')
    })
  }

  it('presence consented: one refresh, and the token carries it again', async () => {
    const s = server('ok')
    const d = presenceOn(s.fetchFn)
    // Even when the stored list lost the scope (presence was off for a while).
    saveTokens(tokens({ expiresAtMs: NOW + 1000, grantedScopes: ['Calendars.Read'] }), d.store)
    await getAccessToken(d)
    expect(s.asked).toHaveLength(1)
    expect(s.asked[0]).toContain('Presence.ReadWrite')
    expect(loadTokens(d.store)?.grantedScopes).toContain('Presence.ReadWrite')
  })

  it('the calendar-only refresh failing too means the grant is gone', async () => {
    const s = server('invalid_grant', 'invalid_grant')
    const d = presenceOn(s.fetchFn)
    saveTokens(tokens({ expiresAtMs: NOW + 1000 }), d.store)
    await expect(getAccessToken(d)).resolves.toBeNull()
    expect(loadTokens(d.store)).toBeNull()
  })

  it('without feature scopes there is no second attempt', async () => {
    const s = server('invalid_grant')
    const d = deps({ auth: { now: () => NOW, fetchFn: s.fetchFn } })
    saveTokens(tokens({ expiresAtMs: NOW + 1000 }), d.store)
    await expect(getAccessToken(d)).resolves.toBeNull()
    expect(s.asked).toHaveLength(1)
  })
  it('after the fallback the stored scopes are the calendar scopes, so settings asks to reconnect', async () => {
    const s = server('consent_required', 'ok')
    const d = presenceOn(s.fetchFn)
    // The stored list still names the scope, e.g. after the consent was revoked.
    saveTokens(
      tokens({ expiresAtMs: NOW + 1000, grantedScopes: ['Calendars.Read', 'Presence.ReadWrite'] }),
      d.store
    )
    await getAccessToken(d)
    expect(loadTokens(d.store)?.grantedScopes).not.toContain('Presence.ReadWrite')
  })

  for (const code of ['temporarily_unavailable', 'server_error']) {
    it(`a transient error (${code}) is not a refusal: no fallback, presence keeps its scope`, async () => {
      const s = server(code)
      const d = presenceOn(s.fetchFn)
      const before = tokens({
        expiresAtMs: NOW + 1000,
        grantedScopes: ['Calendars.Read', 'Presence.ReadWrite']
      })
      saveTokens(before, d.store)
      await expect(getAccessToken(d)).rejects.toThrow()
      expect(s.asked).toHaveLength(1)
      expect(loadTokens(d.store)?.grantedScopes).toEqual(before.grantedScopes)
    })
  }
})

// #341: the presence pokes and the calendar import can ask for a token at the
// same moment. Without a guard both refresh with the same refresh token;
// Entra rotates it on the first refresh, and the second, sent with the spent
// token, gets invalid_grant — which deletes the whole stored connection.
describe('concurrent token requests share one refresh (#341)', () => {
  /** A token endpoint that rotates the refresh token and refuses a spent one. */
  function rotatingServer(): { requests: () => number; fetchFn: typeof fetch } {
    let valid = 'refresh-1'
    let n = 0
    const fetchFn = (async (_url: unknown, init?: { body?: unknown }) => {
      n++
      const sent = new URLSearchParams(String(init?.body ?? '')).get('refresh_token')
      // Let the other caller start before this one answers.
      await new Promise((r) => setTimeout(r, 10))
      if (sent !== valid) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'invalid_grant', error_description: 'AADSTS70000 spent' })
        } as unknown as Response
      }
      valid = `refresh-${n + 1}`
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: `access-${n + 1}`,
          refresh_token: valid,
          expires_in: 3600
        })
      } as unknown as Response
    }) as unknown as typeof fetch
    return { requests: () => n, fetchFn }
  }

  it('two callers at once: one refresh, both get the token, the connection stays', async () => {
    const s = rotatingServer()
    const d = deps({ auth: { now: () => NOW, fetchFn: s.fetchFn } })
    saveTokens(tokens({ expiresAtMs: NOW + 1000 }), d.store)
    const [a, b] = await Promise.all([getAccessToken(d), getAccessToken(d)])
    expect([a, b]).toEqual(['access-2', 'access-2'])
    expect(s.requests()).toBe(1)
    expect(loadTokens(d.store)?.refreshToken).toBe('refresh-2')
  })

  it('a later call after the shared refresh refreshes again only when needed', async () => {
    const s = rotatingServer()
    const d = deps({ auth: { now: () => NOW, fetchFn: s.fetchFn } })
    saveTokens(tokens({ expiresAtMs: NOW + 1000 }), d.store)
    await Promise.all([getAccessToken(d), getAccessToken(d)])
    // The new token is fresh: no further request.
    await expect(getAccessToken(d)).resolves.toBe('access-2')
    expect(s.requests()).toBe(1)
  })
  /** A token endpoint that answers after `during` ran, with `answer`. */
  function slowServer(
    answer: 'ok' | 'invalid_grant' | 'network',
    during: () => void
  ): { requests: () => number; fetchFn: typeof fetch } {
    let n = 0
    const fetchFn = (async () => {
      n++
      await new Promise((r) => setTimeout(r, 10))
      during()
      if (answer === 'network') throw new TypeError('fetch failed')
      return (answer === 'ok'
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'access-2',
              refresh_token: 'rt-2',
              expires_in: 3600
            })
          }
        : {
            ok: false,
            status: 400,
            json: async () => ({ error: 'invalid_grant' })
          }) as unknown as Response
    }) as unknown as typeof fetch
    return { requests: () => n, fetchFn }
  }

  it('a new connection made during a refused refresh is not deleted', async () => {
    const fresh = tokens({ accessToken: 'access-new', refreshToken: 'rt-new' })
    const store = { dir, secretBox: fakeBox() }
    const s = slowServer('invalid_grant', () => saveTokens(fresh, store))
    const d = deps({ store, auth: { now: () => NOW, fetchFn: s.fetchFn } })
    saveTokens(tokens({ expiresAtMs: NOW + 1000 }), d.store)
    await expect(getAccessToken(d)).resolves.toBe('access-new')
    expect(loadTokens(d.store)?.refreshToken).toBe('rt-new')
  })

  it('a failed shared refresh reaches every caller once and is not kept', async () => {
    const s = slowServer('network', () => {})
    const d = deps({ auth: { now: () => NOW, fetchFn: s.fetchFn } })
    saveTokens(tokens({ expiresAtMs: NOW + 1000 }), d.store)
    const results = await Promise.allSettled([getAccessToken(d), getAccessToken(d)])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(s.requests()).toBe(1)
    // The next call starts a new refresh instead of reusing the failed one.
    await getAccessToken(d).catch(() => {})
    expect(s.requests()).toBe(2)
    expect(loadTokens(d.store)).not.toBeNull()
  })
  it('an unreadable store after a refused refresh is not deleted', async () => {
    const store = { dir, secretBox: fakeBox() }
    // The file becomes unreadable while the refresh runs (another process,
    // a broken key): nothing is deleted on the strength of it.
    const s = slowServer('invalid_grant', () =>
      writeFileSync(join(dir, 'graph-account.enc'), 'garbage')
    )
    const d = deps({ store, auth: { now: () => NOW, fetchFn: s.fetchFn } })
    saveTokens(tokens({ expiresAtMs: NOW + 1000 }), store)
    await expect(getAccessToken(d)).resolves.toBeNull()
    expect(existsSync(join(dir, 'graph-account.enc'))).toBe(true)
  })
  it('a replaced grant that is itself expiring gets one refresh of its own', async () => {
    const store = { dir, secretBox: fakeBox() }
    const replaced = tokens({
      accessToken: 'access-old',
      refreshToken: 'rt-new',
      expiresAtMs: NOW + 1000
    })
    const sent: string[] = []
    const fetchFn = (async (_url: unknown, init?: { body?: unknown }) => {
      const rt = new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? ''
      sent.push(rt)
      if (rt === 'refresh-1') {
        // Someone else stores another grant while the first refresh runs.
        saveTokens(replaced, store)
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'invalid_grant' })
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'access-3', refresh_token: 'rt-3', expires_in: 3600 })
      } as unknown as Response
    }) as unknown as typeof fetch
    const d = deps({ store, auth: { now: () => NOW, fetchFn } })
    saveTokens(tokens({ expiresAtMs: NOW + 1000 }), store)
    await expect(getAccessToken(d)).resolves.toBe('access-3')
    expect(sent).toEqual(['refresh-1', 'rt-new'])
    expect(loadTokens(store)?.refreshToken).toBe('rt-3')
  })
})
