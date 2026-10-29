import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { StoredTokens } from '../shared/graphAuth'
import {
  TOKEN_FILENAME,
  TokenStoreError,
  clearTokens,
  hasStoredTokens,
  isStorageAvailable,
  loadTokens,
  saveTokens,
  tokenDirForDbPath,
  type AsyncSecretBox
} from './graphTokenStore'

/**
 * A stand-in for `safeStorage`. The "encryption" is a reversible scramble — the
 * point is not to test crypto (that is the OS's job) but to prove that what
 * lands on disk is not the plaintext, and that an unreadable file is handled
 * rather than thrown.
 */
function fakeBox(available = true): AsyncSecretBox & { calls: { encrypt: number } } {
  const calls = { encrypt: 0 }
  return {
    calls,
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (plain: string) => {
      calls.encrypt++
      return Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8')
    },
    decryptStringAsync: async (cipher: Buffer) => {
      const s = cipher.toString('utf8')
      if (!s.startsWith('enc:')) throw new Error('bad ciphertext')
      return { result: Buffer.from(s.slice(4), 'base64').toString('utf8'), shouldReEncrypt: false }
    }
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-graph-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const TOKENS: StoredTokens = {
  accessToken: 'access-secret-1',
  refreshToken: 'refresh-secret-1',
  expiresAtMs: 1_800_000_000_000,
  grantedScopes: ['Calendars.Read', 'offline_access'],
  account: { username: 'r@wald-it.com', displayName: 'Robin', tenantId: 'tid-1' }
}

function filePath(): string {
  return join(dir, TOKEN_FILENAME)
}

describe('async key rotation', () => {
  function rotatingBox(shouldReEncrypt = true): AsyncSecretBox {
    return {
      ...fakeBox(),
      decryptStringAsync: async () => ({ result: JSON.stringify(TOKENS), shouldReEncrypt })
    }
  }

  it('re-encrypts the decrypted result when the key has rotated', async () => {
    writeFileSync(filePath(), 'old encrypted blob')
    const box = rotatingBox()
    expect(await loadTokens({ dir, secretBox: box })).toEqual(TOKENS)
    expect(readFileSync(filePath())).toEqual(await box.encryptStringAsync(JSON.stringify(TOKENS)))
    expect(existsSync(`${filePath()}.tmp`)).toBe(false)
  })

  it('does not rewrite a blob when re-encryption is not requested', async () => {
    writeFileSync(filePath(), 'old encrypted blob')
    expect(await loadTokens({ dir, secretBox: rotatingBox(false) })).toEqual(TOKENS)
    expect(readFileSync(filePath(), 'utf8')).toBe('old encrypted blob')
  })

  it.each(['encrypt', 'write'] as const)(
    'keeps the token and original file if re-encryption fails at %s',
    async (stage) => {
      writeFileSync(filePath(), 'old encrypted blob')
      const box = rotatingBox()
      if (stage === 'encrypt') {
        box.encryptStringAsync = async () => {
          throw new Error(TOKENS.refreshToken)
        }
      } else {
        mkdirSync(`${filePath()}.tmp`)
      }
      const lines: string[] = []
      expect(await loadTokens({ dir, secretBox: box, log: (line) => lines.push(line) })).toEqual(
        TOKENS
      )
      expect(readFileSync(filePath(), 'utf8')).toBe('old encrypted blob')
      expect(lines.join('\n')).toContain('re-encryption failed')
      expect(lines.join('\n')).not.toContain(TOKENS.refreshToken)
    }
  )

  it.each(['disconnect', 'replace'] as const)(
    'does not undo %s while re-encrypting',
    async (change) => {
      writeFileSync(filePath(), 'old encrypted blob')
      const box = rotatingBox()
      box.encryptStringAsync = async () => {
        if (change === 'disconnect') clearTokens({ dir, secretBox: box })
        else writeFileSync(filePath(), 'new encrypted blob')
        return Buffer.from('rotated encrypted blob')
      }
      expect(await loadTokens({ dir, secretBox: box })).toEqual(TOKENS)
      if (change === 'disconnect') expect(existsSync(filePath())).toBe(false)
      else expect(readFileSync(filePath(), 'utf8')).toBe('new encrypted blob')
    }
  )
})

describe('saveTokens / loadTokens', () => {
  it('round-trips the full token object', async () => {
    const box = fakeBox()
    await saveTokens(TOKENS, { dir, secretBox: box })
    expect(await loadTokens({ dir, secretBox: box })).toEqual(TOKENS)
  })

  it('writes ciphertext — the refresh token must not be readable on disk', async () => {
    const box = fakeBox()
    await saveTokens(TOKENS, { dir, secretBox: box })
    const raw = readFileSync(filePath(), 'utf8')
    expect(raw).not.toContain('refresh-secret-1')
    expect(raw).not.toContain('access-secret-1')
    expect(box.calls.encrypt).toBe(1)
  })

  it('stores nothing in the database directory beyond its own file', async () => {
    await saveTokens(TOKENS, { dir, secretBox: fakeBox() })
    // Only the token file; in particular no leftover .tmp from the atomic write.
    expect(existsSync(`${filePath()}.tmp`)).toBe(false)
  })

  it('replaces a previous connection instead of appending', async () => {
    const box = fakeBox()
    await saveTokens(TOKENS, { dir, secretBox: box })
    await saveTokens({ ...TOKENS, refreshToken: 'refresh-secret-2' }, { dir, secretBox: box })
    expect((await loadTokens({ dir, secretBox: box }))?.refreshToken).toBe('refresh-secret-2')
  })

  it('refuses to store anything when the OS keychain is unavailable', async () => {
    // The alternative would be writing a refresh token to disk in the clear.
    const box = fakeBox(false)
    const err = await (async () => {
      try {
        await saveTokens(TOKENS, { dir, secretBox: box })
        return null
      } catch (e) {
        return e as TokenStoreError
      }
    })()
    expect(err).toBeInstanceOf(TokenStoreError)
    expect(err?.code).toBe('encryption_unavailable')
    expect(existsSync(filePath())).toBe(false)
    expect(box.calls.encrypt).toBe(0)
  })

  it('never puts token material into the log', async () => {
    const lines: string[] = []
    await saveTokens(TOKENS, { dir, secretBox: fakeBox(), log: (m) => lines.push(m) })
    await loadTokens({ dir, secretBox: fakeBox(), log: (m) => lines.push(m) })
    const all = lines.join('\n')
    expect(all).not.toContain('refresh-secret-1')
    expect(all).not.toContain('access-secret-1')
  })
})

describe('loadTokens — the ways a stored connection goes bad', () => {
  it('returns null when nothing was ever stored', async () => {
    expect(await loadTokens({ dir, secretBox: fakeBox() })).toBeNull()
  })

  it('returns null instead of throwing when the blob cannot be decrypted', async () => {
    // The realistic case: the file came from another machine, or the OS key
    // changed. Throwing here would crash the app on startup.
    writeFileSync(filePath(), Buffer.from('not-encrypted-by-us', 'utf8'))
    const lines: string[] = []
    expect(await loadTokens({ dir, secretBox: fakeBox(), log: (m) => lines.push(m) })).toBeNull()
    expect(lines.join('\n')).toMatch(/unreadable/)
  })

  it('returns null when the decrypted content is not JSON', async () => {
    const box = fakeBox()
    writeFileSync(filePath(), await box.encryptStringAsync('this is not json'))
    expect(await loadTokens({ dir, secretBox: box })).toBeNull()
  })

  it.each([
    ['missing refreshToken', { accessToken: 'a', expiresAtMs: 1 }],
    ['empty refreshToken', { accessToken: 'a', refreshToken: '', expiresAtMs: 1 }],
    ['missing accessToken', { refreshToken: 'r', expiresAtMs: 1 }],
    ['expiresAtMs as a string', { accessToken: 'a', refreshToken: 'r', expiresAtMs: '1' }],
    ['not an object', 'nope'],
    ['null', null]
  ])('returns null for a malformed blob (%s)', async (_label, payload) => {
    const box = fakeBox()
    writeFileSync(filePath(), await box.encryptStringAsync(JSON.stringify(payload)))
    expect(await loadTokens({ dir, secretBox: box })).toBeNull()
  })

  it('does not delete the file it could not read', async () => {
    // Silent deletion of something we merely failed to understand would be rude
    // and unrecoverable; the next successful connect overwrites it anyway.
    writeFileSync(filePath(), Buffer.from('garbage', 'utf8'))
    await loadTokens({ dir, secretBox: fakeBox() })
    expect(existsSync(filePath())).toBe(true)
  })
})

describe('hasStoredTokens', () => {
  it('is false before anything is stored and true afterwards', async () => {
    const box = fakeBox()
    expect(await hasStoredTokens({ dir, secretBox: box })).toBe(false)
    await saveTokens(TOKENS, { dir, secretBox: box })
    expect(await hasStoredTokens({ dir, secretBox: box })).toBe(true)
  })

  it('is false for a stored-but-unusable blob, not merely for a missing file', async () => {
    writeFileSync(filePath(), Buffer.from('garbage', 'utf8'))
    expect(await hasStoredTokens({ dir, secretBox: fakeBox() })).toBe(false)
  })
})

describe('clearTokens', () => {
  it('removes the stored connection', async () => {
    const box = fakeBox()
    await saveTokens(TOKENS, { dir, secretBox: box })
    clearTokens({ dir, secretBox: box })
    expect(existsSync(filePath())).toBe(false)
    expect(await loadTokens({ dir, secretBox: box })).toBeNull()
  })

  it('is idempotent — disconnecting when nothing is connected must not throw', () => {
    expect(() => {
      clearTokens({ dir, secretBox: fakeBox() })
      clearTokens({ dir, secretBox: fakeBox() })
    }).not.toThrow()
  })
})

describe('tokenDirForDbPath — where the file belongs when no dir is injected', () => {
  /**
   * Regression guard for a bug found in the first real handtest (#130).
   *
   * The default location used to come from `mcp/socketPath.ts`'s `userDataDir()`,
   * which RECONSTRUCTS `%APPDATA%\time-tracking` without Electron so the
   * standalone MCP server can find the DB. That resolver cannot know about an
   * overridden userData location, while `main/db.ts` uses
   * `app.getPath('userData')`, which does. Running the app with
   * `--user-data-dir` therefore wrote the token next to a database the app was
   * not using — in the production directory, during a supposedly isolated test.
   *
   * Every other test in this file injects `dir`, so none of them could see it.
   * This one pins the rule itself: the token sits beside the DB that is open.
   */
  it('puts the token next to the database the app actually opened', () => {
    expect(tokenDirForDbPath(join('X', 'custom-profile', 'timetrack.sqlite'))).toBe(
      join('X', 'custom-profile')
    )
  })

  it('follows an overridden location instead of a reconstructed default', () => {
    const overridden = tokenDirForDbPath(join('D:', 'portable', 'tt', 'timetrack.sqlite'))
    expect(overridden).toBe(join('D:', 'portable', 'tt'))
    expect(overridden).not.toContain('AppData')
  })
})

describe('isStorageAvailable', () => {
  it('mirrors the keychain state', async () => {
    expect(await isStorageAvailable({ dir, secretBox: fakeBox(true) })).toBe(true)
    expect(await isStorageAvailable({ dir, secretBox: fakeBox(false) })).toBe(false)
  })

  it('reports false rather than throwing when safeStorage itself blows up', async () => {
    const hostile: AsyncSecretBox = {
      isAsyncEncryptionAvailable: async () => {
        throw new Error('no keyring')
      },
      encryptStringAsync: async () => Buffer.alloc(0),
      decryptStringAsync: async () => ({ result: '', shouldReEncrypt: false })
    }
    expect(await isStorageAvailable({ dir, secretBox: hostile })).toBe(false)
  })
})
