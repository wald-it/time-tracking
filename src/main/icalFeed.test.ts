/**
 * Tests for the subscribable iCal feed (#169). The request handler is pure
 * (no sockets) — an in-memory migrated DB plus a settings map is the whole
 * world. The live HTTP round-trip is covered once via a real server on the
 * configured port resolver.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import {
  buildFeedResponse,
  effectiveFeedPort,
  feedUrl,
  generateFeedToken,
  DEFAULT_FEED_PORT,
  FEED_PATH,
  type FeedDeps
} from './icalFeed'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

function seed(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  db.prepare(
    `INSERT INTO clients (id, name, color, active, rate_cent) VALUES (1,'Acme','#111',1,0)`
  ).run()
  db.prepare(
    `INSERT INTO projects (id, client_id, name, status, active) VALUES (10, 1, 'Rollout', 'active', 1)`
  ).run()
  // 2.0 P2: the fixture stores timestamps verbatim, so evaluate the relative
  // SQLite datetimes here (same 'YYYY-MM-DD HH:MM:SS' shape the 1.x rows had).
  // rounded_min (60/60/0) is gone: the view always reports NULL for it.
  const at = (...mods: string[]): string =>
    db
      .prepare(`SELECT datetime('now'${mods.map((m) => `, '${m}'`).join('')})`)
      .pluck()
      .get() as string
  // Recent, completed → in the feed.
  seedEntry(db, {
    client_id: 1,
    project_id: 10,
    description: 'Feature',
    started_at: at('-2 days'),
    stopped_at: at('-2 days', '+1 hour')
  })
  // Outside the 90-day window → excluded.
  seedEntry(db, {
    client_id: 1,
    description: 'Ancient',
    started_at: at('-120 days'),
    stopped_at: at('-120 days', '+1 hour')
  })
  // Running → excluded.
  seedEntry(db, { client_id: 1, description: 'Running', started_at: at() })
}

function makeDeps(db: Database.Database, settings: Record<string, string> = {}): FeedDeps {
  const s: Record<string, string> = {
    ical_feed_enabled: '1',
    ical_feed_token: 'feedtoken',
    ical_feed_port: '',
    ...settings
  }
  return { getDb: () => db, getSetting: (k) => s[k] }
}

describe('icalFeed', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
  })

  it('serves the last 90 days of completed entries as text/calendar', () => {
    const res = buildFeedResponse(makeDeps(db), `${FEED_PATH}?token=feedtoken`)
    expect(res.status).toBe(200)
    expect(res.headers['Content-Type']).toContain('text/calendar')
    expect(res.body).toContain('BEGIN:VCALENDAR')
    expect(res.body).toContain('Acme')
    expect(res.body).toContain('Rollout')
    expect(res.body).not.toContain('Ancient')
    expect(res.body).not.toContain('Running')
  })

  it('rejects a wrong or missing token with 401', () => {
    expect(buildFeedResponse(makeDeps(db), `${FEED_PATH}?token=wrong`).status).toBe(401)
    expect(buildFeedResponse(makeDeps(db), FEED_PATH).status).toBe(401)
  })

  it('answers 403 when disabled or when no token was ever minted', () => {
    expect(
      buildFeedResponse(makeDeps(db, { ical_feed_enabled: '0' }), `${FEED_PATH}?token=feedtoken`)
        .status
    ).toBe(403)
    expect(
      buildFeedResponse(makeDeps(db, { ical_feed_token: '' }), `${FEED_PATH}?token=`).status
    ).toBe(403)
  })

  it('answers 404 off the feed path', () => {
    expect(buildFeedResponse(makeDeps(db), '/anything?token=feedtoken').status).toBe(404)
  })

  it('port resolver: override wins, garbage falls back to the default', () => {
    expect(effectiveFeedPort(() => '8123')).toBe(8123)
    expect(effectiveFeedPort(() => '')).toBe(DEFAULT_FEED_PORT)
    expect(effectiveFeedPort(() => 'abc')).toBe(DEFAULT_FEED_PORT)
    expect(effectiveFeedPort(() => '0')).toBe(DEFAULT_FEED_PORT)
    expect(effectiveFeedPort(() => '70000')).toBe(DEFAULT_FEED_PORT)
  })

  it('feedUrl carries scheme, port and token', () => {
    const deps = makeDeps(db, { ical_feed_port: '8123' })
    expect(feedUrl(deps.getSetting)).toBe('webcal://127.0.0.1:8123/feed.ics?token=feedtoken')
  })

  it('generateFeedToken yields 48 hex chars, unique per call', () => {
    const a = generateFeedToken()
    expect(a).toMatch(/^[0-9a-f]{48}$/)
    expect(generateFeedToken()).not.toBe(a)
  })
})
