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
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { isAbsolute, join, relative, resolve } from 'path'

/** Create a fresh, empty directory to serve as userData for one smoke run. */
export function createSmokeUserDataDir(root: string = tmpdir()): string {
  return mkdtempSync(join(root, 'timetrack-smoke-'))
}

/** True when `candidate` is `dir` itself or lies anywhere below it. */
export function isSameOrInside(candidate: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Throw unless `userData` is outside every protected directory. Called
 * immediately before the smoke run opens its database, so a missed or
 * reverted `app.setPath` fails the run instead of touching live data.
 */
export function assertSmokeUserDataIsolated(userData: string, protectedDirs: string[]): void {
  for (const dir of protectedDirs) {
    if (isSameOrInside(userData, dir)) {
      throw new Error(
        `smoke test refused to run: userData "${userData}" resolves to the default ` +
          `userData "${dir}", which holds the user's live database`
      )
    }
  }
}

/** Best-effort removal; returns false (instead of throwing) if anything is left behind. */
export function removeSmokeUserDataDir(dir: string): boolean {
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
const dir = process.env.TT_SMOKE_DIR
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

/** Spawn the detached cleaner for `dir`; never throws. */
export function scheduleRemovalAfterExit(dir: string): boolean {
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
