import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { StoredTokens } from '../shared/graphAuth'
import type { GraphEvent } from '../shared/graphCalendar'
import { saveTokens, type AsyncSecretBox } from './graphTokenStore'
import type { GraphAccountDeps } from './graphAccount'
import { GraphCalendarError, type CalendarRange } from './graphCalendar'
import {
  importCalendarEntries,
  importedEventIds,
  ownDomains,
  previewCalendarImport
} from './graphImport'
import { learnDomain } from './clientDomains'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import { ANCHOR_REUSED_ERROR, writeEntry } from './entryMutations'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

function fakeBox(): AsyncSecretBox {
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (plain) =>
      Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`),
    decryptStringAsync: async (cipher) => {
      const s = cipher.toString('utf8')
      if (!s.startsWith('enc:')) throw new Error('bad ciphertext')
      return { result: Buffer.from(s.slice(4), 'base64').toString('utf8'), shouldReEncrypt: false }
    }
  }
}

const NOW = 1_800_000_000_000

function tokens(over: Partial<StoredTokens> = {}): StoredTokens {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAtMs: NOW + 3600_000,
    grantedScopes: ['Calendars.Read', 'offline_access'],
    account: { username: 'robin@wald-it.com', displayName: 'Robin', tenantId: 'tid-1' },
    ...over
  }
}

function pageResponse(events: GraphEvent[], nextLink?: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ value: events, ...(nextLink ? { '@odata.nextLink': nextLink } : {}) })
  } as unknown as Response
}

function event(over: Partial<GraphEvent> = {}): GraphEvent {
  return {
    id: 'evt-1',
    subject: 'Jour fixe',
    isAllDay: false,
    isCancelled: false,
    showAs: 'busy',
    start: { dateTime: '2026-07-01T09:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-07-01T10:00:00.0000000', timeZone: 'UTC' },
    organizer: { emailAddress: { name: 'Alice', address: 'alice@kunde.de' } },
    attendees: [
      {
        type: 'required',
        status: { response: 'accepted' },
        emailAddress: { name: 'Robin', address: 'robin@wald-it.com' }
      }
    ],
    responseStatus: { response: 'accepted' },
    ...over
  }
}

const RANGE: CalendarRange = {
  startIso: '2026-07-01T00:00:00Z',
  endIso: '2026-07-08T00:00:00Z'
}

describe('graphImport', () => {
  let tmpDir: string
  let db: Database.Database
  let storeDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-graph-import-'))
    storeDir = join(tmpDir, 'store')
    mkdirSync(storeDir, { recursive: true })
    db = new DatabaseImpl(join(tmpDir, 'test.db'))
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Kunde X')`).run()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  async function accountDeps(connected = true): Promise<GraphAccountDeps> {
    const store = { dir: storeDir, secretBox: fakeBox() }
    if (connected) await saveTokens(tokens(), store)
    return {
      getSetting: () => undefined,
      openExternal: () => {},
      store,
      auth: { now: () => NOW }
    }
  }

  describe('importedEventIds', () => {
    it('collects ids of live entries and ignores soft-deleted ones', () => {
      // 2.0 P2: `entries` is a read-only view; the fixture writes the entry tables.
      seedEntry(db, {
        client_id: 1,
        started_at: '2026-07-01T09:00:00Z',
        stopped_at: '2026-07-01T10:00:00Z',
        graph_event_id: 'evt-live'
      })
      seedEntry(db, {
        client_id: 1,
        started_at: '2026-07-02T09:00:00Z',
        stopped_at: '2026-07-02T10:00:00Z',
        graph_event_id: 'evt-deleted',
        deleted_at: '2026-07-03T00:00:00Z'
      })
      seedEntry(db, {
        client_id: 1,
        started_at: '2026-07-03T09:00:00Z',
        stopped_at: '2026-07-03T10:00:00Z'
      })
      // The deleted entry's event must be offered again — deleting meant
      // "not this one", not "never again" (see migration 021).
      expect(importedEventIds(db)).toEqual(new Set(['evt-live']))
    })
  })

  describe('ownDomains', () => {
    it('derives the own domain from the connected account', async () => {
      expect(await ownDomains(await accountDeps())).toEqual(['wald-it.com'])
    })

    it('is empty when nothing is connected', async () => {
      expect(await ownDomains(await accountDeps(false))).toEqual([])
    })
  })

  describe('previewCalendarImport', () => {
    it('rejects an invalid range before touching the network', async () => {
      const deps = { account: await accountDeps() }
      await expect(
        previewCalendarImport(db, { startIso: 'quatsch', endIso: RANGE.endIso }, deps)
      ).rejects.toThrow(/Zeitraum/)
      await expect(
        previewCalendarImport(db, { startIso: RANGE.endIso, endIso: RANGE.startIso }, deps)
      ).rejects.toThrow(/Zeitraum/)
    })

    it('says plainly when no account is connected', async () => {
      await expect(
        previewCalendarImport(db, RANGE, { account: await accountDeps(false) })
      ).rejects.toThrow(/Kein Microsoft-Konto verbunden/)
    })

    it('maps events into drafts: own domain stripped, mapping applied, dedupe honored', async () => {
      learnDomain(db, 'kunde.de', 1)
      seedEntry(db, {
        client_id: 1,
        started_at: '2026-07-01T09:00:00Z',
        stopped_at: '2026-07-01T10:00:00Z',
        graph_event_id: 'evt-done'
      })

      const events = [
        event(),
        event({ id: 'evt-done', subject: 'Schon übernommen' }),
        event({
          id: 'evt-unknown',
          subject: 'Neue Firma',
          organizer: { emailAddress: { name: 'Bob', address: 'bob@neu.io' } },
          start: { dateTime: '2026-07-02T09:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-07-02T09:30:00.0000000', timeZone: 'UTC' }
        })
      ]
      const fetchFn = (async () => pageResponse(events)) as unknown as typeof fetch

      const result = await previewCalendarImport(db, RANGE, {
        account: await accountDeps(),
        fetchFn
      })

      expect(result.drafts).toHaveLength(2)
      const [first, second] = result.drafts
      expect(first).toMatchObject({
        graphEventId: 'evt-1',
        description: 'Jour fixe',
        startedAt: '2026-07-01T09:00:00.000Z',
        stoppedAt: '2026-07-01T10:00:00.000Z',
        clientId: 1,
        projectId: null,
        clientHint: 'matched',
        domains: ['kunde.de']
      })
      expect(second).toMatchObject({
        graphEventId: 'evt-unknown',
        clientId: null,
        clientHint: 'unknown-domain',
        domains: ['neu.io']
      })
      expect(result.skipped).toEqual([
        { graphEventId: 'evt-done', subject: 'Schon übernommen', reason: 'already-imported' }
      ])
    })

    it('carries the mapped project into the draft (#176)', async () => {
      db.prepare(`INSERT INTO projects (id, client_id, name) VALUES (7, 1, 'Endkunde A')`).run()
      learnDomain(db, 'kunde.de', 1, 7)
      const fetchFn = (async () => pageResponse([event()])) as unknown as typeof fetch
      const result = await previewCalendarImport(db, RANGE, {
        account: await accountDeps(),
        fetchFn
      })
      expect(result.drafts[0]).toMatchObject({ clientId: 1, projectId: 7, clientHint: 'matched' })
    })

    it('passes Graph failures through as user-facing calendar errors', async () => {
      const fetchFn = (async () =>
        ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response) as typeof fetch
      await expect(
        previewCalendarImport(db, RANGE, { account: await accountDeps(), fetchFn })
      ).rejects.toThrow(GraphCalendarError)
    })
  })

  describe('importCalendarEntries', () => {
    const item = (
      over: Partial<Parameters<typeof importCalendarEntries>[1][number]> = {}
    ): Parameters<typeof importCalendarEntries>[1][number] => ({
      graphEventId: 'evt-1',
      description: 'Jour fixe',
      startedAt: '2026-07-01T09:00:00.000Z',
      stoppedAt: '2026-07-01T10:00:00.000Z',
      clientId: 1,
      ...over
    })

    it('creates an entry carrying the graph event id', () => {
      const result = importCalendarEntries(db, [item()])
      expect(result).toEqual({ created: 1, failed: [] })
      const row = db
        .prepare(`SELECT client_id, description, graph_event_id FROM entries`)
        .get() as { client_id: number; description: string; graph_event_id: string }
      expect(row).toEqual({ client_id: 1, description: 'Jour fixe', graph_event_id: 'evt-1' })
    })

    it('refuses a second import of the same event', () => {
      importCalendarEntries(db, [item()])
      const again = importCalendarEntries(db, [
        item({ startedAt: '2026-07-02T09:00:00.000Z', stoppedAt: '2026-07-02T10:00:00.000Z' })
      ])
      expect(again.created).toBe(0)
      expect(again.failed[0].error).toContain('bereits übernommen')
    })

    it('re-imports an event whose entry was soft-deleted — the anchor stays with the old entry', () => {
      importCalendarEntries(db, [item()])
      const oldId = (db.prepare(`SELECT id FROM entry`).get() as { id: number }).id
      // 2.0 P2: through the write path (op delete), not an UPDATE on the view.
      expect(writeEntry(db, { op: 'delete', id: oldId }, { source: 'app' }).ok).toBe(true)
      const again = importCalendarEntries(db, [item()])
      expect(again).toEqual({ created: 1, failed: [] })
      // 2.0 P2: the anchor belongs to the entry for good (design 4.1) and is no
      // longer released on delete; the unique index only covers live entries.
      const rows = db
        .prepare(`SELECT id, graph_event_id, is_deleted FROM entry ORDER BY id`)
        .all() as Array<{ id: number; graph_event_id: string | null; is_deleted: number }>
      expect(rows.map((r) => [r.graph_event_id, r.is_deleted])).toEqual([
        ['evt-1', 1],
        ['evt-1', 0]
      ])
      expect(rows[0].id).toBe(oldId)
      // The view shows only the live one.
      const view = db.prepare(`SELECT id, graph_event_id FROM entries`).all()
      expect(view).toEqual([{ id: rows[1].id, graph_event_id: 'evt-1' }])
    })

    it('refuses to undelete an entry whose event anchor a live entry holds again', () => {
      importCalendarEntries(db, [item()])
      const oldId = (db.prepare(`SELECT id FROM entry`).get() as { id: number }).id
      expect(writeEntry(db, { op: 'delete', id: oldId }, { source: 'app' }).ok).toBe(true)
      // Re-imported at another time, so the undelete meets the anchor and not the
      // overlap check.
      const reimport = item({
        startedAt: '2026-07-02T09:00:00.000Z',
        stoppedAt: '2026-07-02T10:00:00.000Z'
      })
      expect(importCalendarEntries(db, [reimport])).toEqual({ created: 1, failed: [] })
      const res = writeEntry(db, { op: 'undelete', id: oldId }, { source: 'app' })
      expect(res).toEqual({ ok: false, error: ANCHOR_REUSED_ERROR })
    })

    it('fails per event, not per batch — one overlap does not sink the rest', () => {
      seedEntry(db, {
        client_id: 1,
        started_at: '2026-07-01T09:30:00.000Z',
        stopped_at: '2026-07-01T11:00:00.000Z'
      })
      const result = importCalendarEntries(db, [
        item(), // overlaps the existing entry
        item({
          graphEventId: 'evt-2',
          startedAt: '2026-07-02T09:00:00.000Z',
          stoppedAt: '2026-07-02T10:00:00.000Z'
        })
      ])
      expect(result.created).toBe(1)
      expect(result.failed).toEqual([
        { graphEventId: 'evt-1', error: expect.stringContaining('überlappt') }
      ])
    })

    it('keeps one entry with two segments, both carrying the event id, when a meeting crosses midnight', () => {
      // Built from local wall-clock time so the range crosses LOCAL midnight
      // (the split boundary) no matter which timezone the test runs in.
      const start = new Date(2026, 6, 1, 23, 0)
      const stop = new Date(2026, 6, 2, 1, 0)
      const result = importCalendarEntries(db, [
        item({ startedAt: start.toISOString(), stoppedAt: stop.toISOString() })
      ])
      expect(result).toEqual({ created: 1, failed: [] })
      // 2.0 P2: one entry, two segments (view rows with the same id and
      // segment_seq 0/1); the anchor belongs to the entry, so both rows carry it
      // and there is no link_id any more.
      const rows = db
        .prepare(`SELECT id, graph_event_id, link_id, segment_seq FROM entries ORDER BY started_at`)
        .all() as Array<{
        id: number
        graph_event_id: string | null
        link_id: string | null
        segment_seq: number
      }>
      expect(rows).toHaveLength(2)
      expect(rows[0].graph_event_id).toBe('evt-1')
      expect(rows[1].graph_event_id).toBe('evt-1')
      expect(rows[0].id).toBe(rows[1].id)
      expect(rows.map((r) => r.segment_seq)).toEqual([0, 1])
      expect(rows[0].link_id).toBeNull()
      expect(rows[1].link_id).toBeNull()
      expect((db.prepare(`SELECT COUNT(*) AS n FROM entry`).get() as { n: number }).n).toBe(1)
      // And the dedupe still sees the event as imported.
      expect(importedEventIds(db)).toEqual(new Set(['evt-1']))
    })

    it('reports validation failures with the manual-entry messages', () => {
      const result = importCalendarEntries(db, [item({ clientId: 999 })])
      expect(result.created).toBe(0)
      expect(result.failed[0].error).toContain('Kunde existiert nicht')
    })

    it('writes the chosen project onto the entry (#176)', () => {
      db.prepare(`INSERT INTO projects (id, client_id, name) VALUES (7, 1, 'Endkunde A')`).run()
      const result = importCalendarEntries(db, [item({ projectId: 7 })])
      expect(result).toEqual({ created: 1, failed: [] })
      const row = db.prepare(`SELECT project_id FROM entries`).get() as { project_id: number }
      expect(row.project_id).toBe(7)
    })

    it('rejects a project from another client instead of booking onto the wrong customer (#176)', () => {
      db.prepare(`INSERT INTO clients (id, name) VALUES (2, 'Kunde Y')`).run()
      db.prepare(`INSERT INTO projects (id, client_id, name) VALUES (8, 2, 'Fremd')`).run()
      const result = importCalendarEntries(db, [item({ projectId: 8 })])
      expect(result.created).toBe(0)
      expect(result.failed[0].error).toContain('gehört nicht zum gewählten Kunden')
    })
  })
})
