/**
 * Runs Vitest on the Electron binary in Node mode (`ELECTRON_RUN_AS_NODE=1`).
 *
 * Why this exists: the tests run in the runtime the app ships. Electron brings
 * its own Node (24.x with Electron 44), and the host may have another one
 * (CI uses Node 22). Test code that behaves differently on the two would pass
 * here and fail in the app, or the other way round.
 *
 * History (#151, #269): this script was first the answer to a native ABI
 * conflict. `better-sqlite3` used to be compiled against the Electron ABI, so a
 * system Node could not load it, and every DB-backed suite skipped itself
 * (`334 passed | 201 skipped` next to a green summary). Since #269 it is an
 * N-API module whose prebuilt binary loads under both runtimes, so the ABI
 * reason is gone — the runtime reason stays, and `vitest.config.ts` refuses to
 * load outside Electron so that a direct `vitest` call cannot quietly test on
 * the host's Node.
 *
 * Vitest spawns its workers with `process.execPath` and inherits this
 * environment, so the flag reaches them too.
 *
 * Depends on Electron's **RunAsNode** fuse, like `src/main/mcpLaunch.ts`. This
 * runs the dev binary from node_modules/electron, which carries no fuses: the
 * fuses are set only when packaging (`electronFuses` in electron-builder.yml).
 * Never write fuses into node_modules/electron — pnpm shares that binary
 * across worktrees, and RunAsNode off there would break every test run.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** Print an actionable error and stop; never fall back to a runtime that lies. */
function fail(lines) {
  console.error(`\n  ${lines.join('\n  ')}\n`)
  process.exit(1)
}

let electronPath
try {
  // Since Electron 42 the package downloads its binary on first use instead
  // of during install, so the first run after a fresh install may print
  // "Downloading Electron binary..." here.
  electronPath = require('electron')
} catch (cause) {
  fail([
    'Cannot run the test suite: the Electron binary is missing and could not be',
    'downloaded.',
    '',
    'Tests run on Electron so that they run in the runtime the app ships. Since',
    'Electron 42, `pnpm install` does not fetch the binary; it is downloaded on',
    'first use, which needs network access. Fetch it explicitly:',
    '',
    '    pnpm exec install-electron --no',
    '',
    `Underlying error: ${cause?.message ?? cause}`
  ])
}

if (typeof electronPath !== 'string') {
  fail([
    'Cannot run the test suite: `require("electron")` did not return a path.',
    'This script must run under plain Node, not under Electron itself.'
  ])
}

const vitestBin = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')

const child = spawn(electronPath, [vitestBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})

child.on('error', (err) => {
  fail([`Failed to start Electron at ${electronPath}:`, String(err)])
})

child.on('exit', (code, signal) => {
  // A signalled child has no exit code; report failure rather than a silent 0.
  process.exit(signal ? 1 : (code ?? 1))
})
