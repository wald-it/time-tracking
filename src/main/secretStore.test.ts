/**
 * Q32: the secret store and the move of the iCal feed token and the webhook
 * secrets out of the `settings` table. A fake async box stands in for
 * Electron's `safeStorage`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import {
  FEED_TOKEN_KEY,
  SECRETS_FILENAME,
  SecretStore,
  webhookSecretKey,
  type AsyncSecretBox
} from './secretStore'
import {
  migrateSecrets,
  prepareWebhookTargets,
  readFeedToken,
  readWebhookTargets,
  writeFeedToken
} from './secretSettings'

interface FakeBoxOptions {
  available?: boolean
  /** Ciphertext with this prefix decrypts, but asks to be re-encrypted. */
  oldPrefix?: string
  failEncrypt?: boolean
}

function fakeBox(o: FakeBoxOptions = {}): AsyncSecretBox {
  return {
    isAsyncEncryptionAvailable: async () => o.available !== false,
    encryptStringAsync: async (plain) => {
      if (o.failEncrypt) throw new Error('encryption failed')
      return Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`)
    },
    decryptStringAsync: async (cipher) => {
      const s = cipher.toString('utf8')
      const old = o.oldPrefix && s.startsWith(o.oldPrefix)
      const prefix = old ? o.oldPrefix! : 'enc:'
      if (!s.startsWith(prefix)) throw new Error('bad ciphertext')
      return {
        shouldReEncrypt: Boolean(old),
        result: Buffer.from(s.slice(prefix.length), 'base64').toString('utf8')
      }
    }
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-secrets-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const file = (): string => join(dir, SECRETS_FILENAME)

async function opened(o: FakeBoxOptions = {}): Promise<SecretStore> {
  const s = new SecretStore({ dir, box: fakeBox(o) })
  await s.load()
  return s
}

describe('SecretStore', () => {
  it('treats a decrypted file with an invalid shape as unreadable', async () => {
    writeFileSync(file(), await fakeBox().encryptStringAsync('{"v":1}'))
    const s = await opened()
    expect(s.mode).toBe('unreadable')
    expect(s.get(FEED_TOKEN_KEY)).toBeUndefined()
  })
  it('keeps values across a restart, encrypted on disk', async () => {
    const s = await opened()
    await s.set(FEED_TOKEN_KEY, 'tok-1')
    await s.set(webhookSecretKey('a'), 'sec-a')
    expect(readFileSync(file(), 'utf8')).not.toContain('tok-1')
    const again = await opened()
    expect([again.mode, again.get(FEED_TOKEN_KEY), again.get(webhookSecretKey('a'))]).toEqual([
      'encrypted',
      'tok-1',
      'sec-a'
    ])
  })

  it('writes in order: the last value of each key wins on disk', async () => {
    const s = await opened()
    void s.set('k', 'one')
    void s.set('k', 'two')
    void s.set('other', 'x')
    await s.flush()
    const again = await opened()
    expect([again.get('k'), again.get('other')]).toEqual(['two', 'x'])
  })

  it('an empty value removes the key', async () => {
    const s = await opened()
    await s.set('k', 'v')
    await s.set('k', '')
    expect((await opened()).has('k')).toBe(false)
  })

  it('without system encryption it writes nothing and says so', async () => {
    const s = await opened({ available: false })
    expect(s.mode).toBe('plain')
    await s.set(FEED_TOKEN_KEY, 'tok')
    expect(s.get(FEED_TOKEN_KEY)).toBeUndefined()
    expect(existsSync(file())).toBe(false)
  })

  it('an unreadable file: no values, the file left as it is until the next write', async () => {
    writeFileSync(file(), 'not ours')
    const s = await opened()
    expect([s.mode, s.get(FEED_TOKEN_KEY)]).toEqual(['unreadable', undefined])
    expect(readFileSync(file(), 'utf8')).toBe('not ours')
    await s.set(FEED_TOKEN_KEY, 'new')
    expect(s.mode).toBe('encrypted')
    expect((await opened()).get(FEED_TOKEN_KEY)).toBe('new')
  })

  it('re-encrypts when the system asks for it', async () => {
    const plain = JSON.stringify({ v: 1, values: { k: 'v' } })
    writeFileSync(file(), `old:${Buffer.from(plain).toString('base64')}`)
    const s = await opened({ oldPrefix: 'old:' })
    await s.flush()
    expect(s.get('k')).toBe('v')
    expect(readFileSync(file(), 'utf8').startsWith('enc:')).toBe(true)
  })
})

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

function freshDb(): Database.Database {
  const db = new DatabaseImpl(':memory:')
  applyMigrations(db)
  return db
}

const setRow = (db: Database.Database, key: string, value: string): void => {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value)
}
const getRow = (db: Database.Database, key: string): string =>
  (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string }).value

const TARGETS = JSON.stringify([
  {
    id: 'a',
    url: 'https://a.example/hook',
    secret: 'sec-a',
    events: ['timer.started'],
    enabled: true
  },
  { id: 'b', url: 'https://b.example/hook', secret: '', events: ['timer.stopped'], enabled: true }
])

/** Every settings value, to check that no secret is left in the database. */
const allRows = (db: Database.Database): string[] =>
  (db.prepare(`SELECT value FROM settings`).all() as Array<{ value: string }>).map((r) => r.value)

describe('moving the secrets out of the database (migration)', () => {
  it('feed token and webhook secrets end up in the store, and no settings row holds them', async () => {
    const db = freshDb()
    setRow(db, FEED_TOKEN_KEY, 'tok-plain')
    setRow(db, 'webhook_targets', TARGETS)
    const s = await opened()
    await migrateSecrets(db, s, dir)

    const stored = [s.get(FEED_TOKEN_KEY), s.get(webhookSecretKey('a'))]
    expect(stored).toEqual(['tok-plain', 'sec-a'])
    // The guard: not one value from the store may still appear in the database.
    for (const value of stored) {
      expect(allRows(db).some((r) => r.includes(value!))).toBe(false)
    }
    expect(JSON.parse(getRow(db, 'webhook_targets'))).toMatchObject([
      { id: 'a', secret: '', secretStored: true },
      { id: 'b', secret: '' }
    ])
    // The readers put them back together.
    expect(readFeedToken(db, s)).toBe('tok-plain')
    expect(readWebhookTargets(db, s).map((t) => t.secret)).toEqual(['sec-a', ''])
  })

  it('a failed write leaves the database as it was', async () => {
    const db = freshDb()
    setRow(db, FEED_TOKEN_KEY, 'tok-plain')
    setRow(db, 'webhook_targets', TARGETS)
    const s = await opened({ failEncrypt: true })
    await expect(migrateSecrets(db, s, dir)).rejects.toThrow()
    expect(getRow(db, FEED_TOKEN_KEY)).toBe('tok-plain')
    expect(getRow(db, 'webhook_targets')).toBe(TARGETS)
  })

  it('a read-back that does not match leaves the database as it was', async () => {
    const db = freshDb()
    setRow(db, FEED_TOKEN_KEY, 'tok-plain')
    // The store writes, but the file is replaced before the check reads it.
    const s = await opened()
    const original = s.flush.bind(s)
    s.flush = async (): Promise<void> => {
      await original()
      writeFileSync(file(), 'garbled')
    }
    await migrateSecrets(db, s, dir)
    expect(getRow(db, FEED_TOKEN_KEY)).toBe('tok-plain')
  })

  it('runs again without harm, and a plain value in the database wins over the file', async () => {
    const db = freshDb()
    setRow(db, FEED_TOKEN_KEY, 'tok-1')
    const s = await opened()
    await migrateSecrets(db, s, dir)
    await migrateSecrets(db, s, dir)
    expect([s.get(FEED_TOKEN_KEY), getRow(db, FEED_TOKEN_KEY)]).toEqual(['tok-1', ''])
    // An older backup restored: the database holds a plain token again.
    setRow(db, FEED_TOKEN_KEY, 'tok-from-backup')
    await migrateSecrets(db, s, dir)
    expect([s.get(FEED_TOKEN_KEY), getRow(db, FEED_TOKEN_KEY)]).toEqual(['tok-from-backup', ''])
  })

  it('without system encryption nothing moves', async () => {
    const db = freshDb()
    setRow(db, FEED_TOKEN_KEY, 'tok-plain')
    setRow(db, 'webhook_targets', TARGETS)
    const s = await opened({ available: false })
    await migrateSecrets(db, s, dir)
    expect(getRow(db, FEED_TOKEN_KEY)).toBe('tok-plain')
    expect(readFeedToken(db, s)).toBe('tok-plain')
    expect(readWebhookTargets(db, s)[0].secret).toBe('sec-a')
  })
})

describe('reading and writing through the store', () => {
  it('a new feed token goes to the store, the database keeps none', async () => {
    const db = freshDb()
    const s = await opened()
    await writeFeedToken(db, 'tok-new', s)
    expect([getRow(db, FEED_TOKEN_KEY), readFeedToken(db, s)]).toEqual(['', 'tok-new'])
  })

  it('an unreadable store: the feed has no token, a stored webhook secret fails closed', async () => {
    const db = freshDb()
    setRow(db, FEED_TOKEN_KEY, '')
    setRow(
      db,
      'webhook_targets',
      JSON.stringify([
        {
          id: 'a',
          url: 'https://a.example/hook',
          secret: '',
          secretStored: true,
          events: [],
          enabled: true
        }
      ])
    )
    writeFileSync(file(), 'from another machine')
    const s = await opened()
    expect(readFeedToken(db, s)).toBe('')
    expect(readWebhookTargets(db, s)).toMatchObject([
      { id: 'a', secret: '', secretUnreadable: true }
    ])
  })

  it('the window saves: secrets to the store, removed targets pruned, an unreadable one kept closed', async () => {
    const s = await opened()
    await s.set(webhookSecretKey('gone'), 'old')
    const blob = await prepareWebhookTargets(
      JSON.stringify([
        { id: 'a', url: 'https://a.example/hook', secret: 'sec-a', events: [], enabled: true },
        {
          id: 'u',
          url: 'https://u.example/hook',
          secret: '',
          secretStored: true,
          secretUnreadable: true,
          events: [],
          enabled: true
        },
        { id: 'n', url: 'https://n.example/hook', secret: '', events: [], enabled: true }
      ]),
      s
    )
    expect(JSON.parse(blob)).toEqual([
      {
        id: 'a',
        url: 'https://a.example/hook',
        secret: '',
        events: [],
        enabled: true,
        secretStored: true
      },
      {
        id: 'u',
        url: 'https://u.example/hook',
        secret: '',
        events: [],
        enabled: true,
        secretStored: true
      },
      { id: 'n', url: 'https://n.example/hook', secret: '', events: [], enabled: true }
    ])
    expect(blob).not.toContain('sec-a')
    const again = await opened()
    expect([again.get(webhookSecretKey('a')), again.has(webhookSecretKey('gone'))]).toEqual([
      'sec-a',
      false
    ])
  })
})

describe('secret store — failures keep what is in force (#470 counter-check)', () => {
  it('a failed write puts the previous value back and reports the failure', async () => {
    const opts: FakeBoxOptions = {}
    const store = new SecretStore({ dir, box: fakeBox(opts) })
    await store.load()
    await store.set(FEED_TOKEN_KEY, 'in-use')
    opts.failEncrypt = true
    await expect(store.set(FEED_TOKEN_KEY, 'new')).rejects.toThrow('encryption failed')
    expect(store.get(FEED_TOKEN_KEY)).toBe('in-use')
    await expect(store.set(webhookSecretKey('x'), 'fresh')).rejects.toThrow()
    expect(store.has(webhookSecretKey('x'))).toBe(false)
  })

  it('a failed optional re-encryption keeps the values that were read', async () => {
    const plain = JSON.stringify({ v: 1, values: { [FEED_TOKEN_KEY]: 'kept' } })
    writeFileSync(join(dir, SECRETS_FILENAME), `old:${Buffer.from(plain).toString('base64')}`)
    const store = new SecretStore({ dir, box: fakeBox({ oldPrefix: 'old:', failEncrypt: true }) })
    await store.load()
    expect(store.mode).toBe('encrypted')
    expect(store.get(FEED_TOKEN_KEY)).toBe('kept')
  })

  it('a target dropped for an invalid URL keeps its secret until the URL is fixed', async () => {
    const store = new SecretStore({ dir, box: fakeBox() })
    await store.load()
    const target = {
      id: 't1',
      url: 'https://ok.example/hook',
      secret: 's3cret',
      events: ['entry.created'],
      enabled: true
    }
    const saved = await prepareWebhookTargets(JSON.stringify([target]), store)
    const marked = { ...JSON.parse(saved)[0], secret: '' }
    // Half-typed URL: the parser drops the target, the secret must survive.
    await prepareWebhookTargets(JSON.stringify([{ ...marked, url: 'https://' }]), store, saved)
    expect(store.get(webhookSecretKey('t1'))).toBe('s3cret')
    await prepareWebhookTargets(JSON.stringify([marked]), store, saved)
    expect(store.get(webhookSecretKey('t1'))).toBe('s3cret')
    // Really removed: pruned.
    await prepareWebhookTargets('[]', store, saved)
    expect(store.has(webhookSecretKey('t1'))).toBe(false)
  })
})

describe('secret store — overlapping writes and plain-mode edits (#470 counter-check 2)', () => {
  function selectiveBox(failWhen: (plain: string) => boolean): AsyncSecretBox {
    const base = fakeBox()
    return {
      ...base,
      encryptStringAsync: async (plain) => {
        if (failWhen(plain)) throw new Error('encryption failed')
        return base.encryptStringAsync(plain)
      }
    }
  }

  it('a failed write does not reach the file through a later successful one', async () => {
    const box = selectiveBox((plain) => plain.includes('rejected-token'))
    const store = new SecretStore({ dir, box })
    await store.load()
    await store.set(FEED_TOKEN_KEY, 'token-in-use')
    const failing = store.set(FEED_TOKEN_KEY, 'rejected-token')
    const succeeding = store.set(webhookSecretKey('w'), 'hook-secret')
    await expect(failing).rejects.toThrow()
    await succeeding
    expect(store.get(FEED_TOKEN_KEY)).toBe('token-in-use')
    const reread = new SecretStore({ dir, box })
    await reread.load()
    expect(reread.get(FEED_TOKEN_KEY)).toBe('token-in-use')
    expect(reread.get(webhookSecretKey('w'))).toBe('hook-secret')
  })

  it('a failed prune keeps the secrets in force', async () => {
    const opts: FakeBoxOptions = {}
    const store = new SecretStore({ dir, box: fakeBox(opts) })
    await store.load()
    await store.set(webhookSecretKey('w'), 'hook-secret')
    opts.failEncrypt = true
    await expect(store.prune('webhook:', new Set())).rejects.toThrow()
    expect(store.get(webhookSecretKey('w'))).toBe('hook-secret')
  })

  it('plain mode: a target dropped for an invalid URL gets its secret back when fixed', async () => {
    const store = new SecretStore({ dir, box: fakeBox({ available: false }) })
    await store.load()
    expect(store.mode).toBe('plain')
    const target = {
      id: 'p1',
      url: 'https://ok.example/hook',
      secret: 'plain-secret',
      events: ['entry.created'],
      enabled: true
    }
    const saved = await prepareWebhookTargets(JSON.stringify([target]), store)
    const marked = { ...target, secret: '', secretStored: true }
    const dropped = await prepareWebhookTargets(
      JSON.stringify([{ ...marked, url: 'https://' }]),
      store,
      saved
    )
    expect(JSON.parse(dropped)).toEqual([])
    const fixed = await prepareWebhookTargets(JSON.stringify([marked]), store, dropped)
    expect(JSON.parse(fixed)[0]).toMatchObject({ id: 'p1', secret: 'plain-secret' })
  })
})
