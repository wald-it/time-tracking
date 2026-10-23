import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  assertSmokeUserDataIsolated,
  buildCleanerCommand,
  createSmokeUserDataDir,
  isRemovableSmokeDir,
  isSameOrInside,
  parseSmokeOutPath,
  removeSmokeUserDataDir,
  setupSmokeUserData,
  SMOKE_DIR_PREFIX
} from './smokeUserData'

let root: string

/**
 * The cleaner's outcome line. Deliberately not its `exit` event: under load,
 * Windows can take 20 s and more to finish tearing down an exited
 * electron.exe, and the `exit` event waits for that (#264).
 */
function cleanerOutcome(cleaner: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    cleaner.stdout!.on('data', (chunk) => {
      out += chunk
      if (!out.includes('\n')) return
      resolve(out.split('\n')[0].trim())
      // Let the test end without waiting for the teardown either.
      cleaner.stdout!.destroy()
      cleaner.stderr!.destroy()
      cleaner.unref()
    })
    cleaner.stderr!.on('data', (chunk) => (err += chunk))
    cleaner.once('error', reject)
    // Printed nothing (a broken script): report it with its stderr. `close`,
    // not `exit`, so that output still in the pipe is read first. This path
    // does wait for the teardown, so under load it may still hit the timeout.
    cleaner.once('close', (code) =>
      resolve(out.trim() || `exit ${code} without outcome: ${err.trim()}`)
    )
  })
}

/**
 * Whether `child` still runs, by the cleaner's own check. Asked only while
 * Node has not seen its exit: until then Node holds the process handle, so
 * Windows cannot hand the PID to another process.
 */
function isRunning(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return false
  try {
    process.kill(child.pid!, 0)
    return true
  } catch {
    return false
  }
}

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

  it('compares case-insensitively on Windows and macOS', () => {
    const live = join(root, 'time-tracking')
    expect(isSameOrInside(live.toUpperCase(), live, 'win32')).toBe(true)
    expect(isSameOrInside(live.toUpperCase(), live, 'darwin')).toBe(true)
    // Linux semantics: case matters — except that Node's win32 path module
    // compares case-insensitively itself, so on a Windows host it still matches.
    // (No `it.runIf`: a skipped test would break the "0 skipped" rule.)
    expect(isSameOrInside(live.toUpperCase(), live, 'linux')).toBe(process.platform === 'win32')
  })

  it('refuses a userData that reaches the default one through a link', () => {
    const live = join(root, 'time-tracking')
    mkdirSync(live)
    const link = join(root, 'innocent-looking')
    // 'junction' needs no admin rights on Windows; ignored on POSIX.
    symlinkSync(live, link, 'junction')
    expect(isSameOrInside(link, live)).toBe(true)
    expect(() => assertSmokeUserDataIsolated(link, [live])).toThrow(/refused/)
  })

  it('refuses to run when the default locations are unknown', () => {
    expect(() => assertSmokeUserDataIsolated(createSmokeUserDataDir(root), [])).toThrow(/unknown/)
  })

  it('only removes SMOKE_DIR_PREFIX directories inside the temp root', () => {
    const smoke = createSmokeUserDataDir(root)
    const other = join(root, 'time-tracking')
    mkdirSync(other)
    expect(isRemovableSmokeDir(smoke, root)).toBe(true)
    expect(isRemovableSmokeDir(other, root)).toBe(false)
    expect(isRemovableSmokeDir(root, root)).toBe(false)
    const outside = mkdtempSync(join(tmpdir(), SMOKE_DIR_PREFIX))
    try {
      expect(isRemovableSmokeDir(outside, join(root, 'elsewhere'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
    expect(removeSmokeUserDataDir(other, root)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('cleaner script ignores a directory without the smoke prefix', async () => {
    const victim = join(root, 'time-tracking')
    mkdirSync(victim)
    const { command, args, env } = buildCleanerCommand(process.execPath, victim, 999999)
    const cleaner = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    expect(await cleanerOutcome(cleaner)).toBe('skipped')
    expect(existsSync(victim)).toBe(true)
  }, 15_000)

  it('cleaner script removes a directory named by SMOKE_DIR_PREFIX (#289)', async () => {
    // The app names its smoke dirs with SMOKE_DIR_PREFIX; a cleaner whose own
    // prefix check differs would answer 'skipped' here and leave them behind.
    const dir = join(root, `${SMOKE_DIR_PREFIX}drift`)
    mkdirSync(dir)
    const { command, args, env } = buildCleanerCommand(process.execPath, dir, 999999)
    const cleaner = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    expect(await cleanerOutcome(cleaner)).toBe('removed')
    expect(existsSync(dir)).toBe(false)
  }, 15_000)

  it('setup moves userData to a fresh temp dir and remembers both defaults', () => {
    const paths: Record<string, string> = {
      userData: join(root, 'AppData', 'time-tracking'),
      appData: join(root, 'AppData')
    }
    const setup = setupSmokeUserData({
      getPath: (n) => paths[n],
      getName: () => 'time-tracking',
      setPath: (n, v) => {
        paths[n] = v
      },
      createDir: () => createSmokeUserDataDir(root)
    })
    expect(setup.ok).toBe(true)
    if (!setup.ok) return
    expect(paths.userData).toBe(setup.userData)
    expect(setup.protectedDirs).toEqual([
      join(root, 'AppData', 'time-tracking'),
      join(root, 'AppData', 'time-tracking')
    ])
  })

  it('setup reports failure instead of throwing, and leaves no temp dir', () => {
    let created = ''
    const setup = setupSmokeUserData({
      getPath: () => join(root, 'AppData'),
      getName: () => 'time-tracking',
      setPath: () => {
        throw new Error('setPath exploded')
      },
      createDir: () => (created = createSmokeUserDataDir(root))
    })
    expect(setup).toEqual({ ok: false, error: expect.stringMatching(/setPath exploded/) })
    // Removal is restricted to the OS temp dir, and `root` lies inside it.
    expect(existsSync(created)).toBe(false)
  })

  it('setup reports a failing mkdtemp as ok:false', () => {
    const setup = setupSmokeUserData({
      getPath: () => join(root, 'AppData'),
      getName: () => 'time-tracking',
      setPath: () => {},
      createDir: () => createSmokeUserDataDir(join(root, 'missing', 'deeper'))
    })
    expect(setup.ok).toBe(false)
  })

  it('parses the output path from the smoke argument', () => {
    expect(parseSmokeOutPath('--smoke-test=C:\\a=b\\out.json')).toBe('C:\\a=b\\out.json')
    expect(parseSmokeOutPath('--smoke-test')).toBe('')
  })

  it('cleaner waits for the given process to exit, then removes the directory', async () => {
    const dir = createSmokeUserDataDir(root)
    writeFileSync(join(dir, 'timetrack.sqlite'), 'x')
    // Stand-in for the smoke process: lives ~1.5 s and leaves a marker (outside
    // `dir`) as its last act — evidence of its end that owes nothing to the
    // liveness check the cleaner itself relies on.
    const marker = join(root, 'holder-done')
    const holder = spawn(
      process.execPath,
      ['-e', "setTimeout(() => require('fs').writeFileSync(process.env.TT_TEST_MARKER, ''), 1500)"],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TT_TEST_MARKER: marker },
        stdio: 'ignore'
      }
    )
    holder.unref()
    const { command, args, env } = buildCleanerCommand(process.execPath, dir, holder.pid!)
    const cleaner = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const outcome = cleanerOutcome(cleaner)

    await new Promise((r) => setTimeout(r, 400))
    expect(existsSync(dir)).toBe(true) // holder still alive → nothing removed yet

    expect(await outcome).toBe('removed')
    expect(existsSync(dir)).toBe(false)
    // Catches a cleaner that does not wait even when it starts after the 400 ms
    // check. Only while this test reads the outcome before the holder's end:
    // a test starved past 1.5 s would find the marker either way.
    expect(existsSync(marker)).toBe(true)
    expect(isRunning(holder)).toBe(false)
  }, 15_000)

  it('removes the temp directory with its contents', () => {
    const dir = createSmokeUserDataDir(root)
    writeFileSync(join(dir, 'timetrack.sqlite'), 'x')
    expect(removeSmokeUserDataDir(dir)).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })
})
