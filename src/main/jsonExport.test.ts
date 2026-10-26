/**
 * Unit tests for `buildJsonExportPayload`. Pure function over a live SQLite
 * handle — no Electron save-dialog involved.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { migrations } from './migrations'
import { buildJsonExportPayload } from './jsonExport'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

describe('buildJsonExportPayload', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-export-'))
    db = new DatabaseImpl(join(tmpDir, 'test.sqlite'))
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
  })

  afterEach(() => {
    if (!db) return
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('emits meta with current schema version + appVersion + ISO exportedAt', () => {
    const payload = buildJsonExportPayload(db, '1.3.0')
    expect(payload.meta.schemaVersion).toBe(migrations.length)
    expect(payload.meta.appVersion).toBe('1.3.0')
    expect(payload.meta.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('includes seeded settings (alphabetically sorted)', () => {
    const payload = buildJsonExportPayload(db, '1.3.0')
    const keys = payload.settings.map((s) => s.key)
    // Sorted by key (BehaviorContract: stable diff across exports).
    const sorted = [...keys].sort()
    expect(keys).toEqual(sorted)
    // Spot-check a key present after all migrations (rounding_minutes removed by migration 014).
    expect(keys).toContain('pdf_round_minutes')
    expect(keys).toContain('pdf_accent_color')
  })

  it('includes clients + entries with their full column set', () => {
    db.prepare(
      `INSERT INTO clients (id, name, color, rate_cent) VALUES (1, 'Acme', '#6366f1', 8500)`
    ).run()
    seedEntry(db, {
      client_id: 1,
      description: 'work',
      started_at: '2026-04-24T08:00:00.000Z',
      stopped_at: '2026-04-24T09:30:00.000Z'
    })
    const payload = buildJsonExportPayload(db, '1.3.0')
    expect(payload.clients).toHaveLength(1)
    expect(payload.clients[0].rate_cent).toBe(8500)
    expect(payload.entries).toHaveLength(1)
    expect(payload.entries[0].description).toBe('work')
    // Verify the v1.3 link_id field is present (even when null).
    expect(payload.entries[0]).toHaveProperty('link_id')
    for (const col of [
      'id',
      'client_id',
      'started_at',
      'stopped_at',
      'heartbeat_at',
      'rounded_min',
      'deleted_at',
      'created_at',
      'tags',
      'reference',
      'billable',
      'private_note',
      'project_id'
    ]) {
      expect(payload.entries[0]).toHaveProperty(col)
    }
  })

  it('exports the two segments of a cross-midnight entry as two rows of one entry', () => {
    // 2.0 P2: the halves are segments of one entry (same id, segment_seq 0
    // and 1), no longer two rows linked by a UUID; link_id is always null.
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    // Segments are cut at local midnight (one segment per local date).
    const local = (d: number, h: number, m = 0): string => new Date(2026, 3, d, h, m).toISOString()
    const id = seedEntry(db, {
      client_id: 1,
      description: 'late',
      segments: [
        { started_at: local(24, 23, 30), stopped_at: local(25, 0) },
        { started_at: local(25, 0), stopped_at: local(25, 1, 15) }
      ]
    })
    const payload = buildJsonExportPayload(db, '1.3.0')
    expect(payload.entries).toHaveLength(2)
    expect(payload.entries.map((e) => [e.id, e.segment_seq, e.link_id])).toEqual([
      [id, 0, null],
      [id, 1, null]
    ])
  })

  it('includes soft-deleted entries (audit trail / undo recovery)', () => {
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    seedEntry(db, {
      client_id: 1,
      description: 'oops',
      started_at: '2026-04-24T08:00:00.000Z',
      stopped_at: '2026-04-24T09:00:00.000Z',
      deleted_at: '2026-04-24T10:00:00.000Z'
    })
    const payload = buildJsonExportPayload(db, '1.3.0')
    expect(payload.entries).toHaveLength(1)
    expect(payload.entries[0].deleted_at).toBe('2026-04-24T10:00:00.000Z')
    // The view, by contrast, hides it.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM entries`).get()).toEqual({ n: 0 })
  })

  describe('secrets are left out', () => {
    const setSetting = (key: string, value: string): void => {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(key, value)
    }
    const settingValue = (
      payload: ReturnType<typeof buildJsonExportPayload>,
      key: string
    ): string | undefined => payload.settings.find((s) => s.key === key)?.value

    it('omits the iCal feed token', () => {
      setSetting('ical_feed_token', 'feed-token-abc123')
      const payload = buildJsonExportPayload(db, '1.3.0')
      expect(settingValue(payload, 'ical_feed_token')).toBeUndefined()
      expect(JSON.stringify(payload)).not.toContain('feed-token-abc123')
      // Neighbouring feed settings stay.
      expect(settingValue(payload, 'ical_feed_enabled')).toBeDefined()
    })

    // Owner review #254: the URL of a chat webhook carries its token.
    it('leaves out the webhook targets as a whole, URL included', () => {
      const slack = 'https://hooks.slack.com/services/T000/B000/XXXXSECRETXXXX'
      setSetting(
        'webhook_targets',
        JSON.stringify([
          {
            id: 'a',
            url: slack,
            secret: 'hmac-secret-one',
            events: ['timer.started'],
            enabled: true
          }
        ])
      )
      const payload = buildJsonExportPayload(db, '1.3.0')
      expect(settingValue(payload, 'webhook_targets')).toBeUndefined()
      const json = JSON.stringify(payload)
      expect(json).not.toContain('hooks.slack.com')
      expect(json).not.toContain('XXXXSECRETXXXX')
      expect(json).not.toContain('hmac-secret-one')
    })

    it('leaves out any key that names a token, secret or password', () => {
      setSetting('future_api_token', 'tok-1')
      setSetting('smtp_Password', 'pw-2')
      setSetting('graph_client_secret', 'sec-3')
      const payload = buildJsonExportPayload(db, '1.3.0')
      const json = JSON.stringify(payload)
      for (const v of ['tok-1', 'pw-2', 'sec-3']) expect(json).not.toContain(v)
      expect(payload.settings.some((s) => /token|secret|password/i.test(s.key))).toBe(false)
    })

    it('keeps the other settings unchanged', () => {
      setSetting('company_name', 'wald-it')
      const payload = buildJsonExportPayload(db, '1.3.0')
      expect(settingValue(payload, 'company_name')).toBe('wald-it')
    })
  })

  it('serialises to stable, indented JSON (2-space)', () => {
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    const payload = buildJsonExportPayload(db, '1.3.0')
    const json = JSON.stringify(payload, null, 2)
    // Indent guarantees readability ("open in any editor and verify your data").
    expect(json).toContain('\n  "clients": [')
    expect(json).toContain('\n  "entries":')
  })
})
