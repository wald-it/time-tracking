import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { LogoError, saveLogo, removeLogo, readLogoAsDataUrl, MAX_LOGO_BYTES } from './logo'
import { dialogT } from './mainI18n'

describe('logo storage', () => {
  let tmpDir: string
  let userDataDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-logo-'))
    userDataDir = join(tmpDir, 'userData')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeFixture(name: string, bytes: Buffer | string): string {
    const p = join(tmpDir, name)
    writeFileSync(p, bytes)
    return p
  }

  /** The LogoError saveLogo throws, worded as the IPC handler does (#296). */
  function refusal(src: string, locale: 'de' | 'en'): string {
    try {
      saveLogo(src, userDataDir)
    } catch (e) {
      if (e instanceof LogoError) return dialogT(locale)(e.key, e.vars)
      throw e
    }
    throw new Error('saveLogo accepted the file')
  }

  it('rejects unsupported extensions', () => {
    const src = writeFixture('logo.gif', Buffer.from([0x47, 0x49, 0x46]))
    expect(() => saveLogo(src, userDataDir)).toThrow(LogoError)
    expect(refusal(src, 'de')).toBe('Logo-Format nicht unterstützt: .gif')
    expect(refusal(src, 'en')).toBe('Logo format not supported: .gif')
    expect(refusal(writeFixture('logo', 'x'), 'de')).toBe(
      'Logo-Format nicht unterstützt: (unbekannt)'
    )
  })

  it('rejects files larger than 1 MB', () => {
    const big = Buffer.alloc(MAX_LOGO_BYTES + 1, 0xff)
    const src = writeFixture('big.png', big)
    expect(refusal(src, 'de')).toBe('Logo überschreitet 1 MB (1024 KB)')
    expect(refusal(src, 'en')).toBe('The logo is larger than 1 MB (1024 KB)')
  })

  it('saves a PNG logo into userData and returns the new path', () => {
    const src = writeFixture('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const target = saveLogo(src, userDataDir)
    expect(target).toBe(join(userDataDir, 'pdf-logo.png'))
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it('replaces an existing logo even with a different extension', () => {
    saveLogo(writeFixture('a.png', Buffer.from([1, 2, 3])), userDataDir)
    expect(existsSync(join(userDataDir, 'pdf-logo.png'))).toBe(true)
    saveLogo(writeFixture('b.jpg', Buffer.from([4, 5, 6])), userDataDir)
    expect(existsSync(join(userDataDir, 'pdf-logo.png'))).toBe(false)
    expect(existsSync(join(userDataDir, 'pdf-logo.jpg'))).toBe(true)
  })

  it('removeLogo is idempotent and survives a missing directory', () => {
    expect(() => removeLogo(userDataDir)).not.toThrow()
    saveLogo(writeFixture('a.png', Buffer.from([1])), userDataDir)
    removeLogo(userDataDir)
    expect(existsSync(join(userDataDir, 'pdf-logo.png'))).toBe(false)
  })

  it('readLogoAsDataUrl returns empty for missing/empty paths', () => {
    expect(readLogoAsDataUrl('')).toBe('')
    expect(readLogoAsDataUrl(join(tmpDir, 'does-not-exist.png'))).toBe('')
  })

  it('readLogoAsDataUrl base64-encodes a stored PNG', () => {
    const target = saveLogo(writeFixture('logo.png', Buffer.from([1, 2, 3, 4])), userDataDir)
    const url = readLogoAsDataUrl(target)
    expect(url).toBe('data:image/png;base64,AQIDBA==')
  })

  it('readLogoAsDataUrl uses the right MIME type for SVG', () => {
    const target = saveLogo(writeFixture('logo.svg', '<svg/>'), userDataDir)
    expect(readLogoAsDataUrl(target).startsWith('data:image/svg+xml;base64,')).toBe(true)
  })
})
