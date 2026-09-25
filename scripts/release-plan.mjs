#!/usr/bin/env node
/**
 * Release plan for `publish-release` (#221): given the results of the three
 * build jobs, decide how a partial release is marked.
 *
 * `publish-release` runs whenever the tag is valid and at least one installer
 * was built (the job-level `if:` in release.yml). This script answers the rest:
 *
 *   - an installer is missing   → prerelease. electron-updater ignores
 *     prereleases, so no client is offered a version whose update feed
 *     (`latest.yml` / `latest-mac.yml`) does not exist on the release. Lift it
 *     by hand once the gap is closed (or by re-running the release).
 *   - only the Stream Deck plugin is missing → a normal release; no updater
 *     feed depends on it.
 *
 * Whatever is missing is named in a notice that the workflow puts at the top
 * of the release notes.
 *
 * Input (env): WINDOWS_RESULT, MACOS_RESULT, STREAMDECK_RESULT — each a GitHub
 * `needs.<job>.result` (success | failure | cancelled | skipped).
 * Output: `prerelease=true|false` appended to $GITHUB_OUTPUT, the notice
 * (empty when nothing is missing) written to $NOTICE_FILE.
 *
 * Plain Node, no dependencies: `publish-release` runs without `pnpm install`.
 */
import { appendFileSync, writeFileSync } from 'node:fs'

const KNOWN_RESULTS = new Set(['success', 'failure', 'cancelled', 'skipped'])

const PARTS = [
  {
    env: 'WINDOWS_RESULT',
    job: 'build-windows',
    installer: true,
    missing:
      '**Windows installer** — no `.exe` and no `latest.yml`, so Windows clients are not offered this version.'
  },
  {
    env: 'MACOS_RESULT',
    job: 'build-macos',
    installer: true,
    missing:
      '**macOS build** — no `.dmg`/`.zip` and no `latest-mac.yml`, so macOS clients are not offered this version.'
  },
  {
    env: 'STREAMDECK_RESULT',
    job: 'pack-streamdeck',
    installer: false,
    missing: '**Stream Deck plugin** — no `.streamDeckPlugin` attached to this release.'
  }
]

function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

const outputFile = process.env.GITHUB_OUTPUT
const noticeFile = process.env.NOTICE_FILE
if (!outputFile) fail('GITHUB_OUTPUT is not set.')
if (!noticeFile) fail('NOTICE_FILE is not set.')

const missing = []
for (const part of PARTS) {
  const result = process.env[part.env]
  // An unknown value means the workflow wiring changed — refuse rather than
  // treat it as either built or missing.
  if (!KNOWN_RESULTS.has(result)) fail(`${part.env}='${result}' is not a job result.`)
  if (result !== 'success') missing.push({ ...part, result })
}

const prerelease = missing.some((part) => part.installer)

let notice = ''
if (missing.length > 0) {
  notice =
    [
      '> [!WARNING]',
      prerelease
        ? '> **Partial release, published as a prerelease.** Part of the build failed; what did build is attached below.'
        : '> **Partial release.** Part of the build failed; what did build is attached below.',
      '>',
      '> Missing:',
      ...missing.map((part) => `> - ${part.missing} (job \`${part.job}\`: ${part.result})`)
    ].join('\n') + '\n\n'
  for (const part of missing) {
    console.log(
      `::warning::Partial release — ${part.job} ${part.result}, its artifacts are missing.`
    )
  }
}

writeFileSync(noticeFile, notice)
appendFileSync(outputFile, `prerelease=${prerelease}\n`)
console.log(
  missing.length === 0
    ? 'Release plan: complete release.'
    : `Release plan: partial release, prerelease=${prerelease}.`
)
