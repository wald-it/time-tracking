/**
 * Guard for the MCP half of scripts/package-smoke.mjs (#269).
 *
 * The probe runs in CI against the packaged app, where a red run is expensive
 * to reproduce. These tests run the same CLI against a fake MCP server and
 * pin that each failure the probe exists for actually turns it red: a tool
 * missing from tools/list, a native driver that does not load, a server that
 * never answers, a server that dies at start. The green case also checks the
 * environment the probe hands the server (Node mode, temp DB path, temp
 * userData), because that isolation is what makes the probe safe to run.
 *
 * The `smoke` report checks run with a fake process launch below, so they do
 * not open a GUI or require a keychain in this unit test process.
 */
import { describe, it, expect } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'package-smoke.mjs')

/**
 * The orphan test (#328): the probe must reach its verdict, and outside
 * Windows end its process, within ORPHAN_LIMIT_MS after the fake server was
 * up. 60 s, because the time measured still contains the fake server's own
 * end, which the probe has to wait for: up to 4.8 s measured under the swarm's
 * load, and #286 measured that kind of Windows teardown at up to 32 s.
 */
const ORPHAN_LIMIT_MS = 60_000
/**
 * How long the orphan's descendant holds the pipes. Must exceed
 * ORPHAN_LIMIT_MS, or a probe that waits for the descendant would still pass.
 */
const ORPHAN_LIFETIME_MS = 75_000

const FAKE_SERVER = `
const { existsSync } = require('fs')
const mode = process.env.FAKE_MODE
const tools = process.env.FAKE_TOOLS.split(',')
process.stderr.write('[fake] up\\n')
if (mode === 'orphan') {
  // Dies at start but leaves a descendant holding its stdout and stderr, the
  // way a helper process of a packaged app can. It outlives the test's limit
  // (ORPHAN_LIMIT_MS), so only a probe that lets go of the pipes stays under it.
  require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${ORPHAN_LIFETIME_MS})'], {
    stdio: ['ignore', 'inherit', 'inherit']
  })
  process.exit(1)
}
if (mode === 'crash') {
  // No final newline: the probe must flush the unterminated last line.
  process.stderr.write('[fake] Fatal: boom')
  process.exit(1)
}
// The probe must hand over Node mode, an existing temp DB and temp userData.
const envOk =
  process.env.ELECTRON_RUN_AS_NODE === '1' &&
  existsSync(process.env.TIMETRACK_DB_PATH || '') &&
  process.env.APPDATA === process.env.HOME &&
  process.env.TIMETRACK_DB_PATH.startsWith(process.env.HOME)
const rl = require('readline').createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (mode === 'silent' || msg.id === undefined) return
  const reply = (result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
  if (msg.method === 'initialize') {
    reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: envOk ? 'timetrack' : 'bad-env', version: '0' } })
  } else if (msg.method === 'tools/list') {
    const listed = mode === 'missing-tool' ? tools.slice(1) : tools
    reply({ tools: listed.map((name) => ({ name, inputSchema: { type: 'object' } })) })
  } else if (msg.method === 'tools/call') {
    const text =
      mode === 'driver-broken'
        ? 'Fehler: Error: Could not locate the bindings file'
        : 'Fehler: SqliteError: no such table: settings'
    reply({ isError: true, content: [{ type: 'text', text }] })
  }
})
rl.on('close', () => process.exit(0))
`

/**
 * Upper bound for one probe run: its own deadline, two process starts, and the
 * probe's 5 s kill fallback plus its 2 s drain grace at the end. `probe`
 * kills at this point; `probeTimed` only if the verdict has not come by then.
 */
const PROBE_LIMIT_MS = 90_000

/** Writes the fake server and its source into `dir`; returns the probe's argv and env. */
function probeCommand(
  dir: string,
  mode: string,
  tools: string[],
  opts: { source?: string; exe?: string }
): { args: string[]; env: NodeJS.ProcessEnv } {
  const server = join(dir, 'server.js')
  const source = join(dir, 'server.ts')
  writeFileSync(server, FAKE_SERVER)
  writeFileSync(
    source,
    tools.map((n) => `server.registerTool(\n  '${n}',\n  {},\n  async () => ({})\n)\n`).join('')
  )
  // The suite runs on the Electron binary in Node mode, so process.execPath
  // stands in for the packaged app binary; the probe sets Node mode itself.
  const args = [
    SCRIPT,
    'mcp',
    '--exe',
    opts.exe ?? process.execPath,
    '--entry',
    server,
    '--server-source',
    opts.source ?? source,
    '--timeout-ms',
    // Short only where the deadline is the point: a cold Electron start
    // on a busy runner can take several seconds before it answers.
    mode === 'silent' ? '3000' : '20000'
  ]
  return { args, env: { ...process.env, FAKE_MODE: mode, FAKE_TOOLS: tools.join(',') } }
}

function probe(
  mode: string,
  tools: string[],
  opts: { source?: string; exe?: string } = {}
): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'package-smoke-test-'))
  try {
    const { args, env } = probeCommand(dir, mode, tools, opts)
    const proc = spawnSync(process.execPath, args, {
      env,
      encoding: 'utf8',
      timeout: PROBE_LIMIT_MS
    })
    return { status: proc.status, output: `${proc.stdout}\n${proc.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Like `probe`, but times the probe from the moment the fake server was up,
 * that is from the relayed `[fake] up` line (#328):
 * - `verdictMs`: until the probe's `ERROR:` line (it prints one, as its last
 *   output, from the top-level catch);
 * - `exitMs`: until the probe process's 'exit' event.
 * Neither counts the start of the two Electron processes before that line.
 * `exitMs` does count the end of the probe's own process, which Windows can
 * stretch by tens of seconds under load (#264, #286); see the orphan test for
 * where it is used.
 */
async function probeTimed(
  mode: string,
  tools: string[]
): Promise<{
  status: number | null
  output: string
  timedOut: boolean
  verdictMs: number | null
  exitMs: number | null
}> {
  const dir = mkdtempSync(join(tmpdir(), 'package-smoke-test-'))
  try {
    const { args, env } = probeCommand(dir, mode, tools, {})
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { env })
      let output = ''
      let upAt: number | null = null
      let verdictAt: number | null = null
      let exitAt: number | null = null
      let timedOut = false
      const take = (line: string): void => {
        const text = line.replace(/\r$/, '')
        output += text + '\n'
        if (upAt === null && text.includes('[stderr] [fake] up')) upAt = Date.now()
        if (verdictAt === null && text.startsWith('ERROR:')) {
          verdictAt = Date.now()
          clearTimeout(killer)
        }
      }
      // One line buffer per stream: the relayed server lines arrive on stdout,
      // the verdict on stderr, and a line cut at a chunk end must not be glued
      // to the other stream.
      const reader = (stream: NodeJS.ReadableStream): void => {
        let partial = ''
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => {
          const lines = (partial + chunk).split('\n')
          partial = lines.pop() ?? ''
          lines.forEach(take)
        })
        stream.on('end', () => {
          if (partial) take(partial)
        })
      }
      reader(child.stdout)
      reader(child.stderr)
      // A probe that hangs before its verdict is killed (SIGKILL), so the test
      // fails on `timedOut` with the probe's output instead of a bare test
      // timeout. The timer stops at the verdict line, because 'exit' comes only
      // after the OS has torn the process down, which on Windows can take as
      // long as this limit; a probe that hangs after its verdict fails on the
      // lifetime check outside Windows.
      const killer = setTimeout(() => {
        timedOut = child.exitCode === null && child.signalCode === null && child.kill('SIGKILL')
      }, PROBE_LIMIT_MS)
      // An error before the process got a pid is a spawn failure. Later ones
      // (a failed kill) are not the run's result, as in the probe itself.
      child.on('error', (e) => {
        if (child.pid !== undefined) return
        clearTimeout(killer)
        reject(e)
      })
      child.on('exit', () => {
        exitAt = Date.now()
      })
      child.on('close', (status) => {
        clearTimeout(killer)
        const since = (at: number | null): number | null =>
          upAt !== null && at !== null ? at - upAt : null
        resolve({
          status,
          output,
          timedOut,
          verdictMs: since(verdictAt),
          exitMs: since(exitAt)
        })
      })
    })
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A temp dir a stray handle still holds is not the test's result.
    }
  }
}

const TOOLS = ['list_clients', 'get_dashboard']

function smokeReport(
  safeStorageAsync: unknown,
  // A passing #272 sandbox probe by default, so only the safeStorage check decides.
  { sandbox }: { sandbox?: unknown } = {
    sandbox: { api: 'object', electron: 'undefined', sandboxed: true }
  }
): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'package-smoke-report-'))
  try {
    // Replace only process launch: exercise the CLI's real report checks with
    // a fake app result, without opening a GUI or using a real user profile.
    const script = join(dir, 'package-smoke.mjs')
    const source = readFileSync(SCRIPT, 'utf8').replace(
      "import { spawn } from 'node:child_process'",
      `import { EventEmitter } from 'node:events'
         function spawn(_exe, args) {
           const child = new EventEmitter()
           child.pid = 123
           const report = JSON.parse(process.env.FAKE_SMOKE_REPORT)
           writeFileSync(args[0].slice('--smoke-test='.length), JSON.stringify(report))
           process.nextTick(() => { child.emit('exit', 0, null); child.emit('close', 0, null) })
           return child
         }`
    )
    writeFileSync(script, source)
    const proc = spawnSync(process.execPath, [script, 'smoke', '--exe', process.execPath], {
      env: {
        ...process.env,
        CI: 'true',
        FAKE_SMOKE_REPORT: JSON.stringify({
          ok: true,
          schemaVersion: 34,
          pdfBytes: 2000,
          sandbox,
          safeStorageAsync
        })
      },
      encoding: 'utf8',
      timeout: PROBE_LIMIT_MS
    })
    return { status: proc.status, output: `${proc.stdout}\n${proc.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('package-smoke async safeStorage proof', () => {
  it.each([
    ['missing', undefined],
    ['failed', { ok: false, reason: 'decrypted value differs' }],
    ['skipped', { ok: false, skipped: 'OS encryption unavailable' }]
  ])('rejects a %s async encryption proof', (_label, result) => {
    const r = smokeReport(result)
    expect(r.status, r.output).toBe(1)
    expect(r.output).toContain('safeStorage async compatibility not proven')
  })

  it('accepts and reports a successful async encryption proof', () => {
    const r = smokeReport({ ok: true })
    expect(r.status, r.output).toBe(0)
    expect(r.output).toContain('safeStorage async compatibility proven')
  })
})

describe('package-smoke sandbox probe', () => {
  it('rejects a missing sandbox probe', () => {
    const r = smokeReport({ ok: true }, {})
    expect(r.status, r.output).toBe(1)
    expect(r.output).toContain('smoke report has no sandbox probe')
  })

  it('rejects a renderer that is not sandboxed', () => {
    const r = smokeReport(
      { ok: true },
      { sandbox: { api: 'object', electron: 'undefined', sandboxed: false } }
    )
    expect(r.status, r.output).toBe(1)
    expect(r.output).toContain("the app window's renderer is not sandboxed")
  })

  it('rejects a missing window.api', () => {
    const r = smokeReport(
      { ok: true },
      { sandbox: { api: 'undefined', electron: 'undefined', sandboxed: true } }
    )
    expect(r.status, r.output).toBe(1)
    expect(r.output).toContain('sandboxed preload did not expose window.api')
  })

  it('rejects an exposed window.electron', () => {
    const r = smokeReport(
      { ok: true },
      { sandbox: { api: 'object', electron: 'object', sandboxed: true } }
    )
    expect(r.status, r.output).toBe(1)
    expect(r.output).toContain('window.electron is exposed again')
  })

  it('accepts a passing sandbox probe', () => {
    const r = smokeReport({ ok: true })
    expect(r.status, r.output).toBe(0)
    expect(r.output).toContain('Smoke test passed')
  })
})

describe('package-smoke mcp probe', { timeout: PROBE_LIMIT_MS + 30_000 }, () => {
  it('passes against a server that lists every registered tool and reaches SQLite', () => {
    const r = probe('ok', TOOLS)
    expect(r.output).toContain('MCP probe passed')
    expect(r.status).toBe(0)
    // Server output is relayed, not swallowed (the H3 lesson).
    expect(r.output).toContain('[stderr] [fake] up')
  })

  it('fails when a registered tool is missing from tools/list', () => {
    const r = probe('missing-tool', TOOLS)
    expect(r.status).toBe(1)
    expect(r.output).toContain('missing [list_clients]')
  })

  it('fails when the tool call does not reach SQLite', () => {
    const r = probe('driver-broken', TOOLS)
    expect(r.status).toBe(1)
    expect(r.output).toContain('did not reach SQLite')
  })

  it('fails when the server never answers', () => {
    const r = probe('silent', TOOLS)
    expect(r.status).toBe(1)
    expect(r.output).toContain('no response to initialize')
  })

  it('fails and shows stderr when the server dies at start', () => {
    const r = probe('crash', TOOLS)
    expect(r.status).toBe(1)
    expect(r.output).toContain('[stderr] [fake] Fatal: boom')
    expect(r.output).toContain('before answering initialize')
  })

  // A POSIX case: there the descendant holds the inherited pipe descriptors and
  // 'close' waits for it. On Windows 'close' follows 'exit' at once even then
  // (measured 2026-10-23: 18 ms with the descendant alive), so this test is
  // green there with or without the pipe release; it guards on the macOS job.
  it('ends when the server is gone even if a descendant keeps its pipes open', async () => {
    const r = await probeTimed('orphan', TOOLS)
    expect(r.timedOut, r.output).toBe(false)
    expect(r.status).toBe(1)
    expect(r.output).toContain('before answering initialize')
    // The probe must neither wait for the descendant before its verdict nor
    // stay alive for it afterwards (the pipe release in giveUpOnPipes). Timed
    // from the server's first line, not around the whole probe process, which
    // also counts two Electron starts and the probe's own end (#328).
    expect(r.verdictMs).not.toBeNull()
    expect(r.verdictMs!).toBeLessThan(ORPHAN_LIMIT_MS)
    // The probe's lifetime can only hang on the pipes on POSIX (see above). On
    // Windows its 'exit' event also waits for the OS to tear the process down,
    // which took up to 90 s under load, so it is not asserted there.
    if (process.platform !== 'win32') {
      expect(r.exitMs).not.toBeNull()
      expect(r.exitMs!).toBeLessThan(ORPHAN_LIMIT_MS)
    }
  })

  it('fails with a plain message when the binary is not where the job expects it', () => {
    const r = probe('ok', TOOLS, { exe: join(tmpdir(), 'no-such-dir', 'TimeTrack.exe') })
    expect(r.status).toBe(1)
    expect(r.output).toContain('ERROR: binary not found at')
  })

  it('fails with a plain message when the binary exists but cannot be started', () => {
    // A text file: not an executable image on Windows, no exec bit on macOS.
    const dir = mkdtempSync(join(tmpdir(), 'package-smoke-exe-'))
    try {
      const notAnApp = join(dir, 'TimeTrack.exe')
      writeFileSync(notAnApp, 'not a program\n')
      const r = probe('ok', TOOLS, { exe: notAnApp })
      expect(r.status).toBe(1)
      expect(r.output).toContain(`ERROR: could not start ${notAnApp}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads every tool the real server source registers', () => {
    // A looser pattern than the probe's: if the probe's extraction ever misses
    // a registration (other quotes, a new call shape), the counts disagree or
    // the fake lists a tool the probe did not expect.
    const source = readFileSync(join(REPO_ROOT, 'src', 'mcp', 'server.ts'), 'utf8')
    const calls = source.split('registerTool(').length - 1
    const names = [...source.matchAll(/registerTool\(\s*['"`]([^'"`]+)/g)].map((m) => m[1])
    expect(names.length).toBe(calls)
    expect(names.length).toBeGreaterThan(0)
    const r = probe('ok', names, { source: join(REPO_ROOT, 'src', 'mcp', 'server.ts') })
    expect(r.output).toContain(`tools/list: ${names.length} tools`)
    expect(r.status).toBe(0)
  })
})

// #272: the fuse half. A fake binary is enough: the probe reads the fuse wire
// (sentinel, version, length, one byte per fuse: '1' on, '0' off) and never
// starts it. The unfused Electron in node_modules is the real-world red case.
describe('package-smoke fuses probe', () => {
  const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
  // Index: 0 RunAsNode, 1 CookieEncryption, 2 NodeOptions, 3 NodeCliInspect,
  // 4 AsarIntegrity, 5 OnlyLoadAppFromAsar, 6 V8Snapshot.
  const CONFIGURED = '1000110'

  function fuseProbe(wire: string | null): { status: number | null; output: string } {
    const dir = mkdtempSync(join(tmpdir(), 'tt-fuses-'))
    try {
      const exe = join(dir, 'fake-electron')
      const body =
        wire === null
          ? Buffer.from('no fuse wire in here')
          : Buffer.concat([
              Buffer.from('padding'),
              Buffer.from(SENTINEL),
              Buffer.from([1, wire.length]),
              Buffer.from(wire)
            ])
      writeFileSync(exe, body)
      const proc = spawnSync(process.execPath, [SCRIPT, 'fuses', '--exe', exe], {
        encoding: 'utf8',
        env: process.env
      })
      return { status: proc.status, output: `${proc.stdout}${proc.stderr}` }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('passes for the fuses electron-builder.yml sets', () => {
    const r = fuseProbe(CONFIGURED)
    expect(r.output).toContain('Fuse probe passed')
    expect(r.status).toBe(0)
  })

  it('fails when RunAsNode is off (the MCP server would not start)', () => {
    const r = fuseProbe('0' + CONFIGURED.slice(1))
    expect(r.status).toBe(1)
    expect(r.output).toContain('RunAsNode is off, expected on')
  })

  it.each([
    ['OnlyLoadAppFromAsar', 5],
    ['EnableEmbeddedAsarIntegrityValidation', 4]
  ])('fails when %s is off', (name, index) => {
    const wire = CONFIGURED.slice(0, index) + '0' + CONFIGURED.slice(index + 1)
    const r = fuseProbe(wire)
    expect(r.status).toBe(1)
    expect(r.output).toContain(`${name} is off, expected on`)
  })

  it('fails when the inspector is left on', () => {
    const r = fuseProbe('1001110')
    expect(r.status).toBe(1)
    expect(r.output).toContain('EnableNodeCliInspectArguments is on, expected off')
  })

  it('fails for a binary without a fuse wire', () => {
    const r = fuseProbe(null)
    expect(r.status).toBe(1)
    expect(r.output).toMatch(/could not read the fuse wire/)
  })

  it('agrees with electron-builder.yml', () => {
    const yml = readFileSync(join(REPO_ROOT, 'electron-builder.yml'), 'utf8')
    const block = yml.slice(yml.indexOf('electronFuses:'))
    expect(block).toMatch(/\n\s+runAsNode: true/)
    expect(block).toMatch(/\n\s+onlyLoadAppFromAsar: true/)
    expect(block).toMatch(/\n\s+enableEmbeddedAsarIntegrityValidation: true/)
    expect(block).toMatch(/\n\s+enableNodeCliInspectArguments: false/)
    expect(block).toMatch(/\n\s+enableNodeOptionsEnvironmentVariable: false/)
  })
})
