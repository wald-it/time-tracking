import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrations } from './index'

import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../../test/sqlite'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

describe('migrations registry', () => {
  it('has at least one migration', () => {
    expect(migrations.length).toBeGreaterThan(0)
  })

  it('versions are strictly increasing and start at 1', () => {
    expect(migrations[0].version).toBe(1)
    for (let i = 1; i < migrations.length; i++) {
      expect(migrations[i].version).toBe(migrations[i - 1].version + 1)
    }
  })

  it('all migrations have non-empty name and up SQL', () => {
    for (const m of migrations) {
      expect(m.name).toBeTruthy()
      expect(m.up.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('migration SQL execution', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-migrations-'))
    const dbPath = join(tmpDir, 'test.sqlite')
    db = new DatabaseImpl(dbPath)
    db.pragma('foreign_keys = ON')
    db.exec(
      `CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    )
  })

  afterEach(() => {
    if (!db) return
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function applyAll(): void {
    for (const m of migrations) {
      const tx = db.transaction(() => {
        db.exec(m.up)
        db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
          m.version,
          m.name
        )
      })
      tx()
    }
  }

  it('migration 001 creates clients, entries, settings tables', () => {
    applyAll()
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
    expect(tables).toContain('clients')
    expect(tables).toContain('entries')
    expect(tables).toContain('settings')
  })

  it('migration 001 creates idx_entries_client_started index', () => {
    applyAll()
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_entries_client_started'"
      )
      .get()
    expect(idx).toBeDefined()
  })

  it('migrations seed default settings', () => {
    applyAll()
    const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all()
    expect(rows).toEqual([
      { key: 'auto_start', value: '0' },
      { key: 'backup_path', value: '' },
      { key: 'company_name', value: '' },
      // Migration 023 — hardware-key controller scope (v1.17 #133)
      { key: 'controller_enabled', value: '0' },
      { key: 'hotkey_toggle', value: 'Alt+Shift+S' },
      // Migration 025 — subscribable iCal feed (v1.17 #169)
      { key: 'ical_feed_enabled', value: '0' },
      { key: 'ical_feed_port', value: '' },
      { key: 'ical_feed_token', value: '' },
      { key: 'idle_threshold_minutes', value: '5' },
      { key: 'language', value: 'de' },
      // Migration 018 — MCP integration flags (v1.14 #128)
      { key: 'mcp_expose_private_notes', value: '0' },
      { key: 'mcp_expose_rates', value: '0' },
      { key: 'mcp_write_confirm_mode', value: 'per-write' },
      { key: 'mcp_write_enabled', value: '0' },
      // Migration 006 — Mini-Widget (v1.4)
      { key: 'mini_enabled', value: '0' },
      { key: 'mini_hotkey', value: 'Alt+Shift+M' },
      { key: 'mini_x', value: '-1' },
      { key: 'mini_y', value: '-1' },
      // Migration 008 — Onboarding wizard (v1.5 PR E)
      { key: 'onboarding_completed', value: '0' },
      // Migration 004 — PDF template seeds (v1.3 PR A)
      { key: 'pdf_accent_color', value: '#4f46e5' },
      { key: 'pdf_footer_text', value: '' },
      { key: 'pdf_logo_path', value: '' },
      { key: 'pdf_round_minutes', value: '0' },
      { key: 'pdf_sender_address', value: '' },
      { key: 'pdf_tax_id', value: '' },
      // Migration 024 — Teams presence mirroring (v1.17 #132)
      { key: 'presence_enabled', value: '0' },
      { key: 'presence_show_client', value: '0' },
      // Migration 011 — Light/Dark/System theme (v1.8 #76)
      { key: 'theme_mode', value: 'system' },
      // Migration 020 — Outbound-Webhooks (v1.15 #134)
      { key: 'webhook_targets', value: '[]' },
      // #188 — one default for every installation, old and new.
      { key: 'week_start', value: 'monday' }
      // rounding_mode and rounding_minutes removed by Migration 014
    ])
  })

  it('migration 014 removes dead rounding settings', () => {
    applyAll()
    const rows = db
      .prepare(`SELECT key FROM settings WHERE key IN ('rounding_mode', 'rounding_minutes')`)
      .all()
    expect(rows).toHaveLength(0)
  })

  it('migration 014 DELETE is idempotent when rows already absent', () => {
    // Run all migrations — including 014 which deletes the rows.
    applyAll()
    // Running the 014 SQL again should not throw even though rows are gone.
    expect(() =>
      db.exec(`DELETE FROM settings WHERE key IN ('rounding_mode', 'rounding_minutes')`)
    ).not.toThrow()
  })

  it('seed-only migrations are idempotent (001 + 002)', () => {
    // Migrations whose `up` SQL contains ONLY CREATE IF NOT EXISTS and
    // INSERT OR IGNORE are safe to replay on existing v1.0 installs.
    // 003+ may use ALTER TABLE — those rely on schema_version + the runner
    // (which only applies pending migrations) for idempotency.
    const seedOnly = migrations.filter((m) => m.version <= 2)
    for (const m of seedOnly) {
      const tx = db.transaction(() => {
        db.exec(m.up)
        db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
          m.version,
          m.name
        )
      })
      tx()
    }
    db.exec('DELETE FROM schema_version')
    expect(() => {
      for (const m of seedOnly) {
        const tx = db.transaction(() => {
          db.exec(m.up)
          db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
            m.version,
            m.name
          )
        })
        tx()
      }
    }).not.toThrow()
    const count = db.prepare('SELECT COUNT(*) as n FROM settings').get() as {
      n: number
    }
    expect(count.n).toBe(8)
  })

  it('foreign key cascade deletes entries when client is deleted', () => {
    applyAll()
    db.prepare("INSERT INTO clients (id, name) VALUES (1, 'Acme')").run()
    db.prepare(
      "INSERT INTO entries (client_id, started_at) VALUES (1, '2026-01-01T00:00:00Z')"
    ).run()
    db.prepare('DELETE FROM clients WHERE id = 1').run()
    const remaining = db.prepare('SELECT COUNT(*) as n FROM entries').get() as { n: number }
    expect(remaining.n).toBe(0)
  })

  it('records each applied migration in schema_version', () => {
    applyAll()
    const rows = db.prepare('SELECT version, name FROM schema_version ORDER BY version').all()
    expect(rows).toEqual(migrations.map((m) => ({ version: m.version, name: m.name })))
  })

  it('migration 003 adds clients.rate_cent and entries.deleted_at', () => {
    applyAll()
    const clientCols = (
      db.prepare('PRAGMA table_info(clients)').all() as Array<{ name: string }>
    ).map((r) => r.name)
    const entryCols = (
      db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>
    ).map((r) => r.name)
    expect(clientCols).toContain('rate_cent')
    expect(entryCols).toContain('deleted_at')
  })

  it('migration 003 creates idx_entries_started_at', () => {
    applyAll()
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_entries_started_at'"
      )
      .get()
    expect(idx).toBeDefined()
  })

  it('migration 003 backfills rounded_min for finished entries only', () => {
    applyAll()
    db.prepare("INSERT INTO clients (id, name) VALUES (1, 'Acme')").run()
    // Finished entry without rounded_min
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at)
       VALUES (1, '2026-04-24T08:00:00Z', '2026-04-24T09:30:00Z')`
    ).run()
    // Running entry — must remain NULL after backfill replays
    db.prepare(
      `INSERT INTO entries (client_id, started_at) VALUES (1, '2026-04-24T10:00:00Z')`
    ).run()
    // Replay the backfill statement directly (idempotent).
    db.exec(
      `UPDATE entries
         SET rounded_min = CAST(
           ROUND((julianday(stopped_at) - julianday(started_at)) * 1440) AS INTEGER
         )
       WHERE rounded_min IS NULL
         AND stopped_at IS NOT NULL
         AND stopped_at >= started_at`
    )
    const rows = db
      .prepare('SELECT id, stopped_at, rounded_min FROM entries ORDER BY id')
      .all() as Array<{ id: number; stopped_at: string | null; rounded_min: number | null }>
    expect(rows[0].rounded_min).toBe(90)
    expect(rows[1].stopped_at).toBeNull()
    expect(rows[1].rounded_min).toBeNull()
  })

  it('migration 003 skips clock-skew rows (stopped_at < started_at)', () => {
    applyAll()
    db.prepare("INSERT INTO clients (id, name) VALUES (1, 'Acme')").run()
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at)
       VALUES (1, '2026-04-24T10:00:00Z', '2026-04-24T09:00:00Z')`
    ).run()
    db.exec(
      `UPDATE entries
         SET rounded_min = CAST(
           ROUND((julianday(stopped_at) - julianday(started_at)) * 1440) AS INTEGER
         )
       WHERE rounded_min IS NULL
         AND stopped_at IS NOT NULL
         AND stopped_at >= started_at`
    )
    const row = db.prepare('SELECT rounded_min FROM entries').get() as {
      rounded_min: number | null
    }
    expect(row.rounded_min).toBeNull()
  })

  it('migration 003 default rate_cent is 0', () => {
    applyAll()
    db.prepare("INSERT INTO clients (name) VALUES ('Acme')").run()
    const row = db.prepare('SELECT rate_cent FROM clients').get() as { rate_cent: number }
    expect(row.rate_cent).toBe(0)
  })

  it('migration 004 seeds PDF template settings keys', () => {
    applyAll()
    const keys = (
      db.prepare("SELECT key FROM settings WHERE key LIKE 'pdf_%' ORDER BY key").all() as Array<{
        key: string
      }>
    ).map((r) => r.key)
    expect(keys).toEqual([
      'pdf_accent_color',
      'pdf_footer_text',
      'pdf_logo_path',
      'pdf_round_minutes',
      'pdf_sender_address',
      'pdf_tax_id'
    ])
    const accent = db.prepare("SELECT value FROM settings WHERE key='pdf_accent_color'").get() as {
      value: string
    }
    expect(accent.value).toBe('#4f46e5')
    const round = db.prepare("SELECT value FROM settings WHERE key='pdf_round_minutes'").get() as {
      value: string
    }
    expect(round.value).toBe('0')
  })

  it('migration 004 is idempotent (preserves user-overridden values)', () => {
    applyAll()
    db.prepare("UPDATE settings SET value='#ff0000' WHERE key='pdf_accent_color'").run()
    // Re-running the same INSERT OR IGNORE statement must not reset the override.
    db.exec(`
      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('pdf_logo_path', ''),
        ('pdf_sender_address', ''),
        ('pdf_tax_id', ''),
        ('pdf_accent_color', '#4f46e5'),
        ('pdf_footer_text', ''),
        ('pdf_round_minutes', '0');
    `)
    const accent = db.prepare("SELECT value FROM settings WHERE key='pdf_accent_color'").get() as {
      value: string
    }
    expect(accent.value).toBe('#ff0000')
  })

  it('migration 005 adds entries.link_id column (nullable)', () => {
    applyAll()
    const cols = db.prepare(`PRAGMA table_info(entries)`).all() as Array<{
      name: string
      notnull: number
      dflt_value: string | null
    }>
    const linkCol = cols.find((c) => c.name === 'link_id')
    expect(linkCol).toBeDefined()
    // NULL is the "no split" sentinel — column must allow NULL.
    expect(linkCol?.notnull).toBe(0)
    expect(linkCol?.dflt_value).toBeNull()
  })

  it('migration 005 creates the partial idx_entries_link_id index', () => {
    applyAll()
    const idx = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_entries_link_id'"
      )
      .get() as { name: string; sql: string } | undefined
    expect(idx).toBeDefined()
    // Partial index: WHERE clause means we don't index the (large) NULL set.
    expect(idx?.sql).toMatch(/WHERE\s+link_id\s+IS\s+NOT\s+NULL/i)
  })

  it('migration 005 round-trips a UUID link_id on multiple rows', () => {
    applyAll()
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    const linkId = '11111111-2222-3333-4444-555555555555'
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at, link_id)
       VALUES (1, '2026-04-24T23:30:00Z', '2026-04-25T00:00:00Z', ?)`
    ).run(linkId)
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at, link_id)
       VALUES (1, '2026-04-25T00:00:00Z', '2026-04-25T01:15:00Z', ?)`
    ).run(linkId)
    const linked = db
      .prepare(`SELECT id FROM entries WHERE link_id = ? ORDER BY started_at`)
      .all(linkId) as Array<{ id: number }>
    expect(linked).toHaveLength(2)
  })

  it('migration 006 seeds mini-widget settings keys', () => {
    applyAll()
    const keys = (
      db.prepare("SELECT key FROM settings WHERE key LIKE 'mini_%' ORDER BY key").all() as Array<{
        key: string
      }>
    ).map((r) => r.key)
    expect(keys).toEqual(['mini_enabled', 'mini_hotkey', 'mini_x', 'mini_y'])
    const enabled = db.prepare("SELECT value FROM settings WHERE key='mini_enabled'").get() as {
      value: string
    }
    expect(enabled.value).toBe('0')
  })

  it('migration 007 adds entries.tags column (NOT NULL, default empty string)', () => {
    applyAll()
    const cols = db.prepare(`PRAGMA table_info(entries)`).all() as Array<{
      name: string
      notnull: number
      dflt_value: string | null
      type: string
    }>
    const tagsCol = cols.find((c) => c.name === 'tags')
    expect(tagsCol).toBeDefined()
    expect(tagsCol?.notnull).toBe(1)
    expect(tagsCol?.dflt_value).toBe("''")
    expect(tagsCol?.type.toUpperCase()).toBe('TEXT')
  })

  it('migration 007 — existing entries have empty tags by default', () => {
    applyAll()
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at)
       VALUES (1, '2026-05-01T08:00:00Z', '2026-05-01T09:00:00Z')`
    ).run()
    const row = db.prepare('SELECT tags FROM entries').get() as { tags: string }
    expect(row.tags).toBe('')
  })

  it('migration 007 — tags column stores comma-delimited values', () => {
    applyAll()
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at, tags)
       VALUES (1, '2026-05-01T08:00:00Z', '2026-05-01T09:00:00Z', ',bug,ux,')`
    ).run()
    const row = db.prepare('SELECT tags FROM entries').get() as { tags: string }
    expect(row.tags).toBe(',bug,ux,')
  })

  it('migration 007 — LIKE search finds exact tag match without false positives', () => {
    applyAll()
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at, tags)
       VALUES (1, '2026-05-01T08:00:00Z', '2026-05-01T09:00:00Z', ',bugfix,ux,')`
    ).run()
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at, tags)
       VALUES (1, '2026-05-02T08:00:00Z', '2026-05-02T09:00:00Z', ',bug,feature,')`
    ).run()
    // Searching for 'bug' should only match the second row, not 'bugfix'
    const rows = db
      .prepare(`SELECT id FROM entries WHERE tags LIKE '%,bug,%' ORDER BY id`)
      .all() as Array<{ id: number }>
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(2)
  })

  it('rolls back migration on SQL failure (transactional)', () => {
    applyAll()
    const beforeCount = db
      .prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table'")
      .get() as { n: number }

    const broken = `
      CREATE TABLE valid_table (id INTEGER);
      INSERT INTO clients (name) VALUES ('Should rollback');
      THIS IS NOT VALID SQL;
    `
    expect(() => {
      const tx = db.transaction(() => {
        db.exec(broken)
        db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(99, 'broken')
      })
      tx()
    }).toThrow()

    const afterCount = db
      .prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table'")
      .get() as { n: number }
    expect(afterCount.n).toBe(beforeCount.n)
    const clientCount = db
      .prepare("SELECT COUNT(*) as n FROM clients WHERE name='Should rollback'")
      .get() as { n: number }
    expect(clientCount.n).toBe(0)
    const versionRow = db.prepare('SELECT * FROM schema_version WHERE version = 99').get()
    expect(versionRow).toBeUndefined()
  })

  it("migration 008 seeds onboarding_completed = '0'", () => {
    applyAll()
    const row = db.prepare("SELECT value FROM settings WHERE key='onboarding_completed'").get() as
      | { value: string }
      | undefined
    expect(row).toBeDefined()
    expect(row?.value).toBe('0')
  })

  it('migration 008 backfills onboarding_completed to 1 for installs with existing entries', () => {
    // Simulate an install that already has entries (upgrade from v1.4).
    // Apply migrations 001-007 first, insert an entry, then apply 008.
    const pre = migrations.filter((m) => m.version < 8)
    for (const m of pre) {
      const tx = db.transaction(() => {
        db.exec(m.up)
        db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
          m.version,
          m.name
        )
      })
      tx()
    }
    db.prepare("INSERT INTO clients (id, name) VALUES (1, 'Acme')").run()
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at)
       VALUES (1, '2026-01-01T08:00:00Z', '2026-01-01T09:00:00Z')`
    ).run()
    // Now apply migration 008.
    const m008 = migrations.find((m) => m.version === 8)!
    db.transaction(() => {
      db.exec(m008.up)
      db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
        m008.version,
        m008.name
      )
    })()
    const row = db.prepare("SELECT value FROM settings WHERE key='onboarding_completed'").get() as {
      value: string
    }
    expect(row.value).toBe('1')
  })

  it('migration 008 keeps onboarding_completed = 0 for fresh installs (no entries)', () => {
    applyAll()
    // applyAll() on an empty DB → no entries → backfill should leave value as '0'.
    const row = db.prepare("SELECT value FROM settings WHERE key='onboarding_completed'").get() as {
      value: string
    }
    expect(row.value).toBe('0')
  })

  it('migration 009 adds entries.reference column (NOT NULL, default empty string)', () => {
    applyAll()
    const cols = db.prepare(`PRAGMA table_info(entries)`).all() as Array<{
      name: string
      notnull: number
      dflt_value: string | null
      type: string
    }>
    const refCol = cols.find((c) => c.name === 'reference')
    expect(refCol).toBeDefined()
    expect(refCol?.notnull).toBe(1)
    expect(refCol?.dflt_value).toBe("''")
    expect(refCol?.type.toUpperCase()).toBe('TEXT')
  })

  it('migration 009 — existing entries have empty reference by default', () => {
    applyAll()
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at)
       VALUES (1, '2026-05-01T08:00:00Z', '2026-05-01T09:00:00Z')`
    ).run()
    const row = db.prepare('SELECT reference FROM entries').get() as { reference: string }
    expect(row.reference).toBe('')
  })

  it('migration 009 — reference column stores free-text values', () => {
    applyAll()
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at, reference)
       VALUES (1, '2026-05-01T08:00:00Z', '2026-05-01T09:00:00Z', 'JIRA-123')`
    ).run()
    const row = db.prepare('SELECT reference FROM entries').get() as { reference: string }
    expect(row.reference).toBe('JIRA-123')
  })

  // ── Migration 012 — v1.9-projects ──────────────────────────────────────

  it('migration 012 — projects table exists after full migration run', () => {
    applyAll()
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
    expect(tables).toContain('projects')
  })

  it('migration 012 — entries.project_id column exists and is nullable', () => {
    applyAll()
    const cols = db.prepare('PRAGMA table_info(entries)').all() as Array<{
      name: string
      notnull: number
    }>
    const col = cols.find((c) => c.name === 'project_id')
    expect(col).toBeDefined()
    expect(col?.notnull).toBe(0)
  })

  it('migration 012 — idx_projects_client_active index exists (before migration 013 drops it)', () => {
    // Apply only migrations 001-012. Migration 013 drops this index.
    const pre = migrations.filter((m) => m.version <= 12)
    for (const m of pre) {
      const tx = db.transaction(() => {
        db.exec(m.up)
        db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
          m.version,
          m.name
        )
      })
      tx()
    }
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_projects_client_active'"
      )
      .get()
    expect(idx).toBeDefined()
  })

  it('migration 012 — existing entries survive with project_id = NULL', () => {
    // Apply 001-011, insert entry, then apply 012.
    const pre = migrations.filter((m) => m.version < 12)
    for (const m of pre) {
      const tx = db.transaction(() => {
        db.exec(m.up)
        db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
          m.version,
          m.name
        )
      })
      tx()
    }
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at)
       VALUES (1, '2026-05-01T08:00:00Z', '2026-05-01T09:00:00Z')`
    ).run()
    // Apply migration 012
    const m012 = migrations.find((m) => m.version === 12)!
    const tx = db.transaction(() => {
      db.exec(m012.up)
      db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
        m012.version,
        m012.name
      )
    })
    tx()
    const row = db.prepare('SELECT project_id FROM entries').get() as {
      project_id: number | null
    }
    expect(row.project_id).toBeNull()
  })

  it('migration 012 — deleting project sets entries.project_id to NULL (SET NULL)', () => {
    applyAll()
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    db.prepare(`INSERT INTO projects (id, client_id, name) VALUES (1, 1, 'App')`).run()
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at, project_id)
       VALUES (1, '2026-05-01T08:00:00Z', '2026-05-01T09:00:00Z', 1)`
    ).run()
    db.prepare('DELETE FROM projects WHERE id = 1').run()
    const row = db.prepare('SELECT project_id FROM entries').get() as {
      project_id: number | null
    }
    expect(row.project_id).toBeNull()
  })

  it('migration 012 — deleting client cascades to projects', () => {
    applyAll()
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    db.prepare(`INSERT INTO projects (client_id, name) VALUES (1, 'App')`).run()
    db.prepare('DELETE FROM clients WHERE id = 1').run()
    const count = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('migration 012 — UNIQUE partial index: two active projects same name same client → rejected', () => {
    applyAll()
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    db.prepare(`INSERT INTO projects (client_id, name, active) VALUES (1, 'App', 1)`).run()
    expect(() => {
      db.prepare(`INSERT INTO projects (client_id, name, active) VALUES (1, 'App', 1)`).run()
    }).toThrow()
  })

  it('migration 012 — UNIQUE partial index: two archived projects same name same client → allowed', () => {
    applyAll()
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    // After migration 013, status column exists with DEFAULT 'active'.
    // Must set status='archived' to match active=0; otherwise the new
    // idx_projects_unique_status_name (WHERE status='active') would fire.
    db.prepare(
      `INSERT INTO projects (client_id, name, active, status) VALUES (1, 'App', 0, 'archived')`
    ).run()
    expect(() => {
      db.prepare(
        `INSERT INTO projects (client_id, name, active, status) VALUES (1, 'App', 0, 'archived')`
      ).run()
    }).not.toThrow()
  })

  // ── Migration 013 — v1.11-stammdaten ───────────────────────────────────

  it('migration 013 — clients table has all 7 new columns', () => {
    applyAll()
    const cols = (db.prepare('PRAGMA table_info(clients)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    expect(cols).toContain('billing_address_line1')
    expect(cols).toContain('billing_address_line2')
    expect(cols).toContain('billing_address_line3')
    expect(cols).toContain('billing_address_line4')
    expect(cols).toContain('vat_id')
    expect(cols).toContain('contact_person')
    expect(cols).toContain('contact_email')
  })

  it('migration 013 — projects table has all new columns', () => {
    applyAll()
    const cols = (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    expect(cols).toContain('external_project_number')
    expect(cols).toContain('start_date')
    expect(cols).toContain('end_date')
    expect(cols).toContain('budget_minutes')
    expect(cols).toContain('status')
  })

  it('migration 013 — status column has CHECK constraint (rejects invalid values)', () => {
    applyAll()
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    expect(() => {
      db.prepare(
        `INSERT INTO projects (client_id, name, status) VALUES (1, 'App', 'invalid')`
      ).run()
    }).toThrow()
  })

  it('migration 013 — active=1 rows get status=active, active=0 rows get status=archived', () => {
    // Apply 001-012 first, insert rows, then apply 013.
    const pre = migrations.filter((m) => m.version < 13)
    for (const m of pre) {
      const tx = db.transaction(() => {
        db.exec(m.up)
        db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
          m.version,
          m.name
        )
      })
      tx()
    }
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    db.prepare(
      `INSERT INTO projects (id, client_id, name, active) VALUES (1, 1, 'Active Project', 1)`
    ).run()
    db.prepare(
      `INSERT INTO projects (id, client_id, name, active) VALUES (2, 1, 'Archived Project', 0)`
    ).run()
    // Now apply migration 013
    const m013 = migrations.find((m) => m.version === 13)!
    const tx = db.transaction(() => {
      db.exec(m013.up)
      db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
        m013.version,
        m013.name
      )
    })
    tx()
    const rows = db.prepare('SELECT id, status FROM projects ORDER BY id').all() as Array<{
      id: number
      status: string
    }>
    expect(rows[0].status).toBe('active')
    expect(rows[1].status).toBe('archived')
  })

  it('migration 013 — old idx_projects_client_active index is dropped', () => {
    applyAll()
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_projects_client_active'"
      )
      .get()
    expect(idx).toBeUndefined()
  })

  it('migration 013 — new idx_projects_client_status index exists', () => {
    applyAll()
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_projects_client_status'"
      )
      .get()
    expect(idx).toBeDefined()
  })

  it('migration 013 — old idx_projects_unique_active_name index is dropped', () => {
    applyAll()
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_projects_unique_active_name'"
      )
      .get()
    expect(idx).toBeUndefined()
  })

  it('migration 013 — new idx_projects_unique_status_name index exists', () => {
    applyAll()
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_projects_unique_status_name'"
      )
      .get()
    expect(idx).toBeDefined()
  })

  it('migration 013 — two active projects with same name and client are rejected', () => {
    applyAll()
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    db.prepare(`INSERT INTO projects (client_id, name, status) VALUES (1, 'App', 'active')`).run()
    expect(() => {
      db.prepare(`INSERT INTO projects (client_id, name, status) VALUES (1, 'App', 'active')`).run()
    }).toThrow()
  })

  it('migration 013 — two archived projects with same name and client are allowed', () => {
    applyAll()
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    db.prepare(`INSERT INTO projects (client_id, name, status) VALUES (1, 'App', 'archived')`).run()
    expect(() => {
      db.prepare(
        `INSERT INTO projects (client_id, name, status) VALUES (1, 'App', 'archived')`
      ).run()
    }).not.toThrow()
  })

  // ── migration 027: entry timestamps in one form ────────────────────────
  it('migration 027 — rewrites offset and second-only timestamps to UTC with ms, leaves the rest', () => {
    applyUpTo(26)
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    const ins = db.prepare(
      `INSERT INTO entries (id, client_id, started_at, stopped_at, heartbeat_at) VALUES (?, 1, ?, ?, ?)`
    )
    // start_timer with an offset, as the old startTimer stored it
    ins.run(1, '2026-10-01T00:30:00+02:00', '2026-10-01T01:00:00.000Z', '2026-10-01T00:30:00+02:00')
    // seconds only, no milliseconds
    ins.run(2, '2026-10-02T08:00:00Z', null, null)
    // already canonical
    ins.run(3, '2026-10-03T08:00:00.000Z', '2026-10-03T09:00:00.000Z', '2026-10-03T08:00:00.000Z')
    // unreadable: left as it is rather than nulled
    ins.run(4, 'kaputt', null, null)
    // no zone: the app read this as LOCAL time (new Date), so must the rewrite.
    // SQLite's 'utc' modifier uses the system zone, which process.env.TZ does
    // not reliably change; on a UTC runner (CI) this case cannot go red, on a
    // machine off UTC (the owner's, Europe/Berlin) it does.
    ins.run(5, '2026-10-01T00:30:00', null, null)
    applyVersion(27)
    const local = db.prepare('SELECT started_at FROM entries WHERE id = 5').get() as {
      started_at: string
    }
    expect(local.started_at).toBe(new Date('2026-10-01T00:30:00').toISOString())
    db.prepare('DELETE FROM entries WHERE id = 5').run()
    const rows = db
      .prepare('SELECT id, started_at, stopped_at, heartbeat_at FROM entries ORDER BY id')
      .all()
    expect(rows).toEqual([
      {
        id: 1,
        started_at: '2026-09-30T22:30:00.000Z',
        stopped_at: '2026-10-01T01:00:00.000Z',
        heartbeat_at: '2026-09-30T22:30:00.000Z'
      },
      { id: 2, started_at: '2026-10-02T08:00:00.000Z', stopped_at: null, heartbeat_at: null },
      {
        id: 3,
        started_at: '2026-10-03T08:00:00.000Z',
        stopped_at: '2026-10-03T09:00:00.000Z',
        heartbeat_at: '2026-10-03T08:00:00.000Z'
      },
      { id: 4, started_at: 'kaputt', stopped_at: null, heartbeat_at: null }
    ])
  })

  // ── migration 017: whitespace cleanup in tag names ─────────────────────

  function applyUpTo(targetVersion: number): void {
    for (const m of migrations.filter((mm) => mm.version <= targetVersion)) {
      const tx = db.transaction(() => {
        db.exec(m.up)
        db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
          m.version,
          m.name
        )
      })
      tx()
    }
  }

  function applyVersion(version: number): void {
    const m = migrations.find((mm) => mm.version === version)!
    const tx = db.transaction(() => {
      db.exec(m.up)
      db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(m.version, m.name)
    })
    tx()
  }

  it('migration 017 — replaces space with underscore in master tag names', () => {
    applyUpTo(16)
    db.prepare(`INSERT INTO tags (name) VALUES ('ticket 12345')`).run()
    applyVersion(17)
    const rows = (
      db.prepare('SELECT name FROM tags ORDER BY name').all() as Array<{ name: string }>
    ).map((r) => r.name)
    expect(rows).toContain('ticket_12345')
    expect(rows).not.toContain('ticket 12345')
  })

  it('migration 017 — rewrites entries.tags occurrences of whitespace tags', () => {
    applyUpTo(16)
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    db.prepare(`INSERT INTO tags (name) VALUES ('ticket 12345')`).run()
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at, tags)
       VALUES (1, '2026-05-01T08:00:00Z', '2026-05-01T09:00:00Z', ',ticket 12345,bug,')`
    ).run()
    applyVersion(17)
    const row = db.prepare('SELECT tags FROM entries LIMIT 1').get() as { tags: string }
    expect(row.tags).toBe(',ticket_12345,bug,')
  })

  it('migration 017 — merges into existing cleaned tag when both names collide', () => {
    applyUpTo(16)
    db.prepare(`INSERT INTO tags (name) VALUES ('foo bar')`).run()
    db.prepare(`INSERT INTO tags (name) VALUES ('foo_bar')`).run()
    applyVersion(17)
    const rows = (
      db.prepare('SELECT name FROM tags ORDER BY name').all() as Array<{ name: string }>
    ).map((r) => r.name)
    expect(rows).toEqual(['foo_bar'])
  })

  it('migration 017 — also handles tab characters', () => {
    applyUpTo(16)
    db.prepare(`INSERT INTO tags (name) VALUES ('foo\tbar')`).run()
    applyVersion(17)
    const rows = (db.prepare('SELECT name FROM tags').all() as Array<{ name: string }>).map(
      (r) => r.name
    )
    expect(rows).toContain('foo_bar')
  })

  it('migration 017 — leaves clean tags untouched', () => {
    applyUpTo(16)
    db.prepare(`INSERT INTO tags (name) VALUES ('clean')`).run()
    db.prepare(`INSERT INTO tags (name) VALUES ('also_clean')`).run()
    applyVersion(17)
    const rows = (
      db.prepare('SELECT name FROM tags ORDER BY name').all() as Array<{ name: string }>
    ).map((r) => r.name)
    expect(rows).toEqual(['also_clean', 'clean'])
  })
})
