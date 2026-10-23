#!/usr/bin/env node
/**
 * Check what a packaged build ships (release 1.22): the asar must hold what
 * the app reads at runtime and nothing from the rest of the checkout.
 *
 * Usage: node scripts/check-package-contents.mjs <path to app.asar>
 *
 * Fails (exit 1) when
 *  - a required file is missing (main, preload, renderer, MCP server,
 *    licences, package.json), or
 *  - a top-level entry is not on the allowlist (e.g. design/, docs/, *.md
 *    notes, local tool folders) — the electron-builder `files` list is a
 *    positive list, and this keeps it one.
 *
 * Guard question: what does it catch? A `files` change (or an electron-builder
 * default) that lets checkout material into the installer, and a build that
 * misses a runtime file. It was red on the old negative-pattern config: the
 * v1.18 asar carried design/, docs/, CLAUDE.md, TODOS.md and more.
 */
import asar from '@electron/asar'

const ALLOWED_TOP = new Set(['out', 'resources', 'node_modules', 'package.json', 'LICENSE'])
const REQUIRED = [
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html',
  'out/renderer/mini.html',
  'out/mcp/mcp/server.js',
  'resources/licenses.json',
  'package.json'
]

const asarPath = process.argv[2]
if (!asarPath) {
  console.error('usage: check-package-contents.mjs <app.asar>')
  process.exit(2)
}

const files = asar
  .listPackage(asarPath)
  .map((f) => f.replace(/\\/g, '/').replace(/^\//, ''))
  .filter(Boolean)
const fileSet = new Set(files)

const unexpected = [...new Set(files.map((f) => f.split('/')[0]))].filter(
  (top) => !ALLOWED_TOP.has(top)
)
const missing = REQUIRED.filter((r) => !fileSet.has(r))

// #269: exactly the native SQLite binary of the platform that built the
// package (this script runs on the build runner), none of the other seven.
const PREBUILDS = 'node_modules/better-sqlite3/prebuilds/'
const ownPrebuild = `${PREBUILDS}${process.platform}-${process.arch}.node`
const prebuilds = files.filter((f) => f.startsWith(PREBUILDS) && f.endsWith('.node'))
const prebuildProblem =
  prebuilds.length === 1 && prebuilds[0] === ownPrebuild
    ? null
    : `expected only ${ownPrebuild}, found [${prebuilds.join(', ')}]`

if (unexpected.length || missing.length || prebuildProblem) {
  if (unexpected.length) console.error(`Unexpected top-level entries: ${unexpected.join(', ')}`)
  if (missing.length) console.error(`Missing runtime files: ${missing.join(', ')}`)
  if (prebuildProblem) console.error(`Native SQLite binaries: ${prebuildProblem}`)
  process.exit(1)
}
console.log(`Package contents ok: ${files.length} entries under ${[...ALLOWED_TOP].join(', ')}`)
