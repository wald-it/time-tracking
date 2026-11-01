/**
 * iCal Stufe 2 (#169) — subscribable webcal:// feed on a local HTTP server.
 *
 * A calendar client (Outlook, Apple Calendar) polls
 * `http://127.0.0.1:<port>/feed.ics?token=<token>` and gets the last 90 days
 * of completed entries across all clients, rendered by the same formatter as
 * the static export (shared/ical.ts). Running timers and deleted entries are
 * excluded there and here alike.
 *
 * Security model: the server binds to 127.0.0.1 only, and the token rides in
 * the URL because calendar clients cannot send custom headers. The token is
 * persistent (subscribers store the URL) and read through secretSettings;
 * regenerating it invalidates every existing subscription. Read-only by
 * construction — there is no write path.
 *
 * Lifecycle mirrors the MCP bridge: the feed exists only while the app runs,
 * started on boot when enabled and torn down on disable/quit (index.ts).
 */
import http from 'http'
import { randomBytes } from 'crypto'
import type Database from 'better-sqlite3'
import { formatIcal } from '../shared/ical'
import type { Client, Entry } from '../shared/types'

export const FEED_PATH = '/feed.ics'
export const DEFAULT_FEED_PORT = 27182
/** Rolling window: how far back the feed reaches. */
const FEED_WINDOW_DAYS = 90

export interface FeedDeps {
  getDb: () => Database.Database
  getSetting: (key: string) => string | undefined
  log?: (message: string) => void
}

export interface FeedResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export function effectiveFeedPort(getSetting: FeedDeps['getSetting']): number {
  const raw = Number.parseInt(getSetting('ical_feed_port') ?? '', 10)
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_FEED_PORT
}

export function generateFeedToken(): string {
  return randomBytes(24).toString('hex')
}

/** The URL to paste into a calendar client. */
export function feedUrl(getSetting: FeedDeps['getSetting']): string {
  const token = getSetting('ical_feed_token') ?? ''
  return `webcal://127.0.0.1:${effectiveFeedPort(getSetting)}${FEED_PATH}?token=${token}`
}

/**
 * Pure request handler — no sockets, fully testable. Token comparison is the
 * only authentication. Production dependencies resolve it through secretSettings.
 */
export function buildFeedResponse(deps: FeedDeps, rawUrl: string): FeedResponse {
  const url = new URL(rawUrl, 'http://127.0.0.1')
  if (url.pathname !== FEED_PATH) {
    return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'Not found' }
  }
  const expected = deps.getSetting('ical_feed_token') ?? ''
  if (deps.getSetting('ical_feed_enabled') !== '1' || expected === '') {
    return { status: 403, headers: { 'Content-Type': 'text/plain' }, body: 'Feed disabled' }
  }
  if (url.searchParams.get('token') !== expected) {
    return { status: 401, headers: { 'Content-Type': 'text/plain' }, body: 'Invalid token' }
  }

  const db = deps.getDb()
  const entries = db
    .prepare(
      `SELECT * FROM entries
       WHERE date(started_at) >= date('now', ?)
         AND deleted_at IS NULL
         AND stopped_at IS NOT NULL
       ORDER BY started_at ASC`
    )
    .all(`-${FEED_WINDOW_DAYS} days`) as Entry[]

  const clientMap = new Map<number, Client>()
  for (const c of db.prepare(`SELECT * FROM clients`).all() as Client[]) clientMap.set(c.id, c)
  const projectMap = new Map<number, string>()
  for (const p of db.prepare(`SELECT id, name FROM projects`).all() as Array<{
    id: number
    name: string
  }>) {
    projectMap.set(p.id, p.name)
  }

  return {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'no-store'
    },
    body: formatIcal(entries, clientMap, projectMap)
  }
}

let server: http.Server | null = null

/** Start the feed server. Idempotent; binds 127.0.0.1 only. */
export function startFeedServer(deps: FeedDeps): void {
  if (server) return
  const log = deps.log ?? ((): void => {})
  const srv = http.createServer((req, res) => {
    let out: FeedResponse
    try {
      out = buildFeedResponse(deps, req.url ?? '/')
    } catch (err) {
      log(`[ical-feed] request failed: ${err instanceof Error ? err.message : String(err)}`)
      out = { status: 500, headers: { 'Content-Type': 'text/plain' }, body: 'Internal error' }
    }
    res.writeHead(out.status, out.headers)
    res.end(out.body)
  })
  srv.on('error', (err) => {
    // Typical case: port already in use. The feed stays down; the log says why.
    log(`[ical-feed] server error: ${err.message}`)
    server = null
  })
  const port = effectiveFeedPort(deps.getSetting)
  srv.listen(port, '127.0.0.1', () => log(`[ical-feed] listening on 127.0.0.1:${port}`))
  server = srv
}

/** Stop the feed server. Idempotent. */
export function stopFeedServer(): void {
  if (!server) return
  try {
    server.close()
  } catch {
    // ignore
  }
  server = null
}

/** Restart with current settings (port change, token rotation). */
export function restartFeedServer(deps: FeedDeps): void {
  stopFeedServer()
  startFeedServer(deps)
}
