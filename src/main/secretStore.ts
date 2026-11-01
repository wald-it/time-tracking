/**
 * At-rest storage for the iCal feed token and the webhook secrets (Q32).
 *
 * Until 2.3 both sat in the `settings` table in plain text, so every backup of
 * the `.sqlite` file carried them. They now live in a file of their own beside
 * the database, encrypted with Electron's `safeStorage` — the same reasoning as
 * `graphTokenStore.ts`: a backup restored on another machine does not bring
 * secrets along, which is honest, because DPAPI/Keychain could not decrypt them
 * there anyway.
 *
 * **Async API.** Electron 46 removes the synchronous `safeStorage` calls, so
 * this module uses `isAsyncEncryptionAvailable` / `encryptStringAsync` /
 * `decryptStringAsync` from the start. The callers (feed server, webhook
 * delivery) read synchronously, so the store keeps the decrypted values in
 * memory: `load()` once after app start, reads from the cache, writes update
 * the cache at once and reach the file in order.
 *
 * **Modes.**
 * - `encrypted`: the normal case; secrets go to the file.
 * - `plain`: the system offers no encryption (in practice a broken keychain).
 *   Nothing is written to the file; callers keep the secrets in the database
 *   as before and show a hint. Switching the features off instead would take
 *   them away without protecting anything.
 * - `unreadable`: a file exists but cannot be decrypted (copied from another
 *   machine, key changed). Callers fail closed: a webhook whose secret is gone
 *   is not delivered, the feed has no token. The file is left as it is until
 *   the next write replaces it.
 */
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SECRETS_FILENAME = 'secrets.enc'

/** The key under which the iCal feed token is kept. */
export const FEED_TOKEN_KEY = 'ical_feed_token'

/** The key for one webhook target's HMAC secret. */
export function webhookSecretKey(targetId: string): string {
  return `webhook:${targetId}`
}

/** The slice of Electron's async `safeStorage` this module needs. Injectable for tests. */
export interface AsyncSecretBox {
  isAsyncEncryptionAvailable: () => Promise<boolean>
  encryptStringAsync: (plain: string) => Promise<Buffer>
  decryptStringAsync: (cipher: Buffer) => Promise<{ shouldReEncrypt: boolean; result: string }>
}

export type SecretMode = 'encrypted' | 'plain' | 'unreadable'

export interface SecretStoreDeps {
  /** Directory of the database the app opened — required, see graphTokenStore.ts. */
  dir: string
  box?: AsyncSecretBox
  log?: (message: string) => void
}

/** Electron's real `safeStorage`, resolved lazily (see graphTokenStore.ts for why). */
function electronBox(): AsyncSecretBox {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Q32: lazy, like graphTokenStore
  const { safeStorage } = require('electron') as { safeStorage: AsyncSecretBox }
  return safeStorage
}

interface FileShape {
  v: 1
  values: Record<string, string>
}

export class SecretStore {
  private readonly file: string
  private readonly box: () => AsyncSecretBox
  private readonly log: (m: string) => void
  private values = new Map<string, string>()
  private currentMode: SecretMode = 'plain'
  private loaded: Promise<void> | null = null
  private writes: Promise<void> = Promise.resolve()
  /** What the file holds: the read values, then each successful write. */
  private committed = new Map<string, string>()
  private everWritten = false
  private unreadableAtLoad = false

  constructor(deps: SecretStoreDeps) {
    this.file = join(deps.dir, SECRETS_FILENAME)
    const injected = deps.box
    this.box = (): AsyncSecretBox => injected ?? electronBox()
    this.log = deps.log ?? ((): void => {})
  }

  /** Read the file once. Safe to call repeatedly; later calls share the first. */
  load(): Promise<void> {
    this.loaded ??= this.readFile()
    return this.loaded
  }

  get mode(): SecretMode {
    return this.currentMode
  }

  /** The stored value, or undefined when the store has none (or cannot read it). */
  get(key: string): string | undefined {
    return this.values.get(key)
  }

  has(key: string): boolean {
    return this.values.has(key)
  }

  /** The cached values whose key starts with `prefix` — a snapshot to roll back to. */
  entries(prefix: string): Map<string, string> {
    return new Map([...this.values].filter(([k]) => k.startsWith(prefix)))
  }

  /**
   * Set (or, with '', remove) a value. The cache changes at once; the returned
   * promise settles when the file is written. In `plain` mode nothing is
   * written and the caller keeps the value in the database.
   */
  set(key: string, value: string): Promise<void> {
    if (this.currentMode === 'plain') return Promise.resolve()
    if (value === '') this.values.delete(key)
    else this.values.set(key, value)
    // A write replaces an unreadable file: what could not be read is gone
    // anyway, and what is set now must not be lost.
    this.currentMode = 'encrypted'
    return this.enqueue((next) => {
      if (value === '') next.delete(key)
      else next.set(key, value)
    }).catch((err: unknown) => {
      // Not on disk: back to what the file holds (unless a later set replaced
      // it), so a failed regeneration does not invalidate the feed URL in use
      // and a failed secret change does not alter signatures.
      if (this.values.get(key) === (value === '' ? undefined : value)) this.revert(key)
      throw err
    })
  }

  /** Remove every key not in `keep` that starts with `prefix`. */
  prune(prefix: string, keep: ReadonlySet<string>): Promise<void> {
    return this.commit([], { prefix, keep })
  }

  /**
   * Several changes as one write: every `set` entry (value '' removes) and,
   * optionally, a prune of `prefix` keys not in `keep`. Either all of it
   * reaches the file or none of it — a save of several webhook targets must
   * not leave half its secret changes on disk when a later one fails.
   */
  commit(
    entries: ReadonlyArray<readonly [string, string]>,
    prune?: { prefix: string; keep: ReadonlySet<string> }
  ): Promise<void> {
    if (this.currentMode === 'plain') return Promise.resolve()
    for (const [key, value] of entries) {
      if (value === '') this.values.delete(key)
      else this.values.set(key, value)
    }
    const removed = prune
      ? [...this.values.keys()].filter((k) => k.startsWith(prune.prefix) && !prune.keep.has(k))
      : []
    for (const key of removed) this.values.delete(key)
    if (entries.length === 0 && removed.length === 0) return this.writes
    this.currentMode = 'encrypted'
    return this.enqueue((next) => {
      for (const [key, value] of entries) {
        if (value === '') next.delete(key)
        else next.set(key, value)
      }
      for (const key of removed) next.delete(key)
    }).catch((err: unknown) => {
      // Not on disk: every touched key back to what the file holds, unless a
      // later call changed it meanwhile.
      for (const [key, value] of entries) {
        if (this.values.get(key) === (value === '' ? undefined : value)) this.revert(key)
      }
      for (const key of removed) if (!this.values.has(key)) this.revert(key)
      throw err
    })
  }

  /** Put `key` in the cache back to what the file holds. */
  private revert(key: string): void {
    const onDisk = this.committed.get(key)
    if (onDisk === undefined) this.values.delete(key)
    else this.values.set(key, onDisk)
    if (!this.everWritten && this.unreadableAtLoad) this.currentMode = 'unreadable'
  }

  /** The box in use, so a read-back check can open the file the same way. */
  boxForCheck(): AsyncSecretBox {
    return this.box()
  }

  /** Settles when every write issued so far has reached the file. */
  flush(): Promise<void> {
    return this.writes
  }

  /**
   * Queue one change. The file content is built when the write runs, from what
   * the file holds after the earlier writes plus this change, never from the
   * cache: a write that failed (and was reverted) does not reach the file
   * through a later one.
   */
  private enqueue(change: (next: Map<string, string>) => void): Promise<void> {
    const run = this.writes.then(async () => {
      const next = new Map(this.committed)
      change(next)
      await this.writeFile({ v: 1, values: Object.fromEntries(next) })
      this.committed = next
      this.everWritten = true
    })
    // A failed write is reported to its caller, but must not block later ones.
    this.writes = run.catch(() => undefined)
    return run
  }

  private async readFile(): Promise<void> {
    let available = false
    try {
      available = await this.box().isAsyncEncryptionAvailable()
    } catch {
      available = false
    }
    if (!available) {
      this.currentMode = 'plain'
      this.log('secret store: no system encryption, secrets stay in the database')
      return
    }
    this.currentMode = 'encrypted'
    if (!existsSync(this.file)) return
    let reEncrypt = false
    try {
      const { result, shouldReEncrypt } = await this.box().decryptStringAsync(
        readFileSync(this.file)
      )
      const parsed = JSON.parse(result) as Partial<FileShape>
      if (
        !parsed ||
        parsed.v !== 1 ||
        !parsed.values ||
        typeof parsed.values !== 'object' ||
        Array.isArray(parsed.values)
      ) {
        throw new Error('unexpected secret store shape')
      }
      for (const [k, v] of Object.entries(parsed.values)) {
        if (typeof v === 'string' && v !== '') this.values.set(k, v)
      }
      reEncrypt = shouldReEncrypt
      this.committed = new Map(this.values)
    } catch (err) {
      // No token material in the message.
      this.currentMode = 'unreadable'
      this.unreadableAtLoad = true
      this.values.clear()
      this.log(`secret store: stored secrets unreadable (${(err as Error).name})`)
      return
    }
    // The file was read; a failed optional re-encryption keeps what was read.
    if (reEncrypt) {
      try {
        await this.enqueue(() => {})
      } catch (err) {
        this.log(`secret store: re-encryption failed, keeping read values (${(err as Error).name})`)
      }
    }
  }

  private async writeFile(snapshot: FileShape): Promise<void> {
    const cipher = await this.box().encryptStringAsync(JSON.stringify(snapshot))
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, cipher, { mode: 0o600 })
      try {
        chmodSync(tmp, 0o600)
      } catch {
        // chmod is a no-op / unsupported on Windows — the file still isn't shared.
      }
      renameSync(tmp, this.file)
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* best effort */
      }
      this.log(`secret store: write failed (${(err as Error).name})`)
      throw err
    }
  }
}
