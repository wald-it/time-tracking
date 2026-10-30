/**
 * Guard for #221: a plugin failure must not discard the Windows installer.
 *
 * Until v1.19.0, `publish-release` needed all three build jobs to succeed —
 * one red job skipped the publish, and a green, smoke-tested installer was
 * thrown away with it (v1.18.0: the plugin job; v1.19.0: the macOS job).
 *
 * The owner decision (2026-09-25) is to publish what exists, marked by what is
 * missing:
 *   - an installer is missing  → prerelease. electron-updater ignores
 *     prereleases, so no client is offered a version whose update feed
 *     (`latest.yml`) does not exist on the release.
 *   - only the Stream Deck plugin is missing → a normal release. No updater
 *     feed depends on it.
 *   - either way the release notes open with a notice naming what is missing.
 *   - no installer at all → no release. A release page with nothing to
 *     install is not a partial release.
 *
 * Two halves, both checked here: the decision itself lives in
 * `scripts/release-plan.mjs` (run with the workflow's inputs and outputs: env
 * in; files, stdout, stderr and exit code out), and the wiring that lets
 * `publish-release` run on partial success lives in `release.yml` (checked as
 * text — the repo has no YAML parser as a direct dependency, and the
 * assertions are about a handful of exact lines).
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

const REPO_ROOT = resolve(__dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'release-plan.mjs')
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'release.yml')

type Result = 'success' | 'failure' | 'skipped' | 'cancelled'

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * Run a release script unchanged with `env` — in a worker thread, not a child
 * process. A child's exit is reported only once Windows has finished tearing
 * the process down: the scripts' own work took 0.2–0.5 s, the wait after it
 * up to 7.7 s, and under heavy load a single call took 64.6 s against the
 * 60 s budget. With 27 calls the file's duration was the machine's teardown
 * time (#290). A
 * worker has its own `process.env`, its `process.exit()` ends only the
 * worker, and its stdout/stderr come back as streams. Neither script uses
 * anything a worker lacks (argv, stdin, chdir, signals).
 */
async function runInWorker(script: string, env: Record<string, string>): Promise<Run> {
  const worker = new Worker(pathToFileURL(script), {
    env: { ...process.env, ...env },
    stdout: true,
    stderr: true
  })
  let stdout = ''
  let stderr = ''
  worker.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
  worker.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
  // An uncaught exception ends the worker with code 1, like a crashing CLI:
  // its stack goes to stderr, and 'exit' follows. (Not `once(worker, 'exit')`,
  // which would reject on 'error' instead of reporting the exit code.)
  worker.on('error', (e: unknown) => (stderr += String((e as Error | null)?.stack ?? e)))
  const exited = new Promise<number>((resolve) => worker.once('exit', resolve))
  // The streams end after 'exit'; wait for both so no output is cut off.
  const [status] = await Promise.all([
    exited,
    once(worker.stdout, 'end'),
    once(worker.stderr, 'end')
  ])
  return { status, stdout, stderr }
}

/** The same, as a real process — what the workflow does. Used once, below. */
async function runAsProcess(script: string, env: Record<string, string>): Promise<Run> {
  // The suite runs on the Electron binary in Node mode (ELECTRON_RUN_AS_NODE
  // is already set in this process), so process.execPath runs a plain script.
  const proc = spawn(process.execPath, [script], { env: { ...process.env, ...env } })
  let stdout = ''
  let stderr = ''
  proc.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
  proc.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
  const [status] = (await once(proc, 'close')) as [number | null]
  return { status, stdout, stderr }
}

interface Plan extends Run {
  outputs: Record<string, string>
  notice: string
}

async function runPlan(
  windows: Result,
  streamdeck: Result,
  releaseAssets?: string[],
  extraEnv: Record<string, string> = {},
  run: typeof runInWorker = runInWorker
): Promise<Plan> {
  const dir = mkdtempSync(join(tmpdir(), 'release-plan-'))
  const outputFile = join(dir, 'github_output')
  const noticeFile = join(dir, 'notice.md')
  writeFileSync(outputFile, '')
  const proc = await run(SCRIPT, {
    WINDOWS_RESULT: windows,
    STREAMDECK_RESULT: streamdeck,
    GITHUB_OUTPUT: outputFile,
    NOTICE_FILE: noticeFile,
    ...(releaseAssets === undefined ? {} : { RELEASE_ASSETS: releaseAssets.join('\n') }),
    ...extraEnv
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
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // best effort: a scanner holding a just-written file must not fail the test
  }
  return { status: proc.status, stderr: proc.stderr, outputs, notice, stdout: proc.stdout }
}

describe('release plan (#221)', () => {
  it('everything built: a normal release without a notice', async () => {
    const plan = await runPlan('success', 'success')
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.outputs.prerelease).toBe('false')
    expect(plan.notice.trim()).toBe('')
  })

  it('only the Stream Deck plugin missing: normal release, notice names the plugin', async () => {
    const plan = await runPlan('success', 'failure')
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.outputs.prerelease).toBe('false')
    expect(plan.notice).toMatch(/Stream Deck plugin/)
    expect(plan.notice).not.toMatch(/macOS|Windows/)
  })

  // The one test that pays for a real process: the script still starts and
  // answers as a CLI, the way the workflow runs it. Its budget is twice the
  // slowest single call measured in #290 (64.6 s under heavy load).
  it('runs as a CLI process, as the workflow runs it', async () => {
    const plan = await runPlan('failure', 'success', undefined, {}, runAsProcess)
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.outputs.prerelease).toBe('true')
    expect(plan.notice).toMatch(/Windows/)
    expect(plan.stdout).toContain('::warning::')
  }, 120_000)

  it('Windows missing: prerelease, notice names Windows and its update feed', async () => {
    const plan = await runPlan('failure', 'success')
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.outputs.prerelease).toBe('true')
    expect(plan.notice).toMatch(/Windows/)
    expect(plan.notice).toMatch(/latest\.yml/)
  })

  it('a skipped or cancelled job counts as missing, not as built', async () => {
    expect((await runPlan('skipped', 'success')).outputs.prerelease).toBe('true')
    expect((await runPlan('cancelled', 'success')).outputs.prerelease).toBe('true')
    expect((await runPlan('success', 'skipped')).notice).toMatch(/Stream Deck plugin/)
  })

  it('refuses an unknown job result instead of guessing', async () => {
    const plan = await runPlan('bogus' as Result, 'success')
    expect(plan.status).not.toBe(0)
  })
})

// #416: Windows and plugin assets form a complete release. Keep the real
// Windows/plugin names from v1.20.0, including its .blockmap companion.
const COMPLETE_ASSETS = [
  'com.timetrack.streamdeck.streamDeckPlugin',
  'latest.yml',
  'time-tracking-1.20.0-setup.exe',
  'time-tracking-1.20.0-setup.exe.blockmap'
]

describe('release plan on a re-run: decided from the attached assets (#234)', () => {
  it('Windows and plugin assets alone are a complete normal release (#416)', async () => {
    const plan = await runPlan('success', 'success', COMPLETE_ASSETS)
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.outputs.prerelease).toBe('false')
    expect(plan.notice.trim()).toBe('')
  })

  it('a complete release stays complete when an installer job fails in the re-run', async () => {
    // --clobber removes nothing: the first run's installers and latest*.yml
    // are still attached, so demoting the release would only withdraw a
    // valid version from stable updates.
    const plan = await runPlan('failure', 'success', COMPLETE_ASSETS)
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.outputs.prerelease).toBe('false')
    expect(plan.notice.trim()).toBe('')
  })

  it('no job succeeding in the re-run does not demote a complete release either', async () => {
    const plan = await runPlan('failure', 'skipped', COMPLETE_ASSETS)
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.outputs.prerelease).toBe('false')
    expect(plan.notice.trim()).toBe('')
  })

  it('a partial release whose gap is still open stays a prerelease', async () => {
    const withoutInstaller = COMPLETE_ASSETS.filter((a) => !a.endsWith('.exe'))
    const plan = await runPlan('failure', 'success', withoutInstaller)
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.outputs.prerelease).toBe('true')
    expect(plan.notice).toMatch(/Windows/)
    expect(plan.notice).not.toMatch(/Stream Deck/)
  })

  it('an installer without its update feed counts as missing, whatever the job says', async () => {
    const withoutFeed = COMPLETE_ASSETS.filter((a) => a !== 'latest.yml')
    const plan = await runPlan('success', 'success', withoutFeed)
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.outputs.prerelease).toBe('true')
    expect(plan.notice).toMatch(/Windows/)
    expect(plan.notice).not.toMatch(/macOS|Stream Deck/)
  })

  it('only the Stream Deck plugin missing from the release: normal release with a notice', async () => {
    const withoutPlugin = COMPLETE_ASSETS.filter((a) => !a.endsWith('.streamDeckPlugin'))
    const plan = await runPlan('success', 'failure', withoutPlugin)
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.outputs.prerelease).toBe('false')
    expect(plan.notice).toMatch(/Stream Deck plugin/)
  })

  it('a release with no assets at all is a prerelease, not complete', async () => {
    const plan = await runPlan('success', 'success', [])
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.outputs.prerelease).toBe('true')
  })

  it('the job-result plan before a re-run is provisional: no ::warning:: annotation', async () => {
    const provisional = await runPlan('failure', 'success', undefined, {
      RELEASE_EXISTS: 'true'
    })
    expect(provisional.status, provisional.stderr).toBe(0)
    expect(provisional.stdout).not.toContain('::warning::')
    expect(provisional.stdout).toMatch(/Provisional plan/)
    // A first publish still annotates, and so does the re-plan from assets.
    expect((await runPlan('failure', 'success')).stdout).toContain('::warning::')
    const replan = await runPlan('failure', 'success', [], { RELEASE_EXISTS: 'true' })
    expect(replan.stdout).toContain('::warning::')
  })

  it('still refuses an unknown job result', async () => {
    expect((await runPlan('bogus' as Result, 'success', COMPLETE_ASSETS)).status).not.toBe(0)
  })
})

describe('macOS release retirement (#416)', () => {
  it.each(['build-macos', 'MACOS_RESULT'])('release.yml contains no %s', (token) => {
    expect(readFileSync(WORKFLOW, 'utf8')).not.toContain(token)
  })

  it('electron-builder.yml has no mac key', () => {
    const config = readFileSync(join(REPO_ROOT, 'electron-builder.yml'), 'utf8')
    expect(config).not.toMatch(/^\s*mac\s*:/m)
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
    expect(list).toEqual(['prepare', 'build-windows', 'pack-streamdeck'])
  })

  it('runs on partial success, but only after a valid tag and the Windows installer', () => {
    const cond = job.match(/\n {4}if: (.*)\n/)
    expect(cond, 'publish-release needs a job-level if:').not.toBeNull()
    const expr = cond![1]
    // Without a status function, GitHub adds an implicit success() — which is
    // exactly the all-or-nothing behaviour this issue is about.
    expect(expr).toContain('!cancelled()')
    expect(expr).toContain("needs.prepare.result == 'success'")
    expect(expr).toContain("needs.build-windows.result == 'success'")
    expect(expr).not.toContain('always()')
  })

  it.each([
    ['Download installer artifact', 'build-windows'],
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

    it('re-plans from the assets attached after the upload and edits with that result (#234)', () => {
      // The plan step before this one only knows this run's job results; on
      // an existing release those are not the release's state.
      const upload = editPath.indexOf('gh release upload "$TAG"')
      const assets = editPath.indexOf('--json assets')
      const replan = editPath.indexOf('node scripts/release-plan.mjs')
      const edit = editPath.indexOf('gh release edit "$TAG"')
      expect(assets, 'asset lookup not found').toBeGreaterThan(upload)
      expect(replan, 're-plan not found').toBeGreaterThan(assets)
      expect(edit).toBeGreaterThan(replan)
      expect(editPath).toContain('RELEASE_ASSETS=')
    })

    it('lets release-latest.mjs decide, against the current latest release', () => {
      expect(editPath).toContain('node scripts/release-latest.mjs')
      expect(editPath).toContain('CURRENT_LATEST')
    })
  })
})

// Release provenance: the tag is validated before anything runs with write
// rights, every job builds the one commit `prepare` resolved, and what is
// published carries an attestation and its checksums. Checked as text like the
// wiring above.

/** Each job of a workflow as text, keyed by job id. */
function jobsOf(workflowText: string): Record<string, string> {
  const lines = workflowText.split('\n')
  const start = lines.indexOf('jobs:')
  const jobs: Record<string, string> = {}
  let current: string | null = null
  for (const line of lines.slice(start + 1)) {
    const head = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (head) {
      current = head[1]
      jobs[current] = ''
      continue
    }
    if (current !== null) jobs[current] += line + '\n'
  }
  return jobs
}

/** The body of every `run:` script (block or single line), with its line number. */
function runScripts(workflowText: string): { line: number; body: string }[] {
  const lines = workflowText.split('\n')
  const scripts: { line: number; body: string }[] = []
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*)(?:- )?run:\s*(.*)$/)
    if (!m) return
    const keyIndent = line.indexOf('run:')
    if (!/^[|>]/.test(m[2])) {
      scripts.push({ line: i + 1, body: m[2] })
      return
    }
    const body: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]
      if (next.trim() !== '' && next.search(/\S/) <= keyIndent) break
      body.push(next)
    }
    scripts.push({ line: i + 1, body: body.join('\n') })
  })
  return scripts
}

const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows')

describe('release.yml package smoke (#312)', () => {
  const text = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n')
  const jobs = jobsOf(text)

  it('has no inline smoke-test call', () => {
    expect(text).not.toContain('--smoke-test=')
  })

  it.each(['build-windows'])('%s checks the packaged fuses (#272)', (id) => {
    const job = jobs[id] ?? ''
    const scripts = runScripts(job).map((script) => script.body.trim())
    const probe = scripts.indexOf('node scripts/package-smoke.mjs fuses --exe "$APP_EXE"')
    expect(probe, 'the packaged binary must pass the fuse probe').toBeGreaterThanOrEqual(0)
    expect(probe).toBeLessThan(
      scripts.indexOf('node scripts/package-smoke.mjs smoke --exe "$APP_EXE"')
    )
    const jobEnv = job.slice(0, job.indexOf('\n    steps:'))
    expect(jobEnv).toMatch(/\n {4}env:\n(?: {6}.*\n)*? {6}APP_EXE: dist\//)
  })

  it.each([['build-windows', 'dist/win-unpacked/TimeTrack.exe', 'dist/win-unpacked/resources']])(
    '%s runs both shared probes on its package',
    (id, exe, resources) => {
      const job = jobs[id] ?? ''
      const scripts = runScripts(job).map((script) => script.body.replace(/\\\s*\n\s*/g, '').trim())
      expect(scripts).toContain('node scripts/package-smoke.mjs smoke --exe "$APP_EXE"')
      expect(scripts).toContain(
        'node scripts/package-smoke.mjs mcp --exe "$APP_EXE" ' +
          '--entry "$APP_RESOURCES/app.asar/out/mcp/mcp/server.js" ' +
          '--server-source src/mcp/server.ts'
      )
      expect(job).toContain(`APP_EXE: ${exe}\n`)
      expect(job).toContain(`APP_RESOURCES: ${resources}\n`)
    }
  )
})

describe('release.yml provenance', () => {
  const text = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n')
  const jobs = jobsOf(text)

  it.each(readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f)))(
    '%s expands no ${{ }} expression inside a run: script',
    (file) => {
      // Values reach scripts through env: and are used as quoted variables,
      // so a tag or ref is never pasted into the script text itself.
      const wf = readFileSync(join(WORKFLOW_DIR, file), 'utf8').replace(/\r\n/g, '\n')
      const scripts = runScripts(wf)
      expect(scripts.length).toBeGreaterThan(0)
      const offending = scripts.filter((s) => s.body.includes('${{')).map((s) => s.line)
      expect(offending, `run: scripts with \${{ }} at lines ${offending.join(', ')}`).toEqual([])
    }
  )

  it('validates the tag in the first step of prepare, before the checkout', () => {
    const prepare = jobs['prepare'] ?? ''
    const steps = prepare.slice(prepare.indexOf('\n    steps:\n'))
    const first = steps.indexOf('\n      - ')
    const firstStep = steps.slice(first, steps.indexOf('\n      - ', first + 1))
    expect(firstStep).toContain('name: Validate tag and ref')
    expect(firstStep).toContain('^v[0-9]+\\.[0-9]+\\.[0-9]+$')
    expect(firstStep).toContain('TAG: ${{ inputs.tag || github.ref_name }}')
    expect(firstStep).not.toContain('uses:')
  })

  it('prepare resolves the commit and exposes it as an output', () => {
    expect(jobs['prepare']).toContain('sha: ${{ steps.resolve.outputs.sha }}')
    expect(jobs['prepare']).toContain('echo "sha=$SHA"')
  })

  // Codex finding on #256: the provenance attestation takes the commit from
  // the OIDC token (GITHUB_SHA), not from the checkout. prepare refuses to
  // build any other commit, so the attestation always names what is built.
  it('prepare refuses to build a commit other than the one the run started from', () => {
    const prepare = jobs['prepare'] ?? ''
    const guard = prepare.indexOf('if [ "$SHA" != "$GITHUB_SHA" ]; then')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(prepare.indexOf('echo "sha=$SHA"'))
    expect(prepare.slice(guard, prepare.indexOf('fi', guard))).toContain('exit 1')
  })

  // Codex finding on 540e601: with `default: main` on the ref input, a run
  // started from a tag with the field left empty built main and was refused.
  it('a dispatch with no ref builds the commit it was started from', () => {
    const inputs = text.slice(text.indexOf('workflow_dispatch:'), text.indexOf('\nenv:'))
    expect(inputs).toContain('ref:')
    expect(inputs).not.toContain('default:')
    expect(jobs['prepare']).toContain('ref: ${{ inputs.ref || github.sha }}')
  })

  it('every job after prepare checks out exactly that commit', () => {
    const others = Object.entries(jobs).filter(([id]) => id !== 'prepare')
    expect(others.length).toBeGreaterThan(0)
    for (const [id, body] of others) {
      const checkouts = body.split('uses: actions/checkout@').length - 1
      expect(checkouts, `${id} has no checkout`).toBeGreaterThan(0)
      const pinned = body.split('ref: ${{ needs.prepare.outputs.sha }}').length - 1
      expect(pinned, `${id}: every checkout must use needs.prepare.outputs.sha`).toBe(checkouts)
      expect(body, `${id} must need prepare`).toMatch(
        /(?:^|\n) {4}needs: (prepare|\[[^\]]*prepare[^\]]*\])\n/
      )
    }
  })

  it('grants nothing at workflow level; every job declares its own permissions', () => {
    expect(text).toMatch(/\npermissions: \{\}\n/)
    for (const [id, body] of Object.entries(jobs)) {
      expect(body, `${id} declares no permissions`).toMatch(/\n {4}permissions:\n/)
    }
  })

  it('only publish-release may mint an OIDC token, and it attests what it publishes', () => {
    for (const [id, body] of Object.entries(jobs)) {
      if (id === 'publish-release') continue
      expect(body, id).not.toContain('id-token: write')
      expect(body, id).not.toContain('attestations: write')
    }
    const publish = jobs['publish-release'] ?? ''
    expect(publish).toContain('id-token: write')
    expect(publish).toContain('attestations: write')
    const attest = publish.indexOf('uses: actions/attest-build-provenance@')
    expect(attest, 'attest step not found').toBeGreaterThanOrEqual(0)
    // Pinned to a full commit SHA like every other action.
    expect(publish.slice(attest)).toMatch(/^uses: actions\/attest-build-provenance@[0-9a-f]{40} #/)
    expect(publish).toContain('subject-path: dist/*')
    expect(attest).toBeLessThan(publish.indexOf('- name: Create / update GitHub Release'))
  })

  it('both release paths close the notes with checksums and how to verify', () => {
    const publish = jobs['publish-release'] ?? ''
    expect(publish).toContain('sha256sum')
    expect(publish).toContain('gh attestation verify')
    expect(publish).toContain('Get-FileHash')
    expect(publish).not.toContain('shasum -a 256')
    // Called once on the re-run path (from the attached assets) and once on
    // the first publish (from dist/).
    expect(publish.match(/\n\s+write_verify_section \S+/g) ?? []).toHaveLength(2)
    expect(publish).toContain('"$VERIFY_FILE" > "$NOTES_FILE"')
    expect(publish).toContain('--verify-tag')
  })
})

const LATEST_SCRIPT = join(REPO_ROOT, 'scripts', 'release-latest.mjs')

async function runLatest(env: {
  TAG: string
  CURRENT_LATEST: string
  WAS_PRERELEASE: string
  PRERELEASE: string
}): Promise<Run> {
  const r = await runInWorker(LATEST_SCRIPT, env)
  return { ...r, stdout: r.stdout.trim() }
}

describe('release-latest: may a completed prerelease take the latest marker? (#221)', () => {
  const completed = { WAS_PRERELEASE: 'true', PRERELEASE: 'false' }

  it('completing an older prerelease after a newer stable release sets no --latest', async () => {
    // v1.20.0 went out partial, v1.21.0 shipped stable, then v1.20.0 is
    // re-run: moving the marker back would make electron-updater offer
    // clients v1.20.0 instead of v1.21.0.
    const r = await runLatest({ ...completed, TAG: 'v1.20.0', CURRENT_LATEST: 'v1.21.0' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('false')
  })

  it('a completed prerelease newer than the current latest takes the marker', async () => {
    const r = await runLatest({ ...completed, TAG: 'v1.20.0', CURRENT_LATEST: 'v1.19.1' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('true')
  })

  it('compares versions numerically, not as text', async () => {
    expect(
      (await runLatest({ ...completed, TAG: 'v1.10.0', CURRENT_LATEST: 'v1.9.3' })).stdout
    ).toBe('true')
    expect(
      (await runLatest({ ...completed, TAG: 'v1.9.3', CURRENT_LATEST: 'v1.10.0' })).stdout
    ).toBe('false')
  })

  it('the tag that already is latest needs no --latest', async () => {
    expect(
      (await runLatest({ ...completed, TAG: 'v1.20.0', CURRENT_LATEST: 'v1.20.0' })).stdout
    ).toBe('false')
  })

  it('only a former prerelease that is now complete qualifies', async () => {
    const base = { TAG: 'v1.20.0', CURRENT_LATEST: 'v1.19.1' }
    expect(
      (await runLatest({ ...base, WAS_PRERELEASE: 'false', PRERELEASE: 'false' })).stdout
    ).toBe('false')
    expect((await runLatest({ ...base, WAS_PRERELEASE: 'true', PRERELEASE: 'true' })).stdout).toBe(
      'false'
    )
  })

  it('fails closed when the current latest release could not be read', async () => {
    const r = await runLatest({ ...completed, TAG: 'v1.20.0', CURRENT_LATEST: '' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('false')
    expect(r.stderr).toMatch(/by hand/)
  })

  it('fails closed on a tag it cannot compare', async () => {
    const r = await runLatest({ ...completed, TAG: 'v1.20.0-beta.1', CURRENT_LATEST: 'v1.19.1' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('false')
    expect(r.stderr).toMatch(/by hand/)
  })
})

describe('test.yml spends Windows minutes on pull requests only (#441)', () => {
  const TEST_WORKFLOW = join(WORKFLOW_DIR, 'test.yml')
  const text = readFileSync(TEST_WORKFLOW, 'utf8').replace(/\r\n/g, '\n')
  const jobs = jobsOf(text)
  // Comments between jobs land in the job above them; only YAML lines count.
  const yamlOf = (job: string): string =>
    job
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
  const costly = Object.keys(jobs).filter((id) => /\b(windows|macos)-/.test(yamlOf(jobs[id])))

  it('still runs on a push to main and on every pull request', () => {
    const on = text.slice(text.indexOf('\non:\n'), text.indexOf('\njobs:\n'))
    expect(on).toMatch(/\n {2}push:\n {4}branches: \[main\]\n/)
    expect(on).toMatch(/\n {2}pull_request:\n/)
  })

  it('finds the Windows jobs it guards', () => {
    expect(costly).toEqual(expect.arrayContaining(['test', 'package-smoke']))
  })

  it.each(costly)('%s runs on pull requests only', (id) => {
    expect(jobs[id]).toMatch(/^ {4}if: github\.event_name == 'pull_request'\n/m)
  })

  it('berlin-zone runs on Linux, on push and pull request alike', () => {
    const job = yamlOf(jobs['berlin-zone'] ?? '')
    expect(job).toMatch(/^ {4}runs-on: ubuntu-latest$/m)
    expect(job).not.toMatch(/^ {4}if:/m)
  })

  it('cancels a superseded PR run, never a run on main', () => {
    expect(text).toContain(
      '\nconcurrency:\n' +
        "  group: test-${{ github.event_name == 'pull_request' && github.ref || github.sha }}\n" +
        "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n"
    )
  })

  it('release.yml has no concurrency group that could cancel a release', () => {
    expect(readFileSync(WORKFLOW, 'utf8')).not.toContain('concurrency')
  })
})
