/**
 * Tests for the presence reconciler (#132). Injected fetch — no network, no
 * Electron. The module keeps applied state across calls, so every test resets
 * it first.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  desiredMessage,
  reconcilePresence,
  resetPresenceStateForTests,
  type PresenceDeps
} from './graphPresence'
import type { RunningStatus } from './mcpBridgeCore'

const RUNNING: RunningStatus = {
  id: 1,
  client_id: 1,
  project_id: 10,
  description: '',
  started_at: '2026-06-10T09:00:00.000Z',
  client_name: 'Acme',
  project_name: 'Rollout'
}

interface FetchCall {
  url: string
  method: string
  body: unknown
}

/**
 * What the fake Teams holds: the status message and availability. Shared by
 * every makeDeps() of a test, like the real Teams is shared across pokes;
 * reset with the module state.
 */
const teams: { content: string | null; availability: string; html: boolean } = {
  content: null,
  availability: 'Available',
  html: false
}

function resetTeams(): void {
  teams.content = null
  teams.availability = 'Available'
  teams.html = false
}

/**
 * How Graph hands back a stored message has not been observed against a real
 * tenant (#316): plain, as set, or wrapped as HTML. `teams.html` serves the
 * second form so both are tested.
 */
function served(content: string): string {
  if (!teams.html) return content
  const escaped = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/🔴/g, '&#x1F534;')
    .replace(/ /g, '&nbsp;')
  return `<p>${escaped}</p>`
}

function makeDeps(
  o: Partial<{
    enabled: boolean
    showClient: boolean
    language: string
    connected: boolean
    personal: boolean
    scopes: string[]
    token: string | null
    failWith: number
    now: number
  }> = {}
): { deps: PresenceDeps; calls: FetchCall[]; logs: string[] } {
  const calls: FetchCall[] = []
  const logs: string[] = []
  const settings: Record<string, string> = {
    presence_enabled: o.enabled === false ? '0' : '1',
    presence_show_client: o.showClient === true ? '1' : '0',
    language: o.language ?? 'de'
  }
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null
    })
    if (o.failWith !== undefined) return new Response('', { status: o.failWith })
    const u = String(url)
    if (u.includes('/me?$select=id')) {
      return new Response(JSON.stringify({ id: 'user-guid-1' }), { status: 200 })
    }
    const body = init?.body ? JSON.parse(String(init.body)) : null
    if (u.endsWith('/setStatusMessage')) {
      const content = (body as { statusMessage: { message: { content: string } } }).statusMessage
        .message.content
      teams.content = content === '' ? null : content
    } else if (u.endsWith('/setPresence')) {
      teams.availability = 'Busy'
    } else if (u.endsWith('/clearPresence')) {
      teams.availability = 'Available'
    } else if (u.endsWith('/presence') && (init?.method ?? 'GET') === 'GET') {
      return new Response(
        JSON.stringify({
          availability: teams.availability,
          statusMessage:
            teams.content === null
              ? null
              : {
                  message: {
                    content: served(teams.content),
                    contentType: teams.html ? 'html' : 'text'
                  }
                }
        }),
        { status: 200 }
      )
    }
    return new Response('', { status: 200 })
  }) as typeof fetch
  const deps: PresenceDeps = {
    getSetting: (k) => settings[k],
    getAccountStatus: () => ({
      connected: o.connected !== false,
      personalAccount: o.personal === true,
      grantedScopes: o.scopes ?? ['Calendars.Read', 'Presence.ReadWrite']
    }),
    getAccessToken: async () => (o.token === undefined ? 'tok' : o.token),
    getClientId: () => 'app-client-id',
    fetchFn,
    now: () => o.now ?? 1_750_000_000_000,
    log: (m) => logs.push(m)
  }
  return { deps, calls, logs }
}

/** The setPresence/clearPresence session calls. */
function sessionCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((c) => c.url.includes('setPresence') || c.url.includes('clearPresence'))
}

/** The setStatusMessage calls only (ignoring the one-time /me lookup). */
function statusCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((c) => c.url.includes('setStatusMessage'))
}

describe('desiredMessage', () => {
  it('renders generic, client, client+project, and language variants', () => {
    expect(desiredMessage(null, true, 'de')).toBe('')
    expect(desiredMessage(RUNNING, false, 'de')).toBe('🔴 Fokus')
    expect(desiredMessage(RUNNING, true, 'de')).toBe('🔴 Fokus: Acme — Rollout')
    expect(desiredMessage({ ...RUNNING, project_name: null }, true, 'de')).toBe('🔴 Fokus: Acme')
    expect(desiredMessage(RUNNING, false, 'en')).toBe('🔴 Focus')
  })
})

/** The writes only: what actually changes something in Teams. */
function writes(calls: FetchCall[]): FetchCall[] {
  return calls.filter((c) => c.method === 'POST')
}

describe('reconcilePresence', () => {
  beforeEach(() => {
    resetPresenceStateForTests()
    resetTeams()
  })

  it('sets the message on start: /me lookup once, then setStatusMessage with expiry', async () => {
    const { deps, calls } = makeDeps({ showClient: true })
    await reconcilePresence(deps, RUNNING)
    expect(calls[0].url).toContain('/me?$select=id')
    const set = statusCalls(calls)
    expect(set).toHaveLength(1)
    expect(set[0].url).toBe(
      'https://graph.microsoft.com/v1.0/users/user-guid-1/presence/setStatusMessage'
    )
    const body = set[0].body as {
      statusMessage: { message: { content: string; contentType: string }; expiryDateTime?: unknown }
    }
    expect(body.statusMessage.message).toEqual({
      content: '🔴 Fokus: Acme — Rollout',
      contentType: 'text'
    })
    expect(body.statusMessage.expiryDateTime).toMatchObject({ timeZone: 'UTC' })
  })

  it('is idempotent: same state twice → one Graph write, cached user id', async () => {
    const { deps, calls } = makeDeps()
    await reconcilePresence(deps, RUNNING)
    await reconcilePresence(deps, RUNNING)
    expect(statusCalls(calls)).toHaveLength(1)
    expect(calls.filter((c) => c.url.includes('/me?$select=id'))).toHaveLength(1)
  })

  it('sets a Busy/InACall session alongside the message', async () => {
    const { deps, calls } = makeDeps()
    await reconcilePresence(deps, RUNNING)
    const sessions = sessionCalls(calls)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].url).toContain('/presence/setPresence')
    expect(sessions[0].body).toEqual({
      sessionId: 'app-client-id',
      availability: 'Busy',
      activity: 'InACall',
      expirationDuration: 'PT1H'
    })
  })

  it('renews the expiring session on an unchanged state after 25 minutes', async () => {
    const t0 = 1_750_000_000_000
    const early = makeDeps({ now: t0 })
    await reconcilePresence(early.deps, RUNNING)
    const late = makeDeps({ now: t0 + 26 * 60 * 1000 })
    await reconcilePresence(late.deps, RUNNING)
    expect(sessionCalls(late.calls)).toHaveLength(1)
  })

  it('stop clears both message and session; a 404 on clearPresence counts as cleared', async () => {
    const { deps, calls } = makeDeps()
    await reconcilePresence(deps, RUNNING)
    // clearPresence answers 404 when the session already expired:
    const fetchInner = deps.fetchFn!
    deps.fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('clearPresence')) {
        await fetchInner(url, init) // still record the call
        return new Response('', { status: 404 })
      }
      return fetchInner(url, init)
    }) as typeof fetch
    await reconcilePresence(deps, null)
    const sessions = sessionCalls(calls)
    expect(sessions.map((c) => c.url.split('/presence/')[1])).toEqual([
      'setPresence',
      'clearPresence'
    ])
    expect(sessions[1].body).toEqual({ sessionId: 'app-client-id' })
    // 404 counted as success → a further poke does nothing more.
    await reconcilePresence(deps, null)
    expect(sessionCalls(calls)).toHaveLength(2)
  })

  it('clears with empty content on stop — but only after having set something', async () => {
    const { deps, calls } = makeDeps()
    // Idle, never set → must not change Teams. Since #317 the first poke of a
    // run may READ the presence (to withdraw a status a crash left behind),
    // but it writes nothing.
    await reconcilePresence(deps, null)
    expect(writes(calls)).toHaveLength(0)
    await reconcilePresence(deps, RUNNING)
    await reconcilePresence(deps, null)
    const set = statusCalls(calls)
    expect(set).toHaveLength(2)
    expect(
      (set[1].body as { statusMessage: { message: { content: string } } }).statusMessage.message
        .content
    ).toBe('')
  })

  it('switching the feature off clears our own message once', async () => {
    const on = makeDeps()
    await reconcilePresence(on.deps, RUNNING)
    // Same module state, feature now disabled:
    const off = makeDeps({ enabled: false })
    await reconcilePresence(off.deps, RUNNING)
    await reconcilePresence(off.deps, RUNNING)
    expect(statusCalls(off.calls)).toHaveLength(1)
    expect(
      (statusCalls(off.calls)[0].body as { statusMessage: { message: { content: string } } })
        .statusMessage.message.content
    ).toBe('')
  })

  it('does nothing for personal accounts, missing connection, or missing scope', async () => {
    for (const opts of [{ personal: true }, { connected: false }, { scopes: ['Calendars.Read'] }]) {
      resetPresenceStateForTests()
      const { deps, calls } = makeDeps(opts)
      await reconcilePresence(deps, RUNNING)
      expect(calls).toHaveLength(0)
    }
  })

  it('logs the missing scope so the user can find out why nothing happens', async () => {
    const { deps, logs } = makeDeps({ scopes: ['Calendars.Read'] })
    await reconcilePresence(deps, RUNNING)
    expect(logs.some((l) => l.includes('reconnect required'))).toBe(true)
  })

  it('a failed write is not marked applied — the next poke retries', async () => {
    const failing = makeDeps({ failWith: 500 })
    await reconcilePresence(failing.deps, RUNNING)
    const ok = makeDeps()
    await reconcilePresence(ok.deps, RUNNING)
    expect(statusCalls(ok.calls)).toHaveLength(1)
  })

  it('never throws when fetch rejects', async () => {
    const { deps } = makeDeps()
    deps.fetchFn = (async () => {
      throw new Error('offline')
    }) as typeof fetch
    await expect(reconcilePresence(deps, RUNNING)).resolves.toBeUndefined()
  })

  // ── #316: stop must not erase a message the user wrote ─────────────────
  it('stop leaves a status message the user wrote meanwhile, and still ends our Busy session', async () => {
    const { deps, calls } = makeDeps({ showClient: true })
    await reconcilePresence(deps, RUNNING)
    teams.content = 'Back at 3, ping me in chat' // typed in Teams while the timer ran
    await reconcilePresence(deps, null)

    expect(teams.content).toBe('Back at 3, ping me in chat')
    expect(statusCalls(calls)).toHaveLength(1) // only the set at start
    expect(sessionCalls(calls).map((c) => c.url.split('/presence/')[1])).toEqual([
      'setPresence',
      'clearPresence'
    ])
  })

  it('stop still clears our own message when it is unchanged', async () => {
    const { deps } = makeDeps({ showClient: true })
    await reconcilePresence(deps, RUNNING)
    expect(teams.content).toBe('🔴 Fokus: Acme — Rollout')
    await reconcilePresence(deps, null)
    expect(teams.content).toBeNull()
  })

  it('stop recognises our own message when Graph returns it HTML-wrapped', async () => {
    teams.html = true
    const { deps } = makeDeps({ showClient: true })
    await reconcilePresence(deps, RUNNING)
    await reconcilePresence(deps, null)
    expect(teams.content).toBeNull()
  })

  it('stop leaves a user message when Graph returns it HTML-wrapped', async () => {
    teams.html = true
    const { deps } = makeDeps()
    await reconcilePresence(deps, RUNNING)
    teams.content = 'In a workshop'
    await reconcilePresence(deps, null)
    expect(teams.content).toBe('In a workshop')
  })

  it('stop with an unreadable presence ends Busy, keeps the message and retries it at the next poke', async () => {
    const { deps } = makeDeps()
    await reconcilePresence(deps, RUNNING)
    const inner = deps.fetchFn!
    let readFails = true
    deps.fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (readFails && String(url).endsWith('/presence') && (init?.method ?? 'GET') === 'GET') {
        await inner(url, init)
        return new Response('', { status: 503 })
      }
      return inner(url, init)
    }) as typeof fetch
    await reconcilePresence(deps, null)
    expect(teams.availability).toBe('Available')
    expect(teams.content).toBe('🔴 Fokus')

    readFails = false
    await reconcilePresence(deps, null)
    expect(teams.content).toBeNull()
  })

  it('a client name with angle brackets is still recognised as ours, plain and HTML', async () => {
    const odd = { ...RUNNING, client_name: 'Foo <Bar>', project_name: 'A & B' }
    for (const html of [false, true]) {
      resetPresenceStateForTests()
      resetTeams()
      teams.html = html
      const { deps } = makeDeps({ showClient: true })
      await reconcilePresence(deps, odd)
      await reconcilePresence(deps, null)
      expect(teams.content).toBeNull()
    }
  })

  it('an entity that names no character does not break the read', async () => {
    const { deps } = makeDeps()
    await reconcilePresence(deps, RUNNING)
    teams.content = 'note &#9999999; and &#xFFFFFFF;'
    await reconcilePresence(deps, null)
    expect(teams.content).toBe('note &#9999999; and &#xFFFFFFF;')
    expect(teams.availability).toBe('Available')
  })

  it('overlapping pokes are serialised: a sweep still reading cannot clear a fresh message', async () => {
    teams.content = '🔴 Fokus' // leftover from a previous run
    const { deps } = makeDeps({ showClient: true })
    // Fire-and-forget like index.ts: the start-up poke and a timer start overlap.
    const sweep = reconcilePresence(deps, null)
    const start = reconcilePresence(deps, RUNNING)
    await Promise.all([sweep, start])
    expect(teams.content).toBe('🔴 Fokus: Acme — Rollout')
    expect(teams.availability).toBe('Busy')
  })

  // ── #317: a status left behind by a crash or quit ────────────────────────
  it('first poke of a run withdraws our own message left from the previous run', async () => {
    teams.content = '🔴 Fokus: Acme — Rollout' // the app crashed with this standing
    teams.availability = 'Busy'
    const { deps, calls } = makeDeps()
    await reconcilePresence(deps, null)

    expect(teams.content).toBeNull()
    expect(teams.availability).toBe('Available')
    expect(sessionCalls(calls)[0].body).toEqual({ sessionId: 'app-client-id' })
    // Once per run: a further idle poke does not read again.
    const reads = calls.length
    await reconcilePresence(deps, null)
    expect(calls.length).toBe(reads)
  })

  it('first poke of a run recognises our leftover message when Graph returns it HTML-wrapped', async () => {
    teams.html = true
    teams.content = '🔴 Focus: Acme'
    const { deps } = makeDeps()
    await reconcilePresence(deps, null)
    expect(teams.content).toBeNull()
  })

  it('first poke of a run leaves a message the user wrote, but ends our old Busy session', async () => {
    teams.content = 'Out until Monday'
    teams.availability = 'Busy' // our session from the crashed run
    const { deps, calls } = makeDeps()
    await reconcilePresence(deps, null)
    expect(teams.content).toBe('Out until Monday')
    expect(statusCalls(calls)).toHaveLength(0)
    expect(teams.availability).toBe('Available')
  })

  it('a failed set at the first poke leaves the leftover to the next poke', async () => {
    teams.content = '🔴 Fokus: Old — Leftover'
    teams.availability = 'Busy'
    const failing = makeDeps({ failWith: 503 })
    await reconcilePresence(failing.deps, RUNNING) // restart with a timer, offline
    const ok = makeDeps()
    await reconcilePresence(ok.deps, null) // back online, timer stopped
    expect(teams.content).toBeNull()
    expect(teams.availability).toBe('Available')
  })

  it('feature off at start: no read, no write', async () => {
    teams.content = '🔴 Fokus'
    const { deps, calls } = makeDeps({ enabled: false })
    await reconcilePresence(deps, null)
    expect(calls).toHaveLength(0)
    expect(teams.content).toBe('🔴 Fokus')
  })

  it('an unreadable presence at start is retried at the next poke', async () => {
    teams.content = '🔴 Focus'
    const failing = makeDeps({ failWith: 503 })
    await reconcilePresence(failing.deps, null)
    expect(teams.content).toBe('🔴 Focus')
    const ok = makeDeps()
    await reconcilePresence(ok.deps, null)
    expect(teams.content).toBeNull()
  })

  // ── #318: client and project names stay out of main.log ─────────────────
  it('the read-back log says whether Teams holds our message, never its text', async () => {
    const { deps, logs } = makeDeps({ showClient: true })
    await reconcilePresence(deps, RUNNING)
    await reconcilePresence(deps, null)
    const all = logs.join('\n')
    expect(all).not.toContain('Acme')
    expect(all).not.toContain('Rollout')
    expect(logs.some((l) => /read-back .*statusMessage=matches/.test(l))).toBe(true)
  })

  it('privacy switch mid-run re-renders the message', async () => {
    const generic = makeDeps({ showClient: false })
    await reconcilePresence(generic.deps, RUNNING)
    const withClient = makeDeps({ showClient: true })
    await reconcilePresence(withClient.deps, RUNNING)
    const set = statusCalls(withClient.calls)
    expect(set).toHaveLength(1)
    expect(
      (set[0].body as { statusMessage: { message: { content: string } } }).statusMessage.message
        .content
    ).toBe('🔴 Fokus: Acme — Rollout')
  })
})
