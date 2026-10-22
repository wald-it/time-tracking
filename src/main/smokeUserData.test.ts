import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  assertSmokeUserDataIsolated,
  buildCleanerCommand,
  createSmokeUserDataDir,
  isSameOrInside,
  removeSmokeUserDataDir
} from './smokeUserData'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tt-smoke-ud-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('smoke userData isolation', () => {
  it('creates a fresh, distinct directory under the given root', () => {
    const a = createSmokeUserDataDir(root)
    const b = createSmokeUserDataDir(root)
    expect(a).not.toBe(b)
    expect(isSameOrInside(a, root)).toBe(true)
    expect(existsSync(a)).toBe(true)
  })

  it('refuses the default userData itself', () => {
    const live = join(root, 'time-tracking')
    expect(() => assertSmokeUserDataIsolated(live, [live])).toThrow(/refused/)
  })

  it('refuses a path that only differs by a trailing separator or dot segment', () => {
    const live = join(root, 'time-tracking')
    expect(() => assertSmokeUserDataIsolated(live + '/', [live])).toThrow(/refused/)
    expect(() => assertSmokeUserDataIsolated(join(live, 'x', '..'), [live])).toThrow(/refused/)
  })

  it('refuses a directory inside the default userData', () => {
    const live = join(root, 'time-tracking')
    expect(() => assertSmokeUserDataIsolated(join(live, 'nested'), [live])).toThrow(/refused/)
  })

  it('checks every protected directory, not just the first', () => {
    const live = join(root, 'time-tracking')
    expect(() => assertSmokeUserDataIsolated(live, [join(root, 'other'), live])).toThrow(/refused/)
  })

  it('accepts a temp directory outside the default userData', () => {
    const live = join(root, 'time-tracking')
    const tmp = createSmokeUserDataDir(root)
    expect(() => assertSmokeUserDataIsolated(tmp, [live])).not.toThrow()
  })

  it('does not treat a sibling sharing the name prefix as inside', () => {
    const live = join(root, 'time-tracking')
    expect(isSameOrInside(join(root, 'time-tracking-smoke'), live)).toBe(false)
  })

  // Not `it.runIf`: a skipped test would break the "0 skipped" rule on macOS CI.
  it('follows the platform path semantics for case (insensitive on Windows)', () => {
    const live = join(root, 'time-tracking')
    expect(isSameOrInside(live.toUpperCase(), live)).toBe(process.platform === 'win32')
  })

  it('cleaner waits for the given process to exit, then removes the directory', async () => {
    const dir = createSmokeUserDataDir(root)
    writeFileSync(join(dir, 'timetrack.sqlite'), 'x')
    // Stand-in for the smoke process: lives ~1.5 s.
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore'
    })
    const holderExited = new Promise((r) => holder.once('exit', r))
    const { command, args, env } = buildCleanerCommand(process.execPath, dir, holder.pid!)
    const cleaner = spawn(command, args, { env: { ...process.env, ...env }, stdio: 'ignore' })
    const cleanerExited = new Promise((r) => cleaner.once('exit', r))

    await new Promise((r) => setTimeout(r, 400))
    expect(existsSync(dir)).toBe(true) // holder still alive → nothing removed yet

    await holderExited
    await cleanerExited
    expect(existsSync(dir)).toBe(false)
  }, 15_000)

  it('removes the temp directory with its contents', () => {
    const dir = createSmokeUserDataDir(root)
    writeFileSync(join(dir, 'timetrack.sqlite'), 'x')
    expect(removeSmokeUserDataDir(dir)).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })
})
