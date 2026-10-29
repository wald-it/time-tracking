/**
 * At-rest storage for the Microsoft Graph tokens (#130).
 *
 * A refresh token is a bearer credential for someone's mailbox and calendar in
 * a foreign tenant. That is a different class of secret from what this repo
 * stored before — the webhook secrets sit in the `settings` table in plain text
 * (`webhooks.ts`), and the MCP write token is a locally generated value that is
 * worthless elsewhere. So this one is encrypted with Electron's `safeStorage`
 * (DPAPI on Windows, Keychain on macOS, libsecret on Linux) and kept in its own
 * file rather than in the database.
 *
 * **Why not the `settings` table.** Backups copy the `.sqlite` file
 * (`backup.ts`), so a token in there would travel into every backup and, on
 * restore, onto other machines — where `safeStorage` cannot decrypt it anyway
 * (DPAPI is user- and machine-bound). Keeping it beside the DB means a restore
 * simply does not touch the connection, which is the honest behaviour: the
 * connection belongs to this machine, not to the data.
 *
 * **No plaintext fallback.** If `safeStorage` reports that encryption is not
 * available — the realistic case is a Linux session with no keyring — saving
 * fails with an explanation instead of silently writing the refresh token to
 * disk in the clear. A feature that quietly downgrades its own protection is
 * worse than one that says it cannot run here.
 */
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { StoredTokens } from '../shared/graphAuth'

export const TOKEN_FILENAME = 'graph-account.enc'

/** The slice of Electron's `safeStorage` this module needs. Injectable for tests. */
export interface AsyncSecretBox {
  isAsyncEncryptionAvailable: () => Promise<boolean>
  encryptStringAsync: (plain: string) => Promise<Buffer>
  decryptStringAsync: (cipher: Buffer) => Promise<{ shouldReEncrypt: boolean; result: string }>
}

export interface TokenStoreDeps {
  /**
   * Directory to keep the file in — **required, deliberately with no default**.
   *
   * There used to be one, and it caused two bugs in a row. First it came from
   * `mcp/socketPath.ts`'s `userDataDir()`, which reconstructs `%APPDATA%` for
   * the Electron-free MCP server and therefore cannot see an overridden
   * userData location: the token landed next to a database the app was not
   * using. The obvious repair — lazily `require('./db')` — was worse, because
   * electron-vite bundles main into a single file where `require('./db')` has
   * nothing to resolve at runtime; the whole feature reported "keychain
   * unavailable" in every build.
   *
   * Neither was visible to the unit tests, which always inject `dir`. So the
   * default is gone and the caller has to say where it goes; `graphHandlers.ts`
   * takes it from the database the app actually opened.
   */
  dir: string
  secretBox?: AsyncSecretBox
  log?: (message: string) => void
}

export class TokenStoreError extends Error {
  constructor(
    message: string,
    readonly code: 'encryption_unavailable' | 'write_failed'
  ) {
    super(message)
    this.name = 'TokenStoreError'
  }
}

/**
 * Electron's real `safeStorage`, resolved lazily.
 *
 * Imported through a function rather than at module load so the module can be
 * unit-tested under `ELECTRON_RUN_AS_NODE`, where `require('electron')` yields
 * a path string instead of the API.
 */
async function electronSecretBox(): Promise<AsyncSecretBox> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- #130: lazy, see above
  const { app, safeStorage } = require('electron') as typeof import('electron')
  // The asynchronous encryptor is initialized lazily the first time
  // isAsyncEncryptionAvailable, encryptStringAsync or decryptStringAsync is
  // called after the app is ready. Its promise resolves after initialization.
  // Keep this boundary here so even a new caller cannot initialize it early.
  await app.whenReady()
  return safeStorage
}

/**
 * Where the token belongs, given the path of the database the app opened.
 *
 * Same anchor as `mcpBridge.ts` (`dirname(getDbPath())`), and the reason it is
 * a named function is so the rule can be tested without an Electron app.
 */
export function tokenDirForDbPath(dbPath: string): string {
  return dirname(dbPath)
}

function resolve(deps: TokenStoreDeps): {
  file: string
  log: (m: string) => void
} {
  return {
    file: join(deps.dir, TOKEN_FILENAME),
    log: deps.log ?? ((): void => {})
  }
}

/** Whether tokens can be stored at all on this machine. */
export async function isStorageAvailable(deps: TokenStoreDeps): Promise<boolean> {
  try {
    const box = deps.secretBox ?? (await electronSecretBox())
    return await box.isAsyncEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * Persist tokens, replacing anything already stored.
 *
 * Written to a temporary file and renamed into place: a crash midway must not
 * leave a half-written blob that decrypts to garbage and silently drops the
 * connection.
 */
export async function saveTokens(tokens: StoredTokens, deps: TokenStoreDeps): Promise<void> {
  const write = await prepareTokenWrite(tokens, deps)
  write()
}

/**
 * Encrypt first, then return a synchronous atomic write. The account can check
 * its connection generation after encryption and write + bump it without an
 * await between them (#348). Failed encryption never changes the stored file.
 */
export async function prepareTokenWrite(
  tokens: StoredTokens,
  deps: TokenStoreDeps
): Promise<() => void> {
  const { file, log } = resolve(deps)
  const box = deps.secretBox ?? (await electronSecretBox())
  if (!(await box.isAsyncEncryptionAvailable())) {
    throw new TokenStoreError(
      'Die sichere Ablage des Systems ist nicht verfügbar, deshalb wird die Verbindung nicht ' +
        'gespeichert. Unter Linux fehlt dafür meist ein Schlüsselbund (z. B. gnome-keyring).',
      'encryption_unavailable'
    )
  }
  const cipher = await box.encryptStringAsync(JSON.stringify(tokens))
  return () => {
    writeCipher(file, cipher)
    log('graph token store: tokens saved')
  }
}

function writeCipher(file: string, cipher: Buffer): void {
  const tmp = `${file}.tmp`
  try {
    writeFileSync(tmp, cipher, { mode: 0o600 })
    try {
      chmodSync(tmp, 0o600)
    } catch {
      // chmod is a no-op / unsupported on Windows — the file still isn't shared.
    }
    renameSync(tmp, file)
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* best effort */
    }
    throw new TokenStoreError(
      `Die Verbindung konnte nicht gespeichert werden: ${(err as Error).message}`,
      'write_failed'
    )
  }
}

/** Shape check — a decrypted blob from an older or corrupted file may be anything. */
function isStoredTokens(v: unknown): v is StoredTokens {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.accessToken === 'string' &&
    o.accessToken.length > 0 &&
    typeof o.refreshToken === 'string' &&
    o.refreshToken.length > 0 &&
    typeof o.expiresAtMs === 'number' &&
    Number.isFinite(o.expiresAtMs)
  )
}

/**
 * Read the stored tokens, or `null` when there is no usable connection.
 *
 * Never throws for a missing, unreadable, undecryptable or malformed file. All
 * of those mean the same thing to the rest of the app — "not connected" — and
 * the recovery is identical: the user connects again, which overwrites the
 * file. Throwing here would turn a restored backup on a new machine into a
 * crash on startup.
 */
export async function loadTokens(deps: TokenStoreDeps): Promise<StoredTokens | null> {
  const { file, log } = resolve(deps)
  if (!existsSync(file)) return null
  let parsed: unknown
  let box: AsyncSecretBox
  let cipher: Buffer
  let decrypted: { result: string; shouldReEncrypt: boolean }
  try {
    box = deps.secretBox ?? (await electronSecretBox())
    cipher = readFileSync(file)
    decrypted = await box.decryptStringAsync(cipher)
    parsed = JSON.parse(decrypted.result)
  } catch (err) {
    // Typically: the file was copied from another machine, or the OS key
    // changed. Deliberately no token material in the message.
    log(`graph token store: stored connection unreadable (${(err as Error).name})`)
    return null
  }
  if (!isStoredTokens(parsed)) {
    log('graph token store: stored connection has an unexpected shape, ignoring')
    return null
  }
  // result is the decrypted string; shouldReEncrypt means the key has rotated
  // or a new key offers a different security level. Encrypt that same string
  // again, best effort: a failed upgrade must not discard a usable connection.
  if (decrypted.shouldReEncrypt) {
    try {
      const updated = await box.encryptStringAsync(decrypted.result)
      // Encryption yields: do not overwrite a newer connection or undo a
      // disconnect that happened while the OS keychain was working.
      if (existsSync(file) && readFileSync(file).equals(cipher)) writeCipher(file, updated)
    } catch {
      log('graph token store: re-encryption failed, keeping the stored connection')
    }
  }
  return parsed
}

/** True when a connection is stored and usable. */
export async function hasStoredTokens(deps: TokenStoreDeps): Promise<boolean> {
  return (await loadTokens(deps)) !== null
}

/** Remove the stored connection. Idempotent — "disconnect" when nothing is stored is fine. */
export function clearTokens(deps: TokenStoreDeps): void {
  const { file, log } = resolve(deps)
  try {
    if (existsSync(file)) {
      unlinkSync(file)
      log('graph token store: tokens cleared')
    }
  } catch (err) {
    log(`graph token store: could not remove the stored connection (${(err as Error).message})`)
  }
}
