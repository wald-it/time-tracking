/**
 * Isolated userData for `--smoke-test` runs.
 *
 * The smoke check seeds and deletes rows (`clients.id = 9999`). Run against
 * the default userData it would migrate the user's live database and delete a
 * real client that happens to carry that id. Smoke mode therefore points
 * userData at a fresh temp directory before the app is ready, and refuses to
 * open a database at all if the resolved location is still a default one.
 */
import { spawn } from 'child_process'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, isAbsolute, join, relative, resolve } from 'path'

/** Prefix of every smoke userData directory; the cleaners delete nothing else. */
export const SMOKE_DIR_PREFIX = 'timetrack-smoke-'

/** Create a fresh, empty directory to serve as userData for one smoke run. */
export function createSmokeUserDataDir(root: string = tmpdir()): string {
  return mkdtempSync(join(root, SMOKE_DIR_PREFIX))
}

/**
 * Comparable form of a path: absolute, symlinks/junctions resolved where the
 * path exists (lexical otherwise), lower-cased on the case-insensitive
 * default file systems of Windows and macOS.
 */
function comparable(p: string, platform: NodeJS.Platform): string {
  let out = resolve(p)
  try {
    out = realpathSync.native(out)
  } catch {
    /* does not exist (yet) — compare lexically */
  }
  return platform === 'win32' || platform === 'darwin' ? out.toLowerCase() : out
}

/** True when `candidate` is `dir` itself or lies anywhere below it. */
export function isSameOrInside(
  candidate: string,
  dir: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const rel = relative(comparable(dir, platform), comparable(candidate, platform))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** True only for a `timetrack-smoke-*` directory strictly inside `tmpRoot`. */
export function isRemovableSmokeDir(dir: string, tmpRoot: string = tmpdir()): boolean {
  return (
    basename(resolve(dir)).startsWith(SMOKE_DIR_PREFIX) &&
    isSameOrInside(dir, tmpRoot) &&
    !isSameOrInside(tmpRoot, dir)
  )
}

export interface SmokeSetupDeps {
  getPath(name: 'userData' | 'appData'): string
  getName(): string
  setPath(name: 'userData', value: string): void
  createDir?: () => string
}

export type SmokeSetup =
  | { ok: true; userData: string; protectedDirs: string[] }
  | { ok: false; error: string }

/**
 * Remember the default userData locations, then move userData to a fresh
 * temp directory. Never throws: it runs at module load, where an exception
 * would only reach the uncaughtException logger and leave the smoke run
 * hanging until the CI timeout. The caller reports `ok: false` and exits.
 */
export function setupSmokeUserData(deps: SmokeSetupDeps): SmokeSetup {
  let created: string | undefined
  try {
    const protectedDirs = [deps.getPath('userData'), join(deps.getPath('appData'), deps.getName())]
    created = (deps.createDir ?? createSmokeUserDataDir)()
    deps.setPath('userData', created)
    return { ok: true, userData: created, protectedDirs }
  } catch (err) {
    if (created) removeSmokeUserDataDir(created)
    return { ok: false, error: `smoke userData setup failed: ${(err as Error).message}` }
  }
}

/** `--smoke-test=<path>` → `<path>`; empty when no path was given. */
export function parseSmokeOutPath(arg: string): string {
  return arg.includes('=') ? arg.split('=').slice(1).join('=') : ''
}

/**
 * Throw unless `userData` is outside every protected directory. Called
 * immediately before the smoke run opens its database, so a missed or
 * reverted `app.setPath` fails the run instead of touching live data.
 */
export function assertSmokeUserDataIsolated(userData: string, protectedDirs: string[]): void {
  if (protectedDirs.length === 0) {
    throw new Error('smoke test refused to run: default userData locations are unknown')
  }
  for (const dir of protectedDirs) {
    if (isSameOrInside(userData, dir)) {
      throw new Error(
        `smoke test refused to run: userData "${userData}" resolves to the default ` +
          `userData "${dir}", which holds the user's live database`
      )
    }
  }
}

/**
 * Best-effort removal; returns false (instead of throwing) if anything is
 * left behind or `dir` is not a smoke directory in the OS temp dir.
 */
export function removeSmokeUserDataDir(dir: string, tmpRoot: string = tmpdir()): boolean {
  if (!isRemovableSmokeDir(dir, tmpRoot)) return false
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    return true
  } catch {
    return false
  }
}

/**
 * Node program run by the detached cleaner: wait until the smoke process
 * (`TT_SMOKE_PID`) is gone, then remove `TT_SMOKE_DIR`. Gives up after 60 s
 * so a stuck parent cannot leave the cleaner running forever.
 */
const CLEANER_SCRIPT = `
const { rmSync } = require('fs')
const { basename } = require('path')
const dir = process.env.TT_SMOKE_DIR
if (!dir || !basename(dir).startsWith('timetrack-smoke-')) process.exit(0)
const pid = Number(process.env.TT_SMOKE_PID)
const deadline = Date.now() + 60000
const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
const tick = () => {
  if (alive() && Date.now() < deadline) return setTimeout(tick, 200)
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch {}
}
tick()
`

export interface CleanerCommand {
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * How to remove `dir` once process `pid` has exited. On Windows the smoke
 * process cannot delete its own userData: Chromium keeps its profile files
 * open until exit. The cleaner reuses the app binary in Node mode
 * (`ELECTRON_RUN_AS_NODE=1`, same mechanism as `mcpLaunch.ts`).
 */
export function buildCleanerCommand(execPath: string, dir: string, pid: number): CleanerCommand {
  return {
    command: execPath,
    args: ['-e', CLEANER_SCRIPT],
    env: { ELECTRON_RUN_AS_NODE: '1', TT_SMOKE_DIR: dir, TT_SMOKE_PID: String(pid) }
  }
}

/** Spawn the detached cleaner for `dir` (smoke temp dirs only); never throws. */
export function scheduleRemovalAfterExit(dir: string): boolean {
  if (!isRemovableSmokeDir(dir)) return false
  try {
    const { command, args, env } = buildCleanerCommand(process.execPath, dir, process.pid)
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ...env }
    })
    child.unref()
    return true
  } catch {
    return false
  }
}
