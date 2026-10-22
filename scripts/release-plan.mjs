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
 *
 * Optional RELEASE_ASSETS (#234): the newline-separated asset names attached
 * to an existing release after a re-run has uploaded its own. When it is set
 * — even to the empty string — a part counts as present only if its assets
 * are attached, whatever this run's job did. A re-run's job results describe
 * the re-run, not the release: `--clobber` removes nothing, so a job that
 * fails in the re-run leaves the first run's installers and update feeds in
 * place, and demoting that release would withdraw a valid version from
 * stable updates. Unset (first publish), the job results decide.
 *
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
    // Every one of these must match an attached asset (RELEASE_ASSETS).
    assets: [(name) => name.endsWith('.exe'), (name) => name === 'latest.yml'],
    missing:
      '**Windows installer** — no `.exe` and no `latest.yml`, so Windows clients are not offered this version.'
  },
  {
    env: 'MACOS_RESULT',
    job: 'build-macos',
    installer: true,
    assets: [
      (name) => name.endsWith('.dmg'),
      (name) => name.endsWith('.zip'),
      (name) => name === 'latest-mac.yml'
    ],
    missing:
      '**macOS build** — no `.dmg`/`.zip` and no `latest-mac.yml`, so macOS clients are not offered this version.'
  },
  {
    env: 'STREAMDECK_RESULT',
    job: 'pack-streamdeck',
    installer: false,
    assets: [(name) => name.endsWith('.streamDeckPlugin')],
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

const attached =
  process.env.RELEASE_ASSETS === undefined
    ? null
    : process.env.RELEASE_ASSETS.split(/\r?\n/)
        .map((name) => name.trim())
        .filter((name) => name !== '')

const missing = []
for (const part of PARTS) {
  const result = process.env[part.env]
  // An unknown value means the workflow wiring changed — refuse rather than
  // treat it as either built or missing.
  if (!KNOWN_RESULTS.has(result)) fail(`${part.env}='${result}' is not a job result.`)
  const present =
    attached === null
      ? result === 'success'
      : part.assets.every((matches) => attached.some(matches))
  if (!present) missing.push({ ...part, result })
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
      ...missing.map((part) =>
        attached === null
          ? `> - ${part.missing} (job \`${part.job}\`: ${part.result})`
          : `> - ${part.missing} (not attached; job \`${part.job}\` in the latest run: ${part.result})`
      )
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
