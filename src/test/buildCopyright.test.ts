/**
 * The app's copyright (electron-builder `copyright`: the exe's LegalCopyright
 * on Windows, NSHumanReadableCopyright on macOS) names the holder from LICENSE
 * (owner decision 2026-10-23). The About dialog reads LICENSE itself (#276);
 * the build config holds a copy of the line, so this pins the copy. Without
 * the key electron-builder falls back to the package author, the publisher,
 * and nothing else would notice.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '..', '..')

describe('build copyright', () => {
  it('electron-builder.yml carries the copyright line of LICENSE', () => {
    const license = readFileSync(resolve(REPO_ROOT, 'LICENSE'), 'utf8')
    const holderLine = /^Copyright \(c\) .+$/m.exec(license)
    expect(holderLine).not.toBeNull()

    const yml = readFileSync(resolve(REPO_ROOT, 'electron-builder.yml'), 'utf8')
    const key = /^copyright:\s*(.+?)\s*$/m.exec(yml)
    expect(key, 'electron-builder.yml has no copyright key').not.toBeNull()
    expect(key![1]).toBe(holderLine![0])
  })
})
