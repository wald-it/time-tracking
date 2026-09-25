/**
 * Guard for #221: one platform failing at release time must not discard the
 * other platform's finished artifacts.
 *
 * Until v1.19.0, `publish-release` needed all three build jobs to succeed —
 * one red job skipped the publish, and a green, smoke-tested installer was
 * thrown away with it (v1.18.0: the plugin job; v1.19.0: the macOS job).
 *
 * The owner decision (2026-09-25) is to publish what exists, marked by what is
 * missing:
 *   - an installer is missing  → prerelease. electron-updater ignores
 *     prereleases, so no client is offered a version whose update feed
 *     (`latest.yml` / `latest-mac.yml`) does not exist on the release.
 *   - only the Stream Deck plugin is missing → a normal release. No updater
 *     feed depends on it.
 *   - either way the release notes open with a notice naming what is missing.
 *   - no installer at all → no release. A release page with nothing to
 *     install is not a partial release.
 *
 * Two halves, both checked here: the decision itself lives in
 * `scripts/release-plan.mjs` (run as the workflow runs it, as a CLI), and the
 * wiring that lets `publish-release` run on partial success lives in
 * `release.yml` (checked as text — the repo has no YAML parser as a direct
 * dependency, and the assertions are about a handful of exact lines).
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'release-plan.mjs')
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'release.yml')

type Result = 'success' | 'failure' | 'skipped' | 'cancelled'

interface Plan {
  status: number | null
  stderr: string
  outputs: Record<string, string>
  notice: string
}

function runPlan(windows: Result, macos: Result, streamdeck: Result): Plan {
  const dir = mkdtempSync(join(tmpdir(), 'release-plan-'))
  const outputFile = join(dir, 'github_output')
  const noticeFile = join(dir, 'notice.md')
  writeFileSync(outputFile, '')
  // The suite runs on the Electron binary in Node mode (ELECTRON_RUN_AS_NODE
  // is already set in this process), so process.execPath runs a plain script.
  const proc = spawnSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      WINDOWS_RESULT: windows,
      MACOS_RESULT: macos,
      STREAMDECK_RESULT: streamdeck,
      GITHUB_OUTPUT: outputFile,
      NOTICE_FILE: noticeFile
    },
    encoding: 'utf8'
  })
  const outputs: Record<string, string> = {}
  for (const line of readFileSync(outputFile, 'utf8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1)
  }
  let notice = ''
  try {
    notice = readFileSync(noticeFile, 'utf8')
  } catch {
    // no file written — asserted on below where it matters
  }
  return { status: proc.status, stderr: proc.stderr, outputs, notice }
}

describe('release plan (#221)', () => {
  it('everything built: a normal release without a notice', () => {
    const plan = runPlan('success', 'success', 'success')
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.outputs.prerelease).toBe('false')
    expect(plan.notice.trim()).toBe('')
  })

  it('only the Stream Deck plugin missing: normal release, notice names the plugin', () => {
    const plan = runPlan('success', 'success', 'failure')
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.outputs.prerelease).toBe('false')
    expect(plan.notice).toMatch(/Stream Deck plugin/)
    expect(plan.notice).not.toMatch(/macOS|Windows/)
  })

  it('macOS missing: prerelease, notice names macOS and its update feed', () => {
    const plan = runPlan('success', 'failure', 'success')
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.outputs.prerelease).toBe('true')
    expect(plan.notice).toMatch(/macOS/)
    expect(plan.notice).toMatch(/latest-mac\.yml/)
    expect(plan.notice).not.toMatch(/Windows|Stream Deck/)
  })

  it('Windows missing: prerelease, notice names Windows and its update feed', () => {
    const plan = runPlan('failure', 'success', 'success')
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.outputs.prerelease).toBe('true')
    expect(plan.notice).toMatch(/Windows/)
    expect(plan.notice).toMatch(/latest\.yml/)
  })

  it('a skipped or cancelled job counts as missing, not as built', () => {
    expect(runPlan('success', 'skipped', 'success').outputs.prerelease).toBe('true')
    expect(runPlan('cancelled', 'success', 'success').outputs.prerelease).toBe('true')
    expect(runPlan('success', 'success', 'skipped').notice).toMatch(/Stream Deck plugin/)
  })

  it('refuses an unknown job result instead of guessing', () => {
    const plan = runPlan('success', 'bogus' as Result, 'success')
    expect(plan.status).not.toBe(0)
  })
})

describe('release.yml wiring (#221)', () => {
  const text = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n')
  const start = text.indexOf('\n  publish-release:\n')
  const job = start >= 0 ? text.slice(start) : ''

  it('has a publish-release job', () => {
    expect(job).not.toBe('')
  })

  it('needs prepare as well, so its result can gate the publish', () => {
    const needs = job.match(/\n {4}needs: \[([^\]]*)\]/)
    expect(needs).not.toBeNull()
    const list = needs![1].split(',').map((s) => s.trim())
    expect(list).toEqual(
      expect.arrayContaining(['prepare', 'build-windows', 'build-macos', 'pack-streamdeck'])
    )
  })

  it('runs on partial success, but only after a valid tag and at least one installer', () => {
    const cond = job.match(/\n {4}if: (.*)\n/)
    expect(cond, 'publish-release needs a job-level if:').not.toBeNull()
    const expr = cond![1]
    // Without a status function, GitHub adds an implicit success() — which is
    // exactly the all-or-nothing behaviour this issue is about.
    expect(expr).toContain('!cancelled()')
    expect(expr).toContain("needs.prepare.result == 'success'")
    expect(expr).toContain("needs.build-windows.result == 'success'")
    expect(expr).toContain("needs.build-macos.result == 'success'")
    expect(expr).not.toContain('always()')
  })

  it.each([
    ['Download installer artifact', 'build-windows'],
    ['Download macOS artifacts', 'build-macos'],
    ['Download Stream Deck plugin artifact', 'pack-streamdeck']
  ])('"%s" only runs when %s succeeded', (step, jobName) => {
    const at = job.indexOf(`- name: ${step}\n`)
    expect(at, `step "${step}" not found`).toBeGreaterThanOrEqual(0)
    const next = job.indexOf('\n      - ', at + 1)
    const body = job.slice(at, next < 0 ? undefined : next)
    expect(body).toContain(`if: needs.${jobName}.result == 'success'`)
  })

  it('feeds every build result to the release plan and honours its prerelease flag', () => {
    expect(job).toContain('node scripts/release-plan.mjs')
    expect(job).toContain('WINDOWS_RESULT: ${{ needs.build-windows.result }}')
    expect(job).toContain('MACOS_RESULT: ${{ needs.build-macos.result }}')
    expect(job).toContain('STREAMDECK_RESULT: ${{ needs.pack-streamdeck.result }}')
    // Both paths — first publish and re-run on an existing release — must set
    // the flag, so a re-run that completes the release also lifts it.
    const flagUses = job.match(/--prerelease="\$PRERELEASE"/g) ?? []
    expect(flagUses.length).toBe(2)
  })

  describe('re-run on an existing release', () => {
    const editPath = (() => {
      const from = job.indexOf('if gh release view "$TAG"')
      const to = job.indexOf('\n          else\n', from)
      return from >= 0 && to > from ? job.slice(from, to) : ''
    })()

    it('uploads the assets before it changes the release', () => {
      // Lifting the prerelease mark first would show stable clients a release
      // whose update feed is not uploaded yet — and leave it that way if the
      // upload fails or the run is cancelled in between.
      const upload = editPath.indexOf('gh release upload "$TAG"')
      const edit = editPath.indexOf('gh release edit "$TAG"')
      expect(upload, 'upload step not found').toBeGreaterThanOrEqual(0)
      expect(edit, 'edit step not found').toBeGreaterThanOrEqual(0)
      expect(upload).toBeLessThan(edit)
    })

    it('marks a completed former prerelease as latest', () => {
      // electron-updater reads /releases/latest, and GitHub does not reliably
      // move that marker when a prerelease is turned into a normal release.
      expect(editPath).toMatch(/isPrerelease/)
      expect(editPath).toContain('--latest')
    })

    it('lets release-latest.mjs decide, against the current latest release', () => {
      expect(editPath).toContain('node scripts/release-latest.mjs')
      expect(editPath).toContain('CURRENT_LATEST')
    })
  })
})

const LATEST_SCRIPT = join(REPO_ROOT, 'scripts', 'release-latest.mjs')

function runLatest(env: {
  TAG: string
  CURRENT_LATEST: string
  WAS_PRERELEASE: string
  PRERELEASE: string
}): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [LATEST_SCRIPT], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  })
  return { status: proc.status, stdout: proc.stdout.trim(), stderr: proc.stderr }
}

describe('release-latest: may a completed prerelease take the latest marker? (#221)', () => {
  const completed = { WAS_PRERELEASE: 'true', PRERELEASE: 'false' }

  it('completing an older prerelease after a newer stable release sets no --latest', () => {
    // v1.20.0 went out partial, v1.21.0 shipped stable, then v1.20.0 is
    // re-run: moving the marker back would make electron-updater offer
    // clients v1.20.0 instead of v1.21.0.
    const r = runLatest({ ...completed, TAG: 'v1.20.0', CURRENT_LATEST: 'v1.21.0' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('false')
  })

  it('a completed prerelease newer than the current latest takes the marker', () => {
    const r = runLatest({ ...completed, TAG: 'v1.20.0', CURRENT_LATEST: 'v1.19.1' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('true')
  })

  it('compares versions numerically, not as text', () => {
    expect(runLatest({ ...completed, TAG: 'v1.10.0', CURRENT_LATEST: 'v1.9.3' }).stdout).toBe(
      'true'
    )
    expect(runLatest({ ...completed, TAG: 'v1.9.3', CURRENT_LATEST: 'v1.10.0' }).stdout).toBe(
      'false'
    )
  })

  it('the tag that already is latest needs no --latest', () => {
    expect(runLatest({ ...completed, TAG: 'v1.20.0', CURRENT_LATEST: 'v1.20.0' }).stdout).toBe(
      'false'
    )
  })

  it('only a former prerelease that is now complete qualifies', () => {
    const base = { TAG: 'v1.20.0', CURRENT_LATEST: 'v1.19.1' }
    expect(runLatest({ ...base, WAS_PRERELEASE: 'false', PRERELEASE: 'false' }).stdout).toBe(
      'false'
    )
    expect(runLatest({ ...base, WAS_PRERELEASE: 'true', PRERELEASE: 'true' }).stdout).toBe('false')
  })

  it('fails closed when the current latest release could not be read', () => {
    const r = runLatest({ ...completed, TAG: 'v1.20.0', CURRENT_LATEST: '' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('false')
    expect(r.stderr).toMatch(/by hand/)
  })

  it('fails closed on a tag it cannot compare', () => {
    const r = runLatest({ ...completed, TAG: 'v1.20.0-beta.1', CURRENT_LATEST: 'v1.19.1' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('false')
    expect(r.stderr).toMatch(/by hand/)
  })
})
