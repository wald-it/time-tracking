import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import type { Entry, IpcResult, Settings } from '../shared/types'
import { parseWebhookTargets } from '../shared/webhooks'
import { registerIpcHandlers, type IpcHooks } from './ipc'
import { buildFeedResponse, feedUrl } from './icalFeed'
import { emitWebhooks, signBody } from './webhooks'
import {
  FEED_TOKEN_KEY,
  SECRETS_FILENAME,
  SecretStore,
  webhookSecretKey,
  type AsyncSecretBox
} from './secretStore'
import {
  FEED_TOKEN_RECREATED_KEY,
  feedSettings,
  initializeSecrets,
  markFeedTokenRecreated,
  prepareWebhookTargets,
  readFeedToken,
  readWebhookTargets,
  saveWebhookTargets,
  useSecretStore,
  webhookTargetsForRenderer,
  writeFeedToken
} from './secretSettings'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  db: undefined as Database.Database | undefined
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: never) => state.handlers.set(name, fn), on: vi.fn() },
  app: {},
  shell: {},
  dialog: {}
}))
vi.mock('./db', () => ({ getDb: () => state.db, getDbPath: () => 'unused.sqlite' }))

function box(available = true, readable = true): AsyncSecretBox {
  return {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (value) => Buffer.from(Buffer.from(value).toString('base64')),
    decryptStringAsync: async (cipher) => {
      if (!readable) throw new Error('different machine')
      return { result: Buffer.from(cipher.toString(), 'base64').toString(), shouldReEncrypt: false }
    }
  }
}

let Sqlite: DatabaseCtor
let db: Database.Database
let dir: string
let entry: Entry
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-secret-settings-'))
  db = new Sqlite(':memory:')
  applyMigrations(db)
  state.db = db
  state.handlers.clear()
  useSecretStore(null)
  db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Client')`).run()
  const id = seedEntry(db, {
    client_id: 1,
    description: 'work',
    started_at: '2026-10-30T08:00:00Z',
    stopped_at: '2026-10-30T09:00:00Z'
  })
  entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Entry
  set(FEED_TOKEN_KEY, 'old-token')
  set('ical_feed_enabled', '1')
  set(
    'webhook_targets',
    JSON.stringify(
      ['a', 'b'].map((id) => ({
        id,
        url: `https://${id}.example/hook`,
        secret: `old-secret-${id}`,
        events: ['entry.created'],
        enabled: true
      }))
    )
  )
})
afterEach(() => {
  useSecretStore(null)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function set(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}
function get(key: string): string {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string })
    .value
}
function settings(): Settings {
  const result = state.handlers.get('settings:getAll')!() as IpcResult<Settings>
  if (!result.ok) throw new Error(result.error)
  return result.data
}
function register(): void {
  registerIpcHandlers({
    confirmSensitiveSetting: async () => true,
    restartIcalFeed: vi.fn()
  } as unknown as IpcHooks)
}
function feed(token = 'old-token'): number {
  return buildFeedResponse(
    { getDb: () => db, getSetting: feedSettings(db) },
    `/feed.ics?token=${token}`
  ).status
}
async function delivery(): Promise<Array<{ body: string; signature: string }>> {
  const sent: Array<{ body: string; signature: string }> = []
  const log = vi.fn()
  emitWebhooks(db, 'entry.created', entry, {
    fetchImpl: (async (_url, init) => {
      sent.push({
        body: String(init?.body),
        signature: (init?.headers as Record<string, string>)['X-TimeTrack-Signature']
      })
      return { ok: true, status: 200 } as Response
    }) as typeof fetch,
    log
  })
  await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2))
  return sent
}

describe('startup secret migration and consumers', () => {
  it('migrates both webhook secrets before consumers run; the old token and signatures still work', async () => {
    const s = await initializeSecrets(db, join(dir, 'custom.sqlite'), { box: box() })
    expect(get(FEED_TOKEN_KEY)).toBe('')
    expect(
      parseWebhookTargets(get('webhook_targets')).map((t) => [t.secret, t.secretStored])
    ).toEqual([
      ['', true],
      ['', true]
    ])
    expect([
      s.get(FEED_TOKEN_KEY),
      s.get(webhookSecretKey('a')),
      s.get(webhookSecretKey('b'))
    ]).toEqual(['old-token', 'old-secret-a', 'old-secret-b'])
    expect(feed()).toBe(200)
    const sent = await delivery()
    expect(sent.map((s) => s.signature)).toEqual(
      sent.map((s, i) => signBody(`old-secret-${i === 0 ? 'a' : 'b'}`, s.body))
    )
    expect(readFileSync(join(dir, SECRETS_FILENAME), 'utf8')).not.toContain('old-secret')
    register()
    expect(settings().secret_storage).toBe('encrypted')
    expect(JSON.stringify(settings())).not.toContain('old-secret')
    expect(settings().ical_feed_token).toBeUndefined()
    expect(state.handlers.get('icalFeed:url')!()).toEqual({
      ok: true,
      data: feedUrl(feedSettings(db))
    })
  })

  it('keeps every row untouched when encryption succeeds but read-back cannot decrypt', async () => {
    const before = [get(FEED_TOKEN_KEY), get('webhook_targets')]
    await initializeSecrets(db, join(dir, 'custom.sqlite'), { box: box(true, false) })
    expect([get(FEED_TOKEN_KEY), get('webhook_targets')]).toEqual(before)
    expect(feed()).toBe(200)
    expect(await delivery()).toHaveLength(2)
  })

  it('plain mode leaves secrets in SQLite, serves the feed, signs deliveries and reports the mode', async () => {
    const before = [get(FEED_TOKEN_KEY), get('webhook_targets')]
    await initializeSecrets(db, join(dir, 'custom.sqlite'), { box: box(false) })
    expect([get(FEED_TOKEN_KEY), get('webhook_targets')]).toEqual(before)
    expect(feed()).toBe(200)
    const sent = await delivery()
    expect(sent[0].signature).toBe(signBody('old-secret-a', sent[0].body))
    register()
    expect(settings().secret_storage).toBe('plain')
    expect(JSON.stringify(settings())).not.toContain('old-secret')
    const result = await state.handlers.get('settings:set')!(
      null,
      'webhook_targets',
      settings().webhook_targets
    )
    expect(result).toEqual({ ok: true, data: undefined })
    expect(readWebhookTargets(db)[0].secret).toBe('old-secret-a')
  })

  it('unreadable secrets reject the feed and prevent webhook delivery', async () => {
    await initializeSecrets(db, join(dir, 'custom.sqlite'), { box: box() })
    await initializeSecrets(db, join(dir, 'custom.sqlite'), { box: box(true, false) })
    register()
    expect(settings().secret_storage).toBe('unreadable')
    expect(feed()).toBe(403)
    expect(await delivery()).toEqual([])
    const marked = settings().webhook_targets!
    expect(await state.handlers.get('settings:set')!(null, 'webhook_targets', marked)).toEqual({
      ok: true,
      data: undefined
    })
    expect(await delivery()).toEqual([])
    const regenerated = (await state.handlers.get('icalFeed:regenerate')!()) as IpcResult<string>
    expect(regenerated.ok).toBe(true)
    expect(readFeedToken(db)).not.toBe('')
    expect(feed(readFeedToken(db))).toBe(200)
    expect(await delivery()).toEqual([])
  })

  it('migrates restored plain values again on the next start, even with an old marker', async () => {
    await initializeSecrets(db, join(dir, 'custom.sqlite'), { box: box() })
    set(FEED_TOKEN_KEY, 'restored-token')
    set(
      'webhook_targets',
      JSON.stringify(
        parseWebhookTargets(get('webhook_targets')).map((t) => ({
          ...t,
          secret: `restored-${t.id}`
        }))
      )
    )
    expect(readWebhookTargets(db).map((t) => t.secret)).toEqual(['restored-a', 'restored-b'])
    const s = await initializeSecrets(db, join(dir, 'custom.sqlite'), { box: box() })
    expect(get(FEED_TOKEN_KEY)).toBe('')
    expect(get('webhook_targets')).not.toContain('restored-')
    expect([s.get(FEED_TOKEN_KEY), s.get(webhookSecretKey('a'))]).toEqual([
      'restored-token',
      'restored-a'
    ])
    expect(feed('restored-token')).toBe(200)
  })

  it('IPC sends markers, an empty editor keeps the secret, explicit clear removes it, regeneration persists', async () => {
    const s = await initializeSecrets(db, join(dir, 'custom.sqlite'), { box: box() })
    register()
    const edited = parseWebhookTargets(settings().webhook_targets)
    expect(edited[0]).toMatchObject({ secret: '', secretStored: true })
    edited[0].url = 'https://changed.example/hook'
    expect(
      await state.handlers.get('settings:set')!(null, 'webhook_targets', JSON.stringify(edited))
    ).toEqual({ ok: true, data: undefined })
    expect(s.get(webhookSecretKey('a'))).toBe('old-secret-a')
    edited[0].secretStored = undefined
    await state.handlers.get('settings:set')!(null, 'webhook_targets', JSON.stringify(edited))
    expect(s.get(webhookSecretKey('a'))).toBeUndefined()
    expect(readWebhookTargets(db)[0]).toMatchObject({ secret: '' })
    await state.handlers.get('icalFeed:regenerate')!()
    const next = readFeedToken(db)
    expect(next).not.toBe('old-token')
    expect(get(FEED_TOKEN_KEY)).toBe('')
    await initializeSecrets(db, join(dir, 'custom.sqlite'), { box: box() })
    expect(readFeedToken(db)).toBe(next)
  })

  it('a backup restored on another machine (no secrets file) is flagged per webhook and for the feed', async () => {
    await initializeSecrets(db, join(dir, 'custom.sqlite'), { box: box() })
    // The other machine: same database rows (markers, no secrets), no secrets file.
    const other = mkdtempSync(join(tmpdir(), 'tt-secret-other-'))
    try {
      await initializeSecrets(db, join(other, 'custom.sqlite'), { box: box() })
      register()
      const s = settings()
      expect(s.secret_storage).toBe('encrypted')
      expect(readFeedToken(db)).toBe('')
      expect(parseWebhookTargets(s.webhook_targets).map((t) => t.secretUnreadable)).toEqual([
        true,
        true
      ])
      expect(JSON.stringify(s)).not.toContain('old-secret')
      expect(await delivery()).toEqual([])
      expect(s.feed_token_recreated).toBeUndefined()
      markFeedTokenRecreated(db, true)
      // Kept in the database: a restart before the settings were opened keeps it.
      expect(get(FEED_TOKEN_RECREATED_KEY)).toBe('1')
      register()
      expect(settings().feed_token_recreated).toBe(true)
      await state.handlers.get('icalFeed:regenerate')!()
      expect(settings().feed_token_recreated).toBeUndefined()
    } finally {
      markFeedTokenRecreated(db, false)
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('no plaintext left in the database file after migration (#470 counter-check)', () => {
  it('neither the migrated values nor an older token remain in the file or its WAL', async () => {
    const fileDir = mkdtempSync(join(tmpdir(), 'tt-secret-file-'))
    const path = join(fileDir, 'tt.sqlite')
    const fdb = new Sqlite(path)
    try {
      fdb.pragma('journal_mode = WAL')
      applyMigrations(fdb)
      const put = (k: string, v: string): void => {
        fdb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v)
      }
      // Order matters for the page layout: without secure_delete and the scrub,
      // 'current-token-zz9' stays in the freed cell (red probe 2026-10-31).
      put(
        'webhook_targets',
        JSON.stringify([
          {
            id: 'w',
            url: 'https://w.example/h',
            secret: 'hook-secret-zz9',
            events: ['entry.created'],
            enabled: true
          }
        ])
      )
      put(FEED_TOKEN_KEY, 'older-token-zz9')
      put(FEED_TOKEN_KEY, 'current-token-zz9')
      // An earlier, long secret value deleted before the update: its overflow
      // pages sit on the freelist with the bytes intact (secure_delete was off).
      put('zz_old_secret', 'history-secret-zz9 '.repeat(2000))
      fdb.prepare(`DELETE FROM settings WHERE key = 'zz_old_secret'`).run()
      fdb.pragma('wal_checkpoint(TRUNCATE)')
      expect(fdb.pragma('freelist_count', { simple: true })).toBeGreaterThan(0)
      expect(readFileSync(path).toString('latin1')).toContain('history-secret-zz9')
      await initializeSecrets(fdb, path, { box: box() })
      useSecretStore(null)
      expect(fdb.pragma('secure_delete', { simple: true })).toBe(1)
      expect(fdb.pragma('freelist_count', { simple: true })).toBe(0)
      fdb.close()
      const bytes = [path, `${path}-wal`]
        .filter((p) => existsSync(p))
        .map((p) => readFileSync(p).toString('latin1'))
        .join('')
      for (const secret of [
        'older-token-zz9',
        'current-token-zz9',
        'hook-secret-zz9',
        'history-secret-zz9'
      ]) {
        expect(bytes).not.toContain(secret)
      }
    } finally {
      if (fdb.open) fdb.close()
      rmSync(fileDir, { recursive: true, force: true })
    }
  })
})

describe('reported storage when the migration fails (#470 counter-check 2)', () => {
  it('says plain while plain secrets are still in the database', async () => {
    const failing: AsyncSecretBox = {
      ...box(),
      encryptStringAsync: async () => {
        throw new Error('cannot write')
      }
    }
    await initializeSecrets(db, join(dir, 'custom.sqlite'), { box: failing })
    expect(get(FEED_TOKEN_KEY)).toBe('old-token')
    register()
    expect(settings().secret_storage).toBe('plain')
  })
})

describe('saving several webhook targets is one write (#470 counter-check 3)', () => {
  it('keeps every secret when the write fails', async () => {
    // Only the write carrying B's new secret fails, so a save that writes per
    // target would already have removed A's secret from the file.
    let fail = false
    const flaky: AsyncSecretBox = {
      ...box(),
      encryptStringAsync: async (value) => {
        if (fail && value.includes('new-b')) throw new Error('cannot write')
        return box().encryptStringAsync(value)
      }
    }
    const s = new SecretStore({ dir, box: flaky })
    await s.load()
    await s.set(webhookSecretKey('a'), 'old-a')
    await s.set(webhookSecretKey('b'), 'old-b')
    const target = (id: string): Record<string, unknown> => ({
      id,
      url: `https://${id}.example`,
      secret: '',
      secretStored: true,
      events: ['entry.created'],
      enabled: true
    })
    const current = JSON.stringify([target('a'), target('b')])
    // A clears its secret, B gets a new one; the single write fails.
    const next = [
      { ...target('a'), secretStored: undefined },
      { ...target('b'), secret: 'new-b' }
    ]
    fail = true
    await expect(prepareWebhookTargets(JSON.stringify(next), s, current)).rejects.toThrow(
      'cannot write'
    )
    expect(s.get(webhookSecretKey('a'))).toBe('old-a')
    expect(s.get(webhookSecretKey('b'))).toBe('old-b')
    fail = false
    const reread = new SecretStore({ dir, box: flaky })
    await reread.load()
    expect(reread.get(webhookSecretKey('a'))).toBe('old-a')
    expect(reread.get(webhookSecretKey('b'))).toBe('old-b')
  })
})

describe('settings write failures and late migration (#470 counter-check 4)', () => {
  it('restores the webhook secrets when the database write fails', async () => {
    await initializeSecrets(db, join(dir, 'custom.sqlite'), { box: box() })
    db.exec(`CREATE TRIGGER no_targets BEFORE INSERT ON settings
      WHEN NEW.key = 'webhook_targets' BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    const before = get('webhook_targets')
    // The window removes target a.
    const onlyB = JSON.stringify(
      parseWebhookTargets(webhookTargetsForRenderer(db)).filter((t) => t.id === 'b')
    )
    await expect(saveWebhookTargets(db, onlyB, before)).rejects.toThrow('disk full')
    expect(get('webhook_targets')).toBe(before)
    expect(readWebhookTargets(db).map((t) => t.secret)).toEqual(['old-secret-a', 'old-secret-b'])
    useSecretStore(null)
    const reread = await initializeSecrets(db, join(dir, 'custom.sqlite'), { box: box() })
    expect(reread.get(webhookSecretKey('a'))).toBe('old-secret-a')
  })

  it('keeps the feed token when the database write after regenerating fails', async () => {
    const s = await initializeSecrets(db, join(dir, 'custom.sqlite'), { box: box() })
    db.exec(`CREATE TRIGGER no_token BEFORE INSERT ON settings
      WHEN NEW.key = 'ical_feed_token' BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    await expect(writeFeedToken(db, 'new-token')).rejects.toThrow('disk full')
    expect(s.get(FEED_TOKEN_KEY)).toBe('old-token')
    expect(readFeedToken(db)).toBe('old-token')
  })

  it('scrubs the file when a later save moves secrets a failed start migration left', async () => {
    const fileDir = mkdtempSync(join(tmpdir(), 'tt-secret-late-'))
    const path = join(fileDir, 'tt.sqlite')
    const fdb = new Sqlite(path)
    try {
      fdb.pragma('journal_mode = WAL')
      applyMigrations(fdb)
      const target = {
        id: 'w',
        url: 'https://w.example/h',
        secret: 'late-secret-zz9',
        events: ['entry.created'],
        enabled: true
      }
      const put = (k: string, v: string): void => {
        fdb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v)
      }
      // An earlier, long secret of the same target, replaced before the update:
      // its overflow pages sit on the freelist with the bytes intact. Only the
      // scrub after the late save removes them (red probe 2026-10-31).
      put('webhook_targets', JSON.stringify([{ ...target, secret: 'history-zz9 '.repeat(2000) }]))
      put('webhook_targets', JSON.stringify([target]))
      fdb.pragma('wal_checkpoint(TRUNCATE)')
      expect(fdb.pragma('freelist_count', { simple: true })).toBeGreaterThan(0)
      expect(readFileSync(path).toString('latin1')).toContain('history-zz9')
      let broken = true
      const flaky: AsyncSecretBox = {
        ...box(),
        encryptStringAsync: async (value) => {
          if (broken) throw new Error('cannot write')
          return box().encryptStringAsync(value)
        }
      }
      await initializeSecrets(fdb, path, { box: flaky })
      const current = fdb
        .prepare(`SELECT value FROM settings WHERE key = 'webhook_targets'`)
        .pluck()
        .get() as string
      expect(current).toContain('late-secret-zz9')
      broken = false
      const fromWindow = webhookTargetsForRenderer(fdb)
      await saveWebhookTargets(fdb, fromWindow, current)
      expect(readWebhookTargets(fdb).map((t) => t.secret)).toEqual(['late-secret-zz9'])
      useSecretStore(null)
      fdb.close()
      const bytes = [path, `${path}-wal`]
        .filter((p) => existsSync(p))
        .map((p) => readFileSync(p).toString('latin1'))
        .join('')
      expect(bytes).not.toContain('late-secret-zz9')
      expect(bytes).not.toContain('history-zz9')
    } finally {
      useSecretStore(null)
      if (fdb.open) fdb.close()
      rmSync(fileDir, { recursive: true, force: true })
    }
  })
})

describe('one scrub at the first start, also without secrets to move (#470 counter-check 5)', () => {
  function historyDb(): { path: string; fileDir: string; fdb: Database.Database } {
    const fileDir = mkdtempSync(join(tmpdir(), 'tt-secret-once-'))
    const path = join(fileDir, 'tt.sqlite')
    const fdb = new Sqlite(path)
    fdb.pragma('journal_mode = WAL')
    applyMigrations(fdb)
    const put = (k: string, v: string): void => {
      fdb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v)
    }
    // The last webhook with a long secret, removed before the update: nothing
    // is left to migrate, but the bytes sit on the freelist.
    put(
      'webhook_targets',
      JSON.stringify([
        {
          id: 'w',
          url: 'https://w.example/h',
          secret: 'gone-zz9 '.repeat(2000),
          events: ['entry.created'],
          enabled: true
        }
      ])
    )
    put('webhook_targets', '[]')
    fdb.pragma('wal_checkpoint(TRUNCATE)')
    expect(readFileSync(path).toString('latin1')).toContain('gone-zz9')
    return { path, fileDir, fdb }
  }
  function fileBytes(path: string): string {
    return [path, `${path}-wal`]
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p).toString('latin1'))
      .join('')
  }

  it('scrubs once and remembers it', async () => {
    const { path, fileDir, fdb } = historyDb()
    try {
      await initializeSecrets(fdb, path, { box: box() })
      useSecretStore(null)
      expect(
        fdb.prepare(`SELECT value FROM settings WHERE key = 'secrets_scrubbed'`).pluck().get()
      ).toBe('1')
      fdb.close()
      expect(fileBytes(path)).not.toContain('gone-zz9')
    } finally {
      if (fdb.open) fdb.close()
      rmSync(fileDir, { recursive: true, force: true })
    }
  })

  it('a failed scrub does not stop the start and is tried again at the next start', async () => {
    const { path, fileDir, fdb } = historyDb()
    // Another process holds the write lock (e.g. a running MCP server write).
    const other = new Sqlite(path)
    try {
      fdb.pragma('busy_timeout = 0')
      other.exec('BEGIN IMMEDIATE')
      const log = vi.fn()
      await expect(initializeSecrets(fdb, path, { box: box(), log })).resolves.toBeDefined()
      expect(log).toHaveBeenCalledWith(expect.stringContaining('free-space scrub skipped'))
      expect(
        fdb.prepare(`SELECT value FROM settings WHERE key = 'secrets_scrubbed'`).pluck().get()
      ).toBeUndefined()
      other.exec('ROLLBACK')
      other.close()
      useSecretStore(null)
      await initializeSecrets(fdb, path, { box: box() })
      useSecretStore(null)
      expect(
        fdb.prepare(`SELECT value FROM settings WHERE key = 'secrets_scrubbed'`).pluck().get()
      ).toBe('1')
      fdb.close()
      expect(fileBytes(path)).not.toContain('gone-zz9')
    } finally {
      if (other.open) other.close()
      if (fdb.open) fdb.close()
      rmSync(fileDir, { recursive: true, force: true })
    }
  })
})

describe('scrub completeness and targets the parser drops (#470 counter-check 6)', () => {
  it('moves the secret of a half-typed target 2.2 stored unparsed', async () => {
    set(FEED_TOKEN_KEY, '')
    set(
      'webhook_targets',
      JSON.stringify([
        { id: 'h', url: 'https://', secret: 'halfway-zz9', events: [], enabled: false },
        { url: 'nope', secret: 'no-id-zz9' }
      ])
    )
    const s = await initializeSecrets(db, join(dir, 'custom.sqlite'), { box: box() })
    expect(get('webhook_targets')).not.toContain('halfway-zz9')
    expect(get('webhook_targets')).not.toContain('no-id-zz9')
    expect(s.get(webhookSecretKey('h'))).toBe('halfway-zz9')
    register()
    expect(settings().secret_storage).toBe('encrypted')
  })

  it('a checkpoint left busy by a reader is no completed scrub', async () => {
    const fileDir = mkdtempSync(join(tmpdir(), 'tt-secret-busy-'))
    const path = join(fileDir, 'tt.sqlite')
    const fdb = new Sqlite(path)
    const reader = new Sqlite(path)
    const marker = (): unknown =>
      fdb.prepare(`SELECT value FROM settings WHERE key = 'secrets_scrubbed'`).pluck().get()
    try {
      fdb.pragma('journal_mode = WAL')
      fdb.pragma('busy_timeout = 0')
      applyMigrations(fdb)
      // A reader on another connection keeps its snapshot open.
      reader.exec('BEGIN')
      reader.prepare('SELECT count(*) FROM settings').get()
      const log = vi.fn()
      await initializeSecrets(fdb, path, { box: box(), log })
      useSecretStore(null)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('checkpoint busy'))
      expect(marker()).toBeUndefined()
      reader.exec('COMMIT')
      await initializeSecrets(fdb, path, { box: box() })
      useSecretStore(null)
      expect(marker()).toBe('1')
    } finally {
      if (reader.open) reader.close()
      if (fdb.open) fdb.close()
      rmSync(fileDir, { recursive: true, force: true })
    }
  })
})
