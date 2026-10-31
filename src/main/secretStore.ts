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
    return this.persist()
  }

  /** Remove every key not in `keep` that starts with `prefix`. */
  prune(prefix: string, keep: ReadonlySet<string>): Promise<void> {
    if (this.currentMode === 'plain') return Promise.resolve()
    let changed = false
    for (const key of [...this.values.keys()]) {
      if (key.startsWith(prefix) && !keep.has(key)) {
        this.values.delete(key)
        changed = true
      }
    }
    return changed ? this.persist() : this.writes
  }

  /** The box in use, so a read-back check can open the file the same way. */
  boxForCheck(): AsyncSecretBox {
    return this.box()
  }

  /** Settles when every write issued so far has reached the file. */
  flush(): Promise<void> {
    return this.writes
  }

  private persist(): Promise<void> {
    const snapshot: FileShape = { v: 1, values: Object.fromEntries(this.values) }
    const run = this.writes.then(() => this.writeFile(snapshot))
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
      if (shouldReEncrypt) await this.persist()
    } catch (err) {
      // No token material in the message.
      this.currentMode = 'unreadable'
      this.values.clear()
      this.log(`secret store: stored secrets unreadable (${(err as Error).name})`)
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
