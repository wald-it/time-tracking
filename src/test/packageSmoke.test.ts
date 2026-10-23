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
 * The `smoke` subcommand starts the GUI app and refuses to run outside CI, so
 * it has no test here; its checks mirror the release jobs.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'package-smoke.mjs')

const FAKE_SERVER = `
const { existsSync } = require('fs')
const mode = process.env.FAKE_MODE
const tools = process.env.FAKE_TOOLS.split(',')
process.stderr.write('[fake] up\\n')
if (mode === 'orphan') {
  // Dies at start but leaves a descendant holding its stdout and stderr, the
  // way a helper process of a packaged app can. It outlives the test's limit
  // for the whole probe run (PROBE_LIMIT_MS), so only a probe that lets go of
  // the pipes ends before that limit kills it.
  require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 150000)'], {
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
 * probe's 5 s kill fallback plus its 2 s drain grace at the end.
 */
const PROBE_LIMIT_MS = 90_000

function probe(
  mode: string,
  tools: string[],
  opts: { source?: string; exe?: string } = {}
): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'package-smoke-test-'))
  try {
    const server = join(dir, 'server.js')
    const source = join(dir, 'server.ts')
    writeFileSync(server, FAKE_SERVER)
    writeFileSync(
      source,
      tools.map((n) => `server.registerTool(\n  '${n}',\n  {},\n  async () => ({})\n)\n`).join('')
    )
    // The suite runs on the Electron binary in Node mode, so process.execPath
    // stands in for the packaged app binary; the probe sets Node mode itself.
    const proc = spawnSync(
      process.execPath,
      [
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
      ],
      {
        env: { ...process.env, FAKE_MODE: mode, FAKE_TOOLS: tools.join(',') },
        encoding: 'utf8',
        timeout: PROBE_LIMIT_MS
      }
    )
    return { status: proc.status, output: `${proc.stdout}\n${proc.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const TOOLS = ['list_clients', 'get_dashboard']

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
  it('ends when the server is gone even if a descendant keeps its pipes open', () => {
    const r = probe('orphan', TOOLS)
    // A probe that waited for the descendant (150 s) would be killed by the
    // PROBE_LIMIT_MS timeout: status null and none of its own output. No
    // stopwatch here — under load a correct run can take many seconds.
    expect(r.status).toBe(1)
    expect(r.output).toContain('before answering initialize')
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
