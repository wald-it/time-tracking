/**
 * #331 — randomised failure sequences against the presence reconciler.
 *
 * Review rounds on #316–#318 kept finding new orders in which a request
 * reached Teams but its answer was lost (or failed) and the module forgot
 * what it owned or still owed. Instead of one test per order, this drives
 * many seeded random sequences against a fake Teams and checks invariants.
 * A failure prints its seed and the step log; rerun one seed with
 * PRESENCE_SEED=<n>.
 *
 * The fake Teams holds a status message, TimeTrack's Busy session, and an
 * availability the user set (which hides the Busy). Every request can
 * succeed, be lost before Teams sees it, or reach Teams and lose its answer.
 *
 * Its semantics, against Microsoft Graph v1.0 (learn.microsoft.com, pages
 * updated 2025-08/09, read 2026-10-23):
 *  - setPresence: "Provide the ID of the application as sessionId"; sets that
 *    application's presence session (presence-setpresence).
 *  - clearPresence: "Clear the application's presence session for a user";
 *    "If the presence session doesn't exist, this method returns a 404
 *    NotFound" (presence-clearpresence). So it touches only our session.
 *  - setUserPreferredPresence: "If the preferred presence of a user is set,
 *    the user's presence shows as the preferred status" — the user's own
 *    availability hides our Busy (presence-setuserpreferredpresence).
 *  - setStatusMessage: "An optional expiration date and time can be
 *    supplied"; without one the message stays (presence-setstatusmessage).
 *    The fake does not model expiry at all, which only makes it stricter.
 * Simplifications and guesses, not from the docs:
 *  - Clearing with empty content is community practice, not documented.
 *  - After clearPresence the fake shows "Available"; Graph shows
 *    "Offline/Offline" when it was the only session. No check here depends
 *    on that value, only on "Busy" and the user's own availability.
 *  - Writes are atomic and the next GET sees them ("lost answer" means the
 *    write took effect, nothing in between). Graph documents no consistency
 *    window; a delayed write is not modelled.
 *
 * The generator also signs the account out and loses the token at times:
 * (iv) then no request at all goes out, and a token is not even asked for
 * while signed out. Every poke stays a single pass (at most five requests).
 *
 * Known exception, named instead of hidden: the user types a message in
 * TimeTrack's exact form ("🔴 Fokus…"). Recognising a leftover by shape
 * (#317) cannot tell it apart, so TimeTrack may clear it. Counted and
 * reported, not a violation — and only that one case.
 *
 * Invariants, checked after a calm phase (network healthy, timer stopped,
 * a few pokes) with the feature switch as the sequence left it:
 *  (i)   No message TimeTrack sent is left in Teams if the current run knows
 *        it: it sent it, or read it back. With the feature on, no message
 *        TimeTrack ever sent (any run) is left.
 *  (ii)  A message the user wrote is never cleared by TimeTrack unless
 *        TimeTrack has written a message of its own over it since.
 *  (iii) TimeTrack's Busy session is not left behind if the current run knows
 *        it (it set it, or read Busy while it existed); with the feature on,
 *        not at all.
 * "Known" is the issue's "no in-flight request's effect is forgotten": a
 * request that may have reached Teams counts as known to the run that sent it.
 * Leftovers of an earlier run that the current run never saw, with the
 * feature off, may stay until Teams lets them expire — by design (#317).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { reconcilePresence, resetPresenceStateForTests, type PresenceDeps } from './graphPresence'
import type { RunningStatus } from './mcpBridgeCore'

// ── seeded randomness ──────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── the fake Teams ─────────────────────────────────────────────────────────
interface Teams {
  content: string | null
  /** Who wrote the current message: TimeTrack or the user. */
  author: 'tt' | 'user' | null
  session: boolean
  userAvailability: string | null
}

type Outcome = 'ok' | 'lostBefore' | 'lostAfter'

const CLIENTS = ['Acme', 'Beta', 'Gamma']
const USER_TEXTS = ['Back at 3', 'Out until Monday', '<OOO>', 'In a workshop']
/** Messages a user could type that are exactly in TimeTrack's form. */
const USER_TEXTS_IN_OUR_FORM = ['🔴 Fokus', '🔴 Fokus: Acme — Rollout']
const OUR_FORM = /^🔴 (Fokus|Focus)(: .+)?$/u
const MAX_REQUESTS_PER_POKE = 5

function running(client: string): RunningStatus {
  return {
    id: 1,
    client_id: 1,
    project_id: 1,
    description: '',
    started_at: '2026-10-23T09:00:00.000Z',
    client_name: client,
    project_name: 'Rollout'
  }
}

interface World {
  teams: Teams
  /** Every message TimeTrack's requests may have put into Teams, any run. */
  everSent: Set<string>
  /** What the current run knows it owns or owes. */
  knownTexts: Set<string>
  knownSession: boolean
  /** A user message and whether TimeTrack has written over it since. */
  userText: string | null
  overwrittenSince: boolean
  violations: string[]
  /** User messages in TimeTrack's form that TimeTrack cleared (accepted, #317). */
  exceptions: number
  log: string[]
  network: () => Outcome
  readFails: () => boolean
  enabled: boolean
  showClient: boolean
  connected: boolean
  hasToken: boolean
  /** Requests and token requests during the current poke. */
  requests: number
  tokenAsks: number
  now: number
}

function makeDeps(w: World): PresenceDeps {
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    w.requests++
    if (u.includes('/me?$select=id')) {
      return new Response(JSON.stringify({ id: 'user-1' }), { status: 200 })
    }
    if (method === 'GET' && u.endsWith('/presence')) {
      if (w.readFails()) {
        w.log.push('  GET presence → fail')
        return new Response('', { status: 503 })
      }
      const availability = w.teams.userAvailability ?? (w.teams.session ? 'Busy' : 'Available')
      // What TimeTrack reads, it knows (invariants i/iii).
      if (w.teams.content !== null && w.teams.author === 'tt') w.knownTexts.add(w.teams.content)
      if (w.teams.session && availability === 'Busy') w.knownSession = true
      w.log.push(`  GET presence → ${JSON.stringify(w.teams.content)} ${availability}`)
      return new Response(
        JSON.stringify({
          availability,
          statusMessage:
            w.teams.content === null
              ? null
              : { message: { content: w.teams.content, contentType: 'text' } }
        }),
        { status: 200 }
      )
    }
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const outcome = w.network()
    const action = u.split('/presence/')[1]
    w.log.push(
      `  POST ${action} ${JSON.stringify(body?.statusMessage?.message?.content ?? '')} → ${outcome}`
    )
    if (outcome !== 'lostBefore') {
      if (action === 'setStatusMessage') {
        const content: string = body.statusMessage.message.content
        if (content === '') {
          if (w.teams.author === 'user' && !w.overwrittenSince) {
            if (w.teams.content !== null && OUR_FORM.test(w.teams.content)) {
              w.exceptions++
              w.log.push('  (accepted: the user had typed TimeTrack’s form)')
            } else {
              w.violations.push(
                `(ii) cleared the user's message ${JSON.stringify(w.teams.content)}`
              )
            }
          }
          w.teams.content = null
          w.teams.author = null
        } else {
          w.everSent.add(content)
          w.knownTexts.add(content)
          if (w.userText !== null) w.overwrittenSince = true
          w.teams.content = content
          w.teams.author = 'tt'
        }
      } else if (action === 'setPresence') {
        w.teams.session = true
        w.knownSession = true
      } else if (action === 'clearPresence') {
        const had = w.teams.session
        w.teams.session = false
        if (!had && outcome === 'ok') return new Response('', { status: 404 })
      }
    } else if (action === 'setStatusMessage' && body.statusMessage.message.content !== '') {
      // Sent but lost before Teams: it never got there, but TimeTrack cannot
      // know that — it may count it as possibly ours (harmless).
    }
    if (outcome === 'ok') return new Response('', { status: 200 })
    if (outcome === 'lostAfter' && w.network() === 'ok') throw new Error('TimeoutError')
    return new Response('', { status: 503 })
  }) as typeof fetch

  return {
    getSetting: (k) =>
      k === 'presence_enabled'
        ? w.enabled
          ? '1'
          : '0'
        : k === 'presence_show_client'
          ? w.showClient
            ? '1'
            : '0'
          : k === 'language'
            ? 'de'
            : undefined,
    getAccountStatus: () => ({
      connected: w.connected,
      personalAccount: false,
      grantedScopes: ['Presence.ReadWrite']
    }),
    getAccessToken: async () => {
      w.tokenAsks++
      return w.hasToken ? 'tok' : null
    },
    getClientId: () => 'app-client-id',
    fetchFn,
    now: () => w.now,
    log: (m) => w.log.push(`    log: ${m}`)
  }
}

// ── one sequence ───────────────────────────────────────────────────────────
const STEPS = 25
const CALM_POKES = 3

async function runSequence(
  seed: number
): Promise<{ violations: string[]; exceptions: number; log: string[] }> {
  const rnd = mulberry32(seed)
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
  let failRate = 0.3
  const w: World = {
    teams: { content: null, author: null, session: false, userAvailability: null },
    everSent: new Set(),
    knownTexts: new Set(),
    knownSession: false,
    userText: null,
    overwrittenSince: false,
    violations: [],
    exceptions: 0,
    log: [],
    network: () => {
      const r = rnd()
      return r < failRate / 2 ? 'lostBefore' : r < failRate ? 'lostAfter' : 'ok'
    },
    readFails: () => rnd() < failRate / 2,
    enabled: true,
    showClient: rnd() < 0.5,
    connected: true,
    hasToken: true,
    requests: 0,
    tokenAsks: 0,
    now: 1_750_000_000_000
  }
  /** One poke, with the per-poke invariants (iv). */
  const poke = async (step: string): Promise<void> => {
    w.requests = 0
    w.tokenAsks = 0
    await reconcilePresence(deps, timer)
    if (!w.connected && (w.requests > 0 || w.tokenAsks > 0)) {
      w.violations.push(
        `(iv) ${step}: signed out, yet ${w.requests} requests, ${w.tokenAsks} token asks`
      )
    } else if (!w.hasToken && w.requests > 0) {
      w.violations.push(`(iv) ${step}: no token, yet ${w.requests} requests`)
    } else if (w.requests > MAX_REQUESTS_PER_POKE) {
      w.violations.push(`(iv) ${step}: ${w.requests} requests in one poke`)
    }
  }
  resetPresenceStateForTests()
  const deps = makeDeps(w)
  let timer: RunningStatus | null = null

  for (let step = 0; step < STEPS; step++) {
    w.now += Math.floor(rnd() * 30) * 60 * 1000 // 0–29 minutes pass
    const r = rnd()
    if (r < 0.3) {
      timer = running(pick(CLIENTS))
      w.log.push(`step ${step}: start ${timer.client_name}`)
    } else if (r < 0.5) {
      timer = null
      w.log.push(`step ${step}: stop`)
    } else if (r < 0.6) {
      // Rarely, the user types TimeTrack's exact form (the #317 limit).
      const text = rnd() < 0.05 ? pick(USER_TEXTS_IN_OUR_FORM) : pick(USER_TEXTS)
      w.teams.content = text
      w.teams.author = 'user'
      w.userText = text
      w.overwrittenSince = false
      w.log.push(`step ${step}: user writes ${JSON.stringify(text)}`)
    } else if (r < 0.66) {
      w.teams.userAvailability = pick([null, 'DoNotDisturb', 'Away'])
      w.log.push(`step ${step}: user availability ${w.teams.userAvailability}`)
    } else if (r < 0.72) {
      w.enabled = !w.enabled
      w.log.push(`step ${step}: feature ${w.enabled ? 'on' : 'off'}`)
    } else if (r < 0.78) {
      // Crash or quit: the module forgets, Teams keeps everything.
      resetPresenceStateForTests()
      w.knownTexts = new Set()
      w.knownSession = false
      timer = null
      w.log.push(`step ${step}: restart`)
    } else if (r < 0.83) {
      w.connected = !w.connected
      w.log.push(`step ${step}: ${w.connected ? 'signed in' : 'signed out'}`)
    } else if (r < 0.88) {
      w.hasToken = !w.hasToken
      w.log.push(`step ${step}: token ${w.hasToken ? 'back' : 'lost'}`)
    } else {
      w.log.push(`step ${step}: poke`)
    }
    await poke(`step ${step}`)
  }

  // Calm phase: healthy network, signed in, timer stopped, a few pokes.
  failRate = 0
  w.connected = true
  w.hasToken = true
  timer = null
  w.log.push('calm: timer stopped, signed in, network healthy')
  for (let i = 0; i < CALM_POKES; i++) {
    w.now += 60 * 1000
    await poke(`calm ${i}`)
  }

  const left = w.teams.content
  if (left !== null && w.teams.author === 'tt') {
    if (w.enabled && w.everSent.has(left)) {
      w.violations.push(`(i) feature on, TimeTrack's message left: ${JSON.stringify(left)}`)
    } else if (w.knownTexts.has(left)) {
      w.violations.push(`(i) known TimeTrack message left: ${JSON.stringify(left)}`)
    }
  }
  if (w.teams.session && (w.enabled || w.knownSession)) {
    w.violations.push(`(iii) Busy session left (feature ${w.enabled ? 'on' : 'off'})`)
  }
  return { violations: w.violations, exceptions: w.exceptions, log: w.log }
}

describe('presence under random failure sequences (#331)', () => {
  beforeEach(() => resetPresenceStateForTests())

  const only = process.env.PRESENCE_SEED
  const seeds = only ? [Number(only)] : Array.from({ length: 400 }, (_, i) => i + 1)

  it(`holds the invariants over ${seeds.length} seeded sequences`, async () => {
    const failures: Array<{ head: string; log: string }> = []
    let exceptions = 0
    for (const seed of seeds) {
      const result = await runSequence(seed)
      exceptions += result.exceptions
      if (result.violations.length > 0) {
        failures.push({
          head: `seed ${seed}: ${result.violations.join('; ')}`,
          log: result.log.join('\n')
        })
      }
    }
    // The accepted #317 exception, reported rather than hidden.
    console.info(
      `#331: ${exceptions} user message(s) in TimeTrack's exact form cleared over ${seeds.length} seeds (accepted, shape not identity)`
    )
    expect(
      failures.length,
      failures.length > 0
        ? `${failures.length} of ${seeds.length} seeds fail (rerun one with PRESENCE_SEED=<n>):\n` +
            failures.map((f) => f.head).join('\n') +
            `\n\nStep log of the first:\n${failures[0].log}`
        : ''
    ).toBe(0)
    // The generator must actually reach the accepted exception, or the
    // oracle is blind to it (12 of 400 seeds at the time of writing). Only
    // with all seeds: a single PRESENCE_SEED rarely contains it.
    if (!only) {
      expect(exceptions, 'no user message in TimeTrack’s form was ever cleared').toBeGreaterThan(0)
    }
  }, 120_000)
})
