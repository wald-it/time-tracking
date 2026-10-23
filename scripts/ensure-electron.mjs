/**
 * Fetch the Electron binary during `pnpm install` (postinstall, #269).
 *
 * Since Electron 42 the `electron` package no longer downloads its binary when
 * it is installed; `require('electron')` downloads it on first use. That is not
 * enough here: electron-vite (`pnpm dev`, `pnpm start`) reads
 * `node_modules/electron/path.txt` itself and fails with "Electron uninstall"
 * when the file does not exist yet, and two first runs at once (dev and tests)
 * would race on the same download. So the install fetches it, as it did before
 * Electron 42.
 *
 * This is only the Electron binary. It compiles nothing: better-sqlite3 ships
 * prebuilt N-API binaries and needs no rebuild.
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const require = createRequire(import.meta.url)

try {
  // The electron package's index.js downloads the binary if it is missing.
  const executable = require('electron')
  if (typeof executable !== 'string' || !existsSync(executable)) {
    throw new Error(`no Electron binary at ${executable}`)
  }
} catch (cause) {
  console.error(
    [
      '',
      '  Could not fetch the Electron binary (it needs network access once).',
      '  Retry with:',
      '',
      '      pnpm exec install-electron --no',
      '',
      `  Underlying error: ${cause?.message ?? cause}`,
      ''
    ].join('\n')
  )
  process.exit(1)
}
