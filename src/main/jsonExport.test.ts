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
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, link_id)
       VALUES (1, 'work', '2026-04-24T08:00:00.000Z', '2026-04-24T09:30:00.000Z', NULL)`
    ).run()
    const payload = buildJsonExportPayload(db, '1.3.0')
    expect(payload.clients).toHaveLength(1)
    expect(payload.clients[0].rate_cent).toBe(8500)
    expect(payload.entries).toHaveLength(1)
    expect(payload.entries[0].description).toBe('work')
    // Verify the v1.3 link_id field is present (even when null).
    expect(payload.entries[0]).toHaveProperty('link_id')
  })

  it('preserves cross-midnight linked halves verbatim', () => {
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    const linkId = '11111111-2222-3333-4444-555555555555'
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, link_id)
       VALUES (1, 'late', '2026-04-24T23:30:00.000Z', '2026-04-25T00:00:00.000Z', ?)`
    ).run(linkId)
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, link_id)
       VALUES (1, 'late', '2026-04-25T00:00:00.000Z', '2026-04-25T01:15:00.000Z', ?)`
    ).run(linkId)
    const payload = buildJsonExportPayload(db, '1.3.0')
    expect(payload.entries).toHaveLength(2)
    expect(payload.entries.every((e) => e.link_id === linkId)).toBe(true)
  })

  it('includes soft-deleted entries (audit trail / undo recovery)', () => {
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, deleted_at)
       VALUES (1, 'oops', '2026-04-24T08:00:00.000Z', '2026-04-24T09:00:00.000Z', '2026-04-24T10:00:00.000Z')`
    ).run()
    const payload = buildJsonExportPayload(db, '1.3.0')
    expect(payload.entries).toHaveLength(1)
    expect(payload.entries[0].deleted_at).toBe('2026-04-24T10:00:00.000Z')
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

    it('keeps webhook targets but drops each secret', () => {
      const targets = [
        {
          id: 'a',
          url: 'https://example.com/hook',
          secret: 'hmac-secret-one',
          events: ['timer.started'],
          enabled: true
        },
        { id: 'b', url: 'https://example.org/x', secret: '', events: [], enabled: false }
      ]
      setSetting('webhook_targets', JSON.stringify(targets))
      const payload = buildJsonExportPayload(db, '1.3.0')
      const exported = JSON.parse(settingValue(payload, 'webhook_targets')!) as Array<
        Record<string, unknown>
      >
      expect(exported).toHaveLength(2)
      expect(exported[0]).toEqual({
        id: 'a',
        url: 'https://example.com/hook',
        events: ['timer.started'],
        enabled: true
      })
      expect(exported.every((t) => !('secret' in t))).toBe(true)
      expect(JSON.stringify(payload)).not.toContain('hmac-secret-one')
    })

    it('leaves out a webhook blob that is not valid JSON', () => {
      setSetting('webhook_targets', '[{"secret":"hmac-secret-two", broken')
      const payload = buildJsonExportPayload(db, '1.3.0')
      expect(settingValue(payload, 'webhook_targets')).toBeUndefined()
      expect(JSON.stringify(payload)).not.toContain('hmac-secret-two')
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
