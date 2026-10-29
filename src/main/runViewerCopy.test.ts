import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pruneViewerCopiesAtStart, VIEWER_COPY_DIR } from './runViewerCopy'

describe('pruneViewerCopiesAtStart', () => {
  let tempRoot: string
  const now = Date.UTC(2026, 9, 29, 12)

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'run-viewer-start-'))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  function copyAt(ageMs: number): string {
    const dir = join(tempRoot, VIEWER_COPY_DIR)
    mkdirSync(dir)
    const path = join(dir, 'run-1.pdf')
    writeFileSync(path, 'PDF copy')
    const modified = new Date(now - ageMs)
    utimesSync(path, modified, modified)
    return path
  }

  it('removes a viewer copy older than one day at start', () => {
    const path = copyAt(25 * 60 * 60 * 1000)
    pruneViewerCopiesAtStart(tempRoot, now)
    expect(existsSync(path)).toBe(false)
  })

  it('keeps a fresh viewer copy at start', () => {
    const path = copyAt(60 * 60 * 1000)
    pruneViewerCopiesAtStart(tempRoot, now)
    expect(existsSync(path)).toBe(true)
  })

  it('does not throw when the viewer copy folder does not exist', () => {
    expect(existsSync(join(tempRoot, VIEWER_COPY_DIR))).toBe(false)
    expect(() => pruneViewerCopiesAtStart(tempRoot)).not.toThrow()
  })
})
