#!/usr/bin/env node
/**
 * Smoke checks against a packaged build (#269, PR order step (i)).
 *
 * Usage:
 *   node scripts/package-smoke.mjs smoke --exe <packaged binary> [--timeout-ms 60000]
 *   node scripts/package-smoke.mjs mcp --exe <packaged binary> --entry <server.js>
 *        [--server-source src/mcp/server.ts] [--timeout-ms 30000]
 *   node scripts/package-smoke.mjs fuses --exe <packaged binary>
 *
 * `smoke` runs the app's own `--smoke-test` mode (DB + migrations + PDF in a
 * throw-away userData) and checks its JSON report — the same checks the
 * release jobs make, now on every PR.
 *
 * `mcp` starts the bundled MCP server the way an MCP client does (the app
 * binary with ELECTRON_RUN_AS_NODE=1, F&I 5) and speaks JSON-RPC to it:
 * initialize, tools/list, one tools/call. The tool names must match the
 * `registerTool('<name>'` calls in the server source, so adding a tool cannot
 * leave the probe checking a stale list. The call runs against an empty
 * database file: SQLite answers "no such table", which proves the native
 * driver loaded inside the package and executed a statement. A driver that
 * fails to load answers with a different error and turns the probe red.
 * userData (APPDATA / HOME) and the DB path point into a temp directory, so
 * the probe never sees a real TimeTrack profile.
 *
 * Every line the server writes to stdout and stderr is printed. The H3
 * sandbox probe once reported "tools (0)" without saying why; this one says.
 *
 * Guard question: what does it catch? A package whose app cannot open its
 * database or render a PDF (`smoke`), and a package whose MCP server does not
 * start in Node mode, lists other tools than the source registers, or cannot
 * load better-sqlite3 (`mcp`). Red cases are pinned in
 * src/test/packageSmoke.test.ts against a fake server.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'

class ProbeError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const opts = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]
    if (!key?.startsWith('--') || rest[i + 1] === undefined) {
      throw new ProbeError(
        `bad argument near "${key ?? ''}"\n` +
          'usage: package-smoke.mjs smoke --exe <binary> [--timeout-ms <ms>]\n' +
          '       package-smoke.mjs mcp --exe <binary> --entry <server.js> [--server-source <file>] [--timeout-ms <ms>]'
      )
    }
    opts[key.slice(2)] = rest[i + 1]
  }
  return { command, opts }
}

/** Tool names registered in the server source, in source order. */
function expectedToolNames(source) {
  return [...source.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1])
}

/**
 * Print a stream line by line with a prefix. Chunks do not end on line
 * boundaries, so the remainder is carried over and flushed when the stream
 * ends: a fatal message without a final newline is exactly the line that
 * explains a red run.
 */
function relayLines(stream, prefix, onLine = () => {}) {
  let rest = ''
  const emit = (raw) => {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) return
    console.log(
      `${prefix} ${line.length > 300 ? `${line.slice(0, 300)}… (${line.length} chars)` : line}`
    )
    onLine(line)
  }
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    rest += chunk
    let nl
    while ((nl = rest.indexOf('\n')) >= 0) {
      emit(rest.slice(0, nl))
      rest = rest.slice(nl + 1)
    }
  })
  stream.on('end', () => {
    emit(rest)
    rest = ''
  })
}

/** How long to wait for the stdio pipes to drain once the process is gone. */
const DRAIN_GRACE_MS = 2000

/**
 * Spawn. A missing binary and a synchronous spawn failure are thrown as a
 * ProbeError; an asynchronous one comes back as `ended.error`, which every
 * caller checks. `child.ended` resolves
 * with `{ code, signal, error }` once the process is gone and its output is
 * drained — or, if a grandchild keeps the pipes open so that 'close' never
 * comes, DRAIN_GRACE_MS after 'exit'. It never waits on 'close' alone. When
 * the grace runs out, the pipes are destroyed: their open handles would
 * otherwise keep this script's own process alive until the grandchild exits.
 */
function start(exe, args, options) {
  if (!existsSync(exe)) throw new ProbeError(`binary not found at ${exe}`)
  let child
  try {
    child = spawn(exe, args, options)
  } catch (error) {
    // Windows rejects a file that is not an executable image synchronously
    // (`spawn UNKNOWN`); elsewhere the same failure arrives as 'error'.
    throw startFailure(exe, { error })
  }
  child.ended = new Promise((resolve) => {
    let result = null
    let grace = null
    const finish = () => {
      clearTimeout(grace)
      resolve(result)
    }
    const giveUpOnPipes = () => {
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy()
      finish()
    }
    // An error before the process got a pid is a spawn failure. Errors after
    // that (a failed kill()) are not the run's result; the listener stays for
    // the lifetime of the child so that they cannot go unhandled either.
    child.on('error', (error) => {
      if (result || child.pid !== undefined) return
      result = { code: null, signal: null, error }
      grace = setTimeout(giveUpOnPipes, DRAIN_GRACE_MS)
    })
    child.on('exit', (code, signal) => {
      if (!result) result = { code, signal, error: null }
      clearTimeout(grace)
      grace = setTimeout(giveUpOnPipes, DRAIN_GRACE_MS)
    })
    child.on('close', (code, signal) => {
      if (!result) result = { code, signal, error: null }
      finish()
    })
  })
  return child
}

function startFailure(exe, ended) {
  return new ProbeError(`could not start ${exe}: ${ended.error.message}`)
}

async function runSmoke(dir, exe, timeoutMs) {
  // Starting the GUI app outside CI could collide with a running TimeTrack
  // (single-instance lock, MCP pipe) — the runner is the only place for it.
  if (process.env.CI !== 'true')
    throw new ProbeError('the smoke subcommand only runs in CI (CI=true)')
  const out = join(dir, 'smoke.json')
  console.log(`Running smoke test: ${exe} --smoke-test=${out}`)
  const child = start(exe, [`--smoke-test=${out}`], { stdio: 'inherit' })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)
  // Waits for the killed main process too. Electron's helper processes can
  // outlive it and keep files in `dir` open; cleanup only warns about that.
  const ended = await child.ended
  clearTimeout(timer)
  if (ended.error) throw startFailure(exe, ended)
  if (timedOut) throw new ProbeError(`smoke test timed out after ${timeoutMs} ms`)
  const code = ended.signal ? 1 : (ended.code ?? 1)
  let report
  try {
    report = JSON.parse(readFileSync(out, 'utf8'))
  } catch {
    throw new ProbeError(`smoke test exited with ${code} and wrote no readable report at ${out}`)
  }
  console.log(`Smoke result: ${JSON.stringify(report)}`)
  if (code !== 0) throw new ProbeError(`smoke test exited with code ${code}`)
  if (!report.ok) throw new ProbeError(`smoke test reported ok=false: ${report.error}`)
  if (!(report.schemaVersion >= 3)) {
    throw new ProbeError(`expected schemaVersion >= 3, got ${report.schemaVersion}`)
  }
  if (!(report.pdfBytes >= 1000)) {
    throw new ProbeError(`expected pdfBytes >= 1000, got ${report.pdfBytes}`)
  }
  // CI has no guaranteed keychain setup. A skip is evidence that the migration
  // was not tested, so it must not turn a package green.
  if (report.safeStorageAsync?.ok !== true || report.safeStorageAsync?.skipped) {
    throw new ProbeError(
      `safeStorage async compatibility not proven: ${report.safeStorageAsync?.skipped ?? report.safeStorageAsync?.reason ?? 'missing or failed result'}`
    )
  }
  console.log('safeStorage async compatibility proven')
  // #272: the app windows run sandboxed and their preload still exposes the API.
  const sandbox = report.sandbox
  if (!sandbox) throw new ProbeError('smoke report has no sandbox probe')
  if (sandbox.api !== 'object') {
    throw new ProbeError(`sandboxed preload did not expose window.api (typeof: ${sandbox.api})`)
  }
  if (sandbox.electron !== 'undefined') {
    throw new ProbeError(`window.electron is exposed again (typeof: ${sandbox.electron})`)
  }
  if (sandbox.sandboxed !== true) {
    throw new ProbeError(`the app window's renderer is not sandboxed (${sandbox.sandboxed})`)
  }
  console.log(
    `Smoke test passed (schema v${report.schemaVersion}, Electron ${report.electronVersion ?? '?'}, PDF ${report.pdfBytes} bytes)`
  )
}

async function runMcp(dir, exe, entry, expected, timeoutMs) {
  const dbPath = join(dir, 'empty.sqlite')
  // A zero-byte file is a valid, empty SQLite database.
  writeFileSync(dbPath, '')
  const child = start(exe, [entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TIMETRACK_DB_PATH: dbPath,
      APPDATA: dir,
      HOME: dir
    }
  })

  const responses = new Map()
  const waiters = new Map()
  // Set from `child.ended`, which normally waits for stdout to drain, so an
  // answer written just before the exit is not mistaken for a missing one. If
  // a grandchild holds the pipe open, it gives up after DRAIN_GRACE_MS.
  let closed = null
  relayLines(child.stdout, '[stdout]', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id !== undefined) {
      responses.set(msg.id, msg)
      waiters.get(msg.id)?.()
    }
  })
  relayLines(child.stderr, '[stderr]')
  // A server that is gone makes writes fail with EPIPE; that is reported
  // through `child.ended` below, not as an uncaught exception.
  child.stdin.on('error', () => {})
  const endedPromise = child.ended.then((result) => {
    closed = result
    for (const w of waiters.values()) w()
  })

  const deadline = Date.now() + timeoutMs
  const send = (msg) => {
    if (!closed) child.stdin.write(`${JSON.stringify(msg)}\n`)
  }
  const request = (id, method, params) => {
    send({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new ProbeError(`no response to ${method} before the ${timeoutMs} ms probe deadline`)
          ),
        Math.max(0, deadline - Date.now())
      )
      waiters.set(id, () => {
        clearTimeout(timer)
        waiters.delete(id)
        if (responses.has(id)) resolve(responses.get(id))
        else if (closed.error) reject(startFailure(exe, closed))
        else {
          const { code, signal } = closed
          reject(
            new ProbeError(
              `server exited (${JSON.stringify({ code, signal })}) before answering ${method}`
            )
          )
        }
      })
      if (closed) waiters.get(id)()
    })
  }

  let problem = null
  try {
    const init = await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'package-smoke', version: '1' }
    })
    if (init.result?.serverInfo?.name !== 'timetrack') {
      throw new ProbeError(`initialize: unexpected answer ${JSON.stringify(init)}`)
    }
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })

    const list = await request(2, 'tools/list', {})
    const names = (list.result?.tools ?? []).map((t) => t.name)
    const missing = expected.filter((n) => !names.includes(n))
    const extra = names.filter((n) => !expected.includes(n))
    if (missing.length || extra.length) {
      throw new ProbeError(
        `tools/list: ${names.length} tools; missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`
      )
    }
    console.log(`tools/list: ${names.length} tools (${names.join(', ')})`)

    const call = await request(3, 'tools/call', { name: 'list_clients', arguments: {} })
    const text = call.result?.content?.map((c) => c.text).join(' ') ?? JSON.stringify(call)
    if (!/no such table/i.test(text)) {
      throw new ProbeError(`tools/call list_clients did not reach SQLite: ${text}`)
    }
    console.log('tools/call list_clients: SQLite answered "no such table" (driver loaded)')
  } catch (e) {
    problem = e
  }

  if (!closed) child.stdin.end()
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
  await endedPromise
  clearTimeout(killTimer)
  console.log(`MCP server exit: ${JSON.stringify({ code: closed.code, signal: closed.signal })}`)
  if (problem) throw problem
  console.log('MCP probe passed')
}

/**
 * The fuses electron-builder.yml sets (#272), by FuseV1Options index. RunAsNode
 * must stay on: the MCP server and the smoke test's cleaner run the packaged
 * binary in Node mode (F&I 5). The other four close debugger, NODE_OPTIONS
 * injection and code loaded from outside the signed-off app.asar.
 */
const EXPECTED_FUSES = [
  { index: 0, name: 'RunAsNode', on: true },
  { index: 2, name: 'EnableNodeOptionsEnvironmentVariable', on: false },
  { index: 3, name: 'EnableNodeCliInspectArguments', on: false },
  { index: 4, name: 'EnableEmbeddedAsarIntegrityValidation', on: true },
  { index: 5, name: 'OnlyLoadAppFromAsar', on: true }
]

/** Fuse wire bytes: ASCII '1' (enabled) and '0' (disabled). */
const FUSE_ENABLED = 49
const FUSE_DISABLED = 48

async function runFuses(exe) {
  if (!existsSync(exe)) throw new ProbeError(`binary not found at ${exe}`)
  const { getCurrentFuseWire } = createRequire(import.meta.url)('@electron/fuses')
  let wire
  try {
    wire = await getCurrentFuseWire(exe)
  } catch (e) {
    throw new ProbeError(`could not read the fuse wire of ${exe}: ${e?.message ?? e}`)
  }
  const wrong = []
  for (const { index, name, on } of EXPECTED_FUSES) {
    const want = on ? FUSE_ENABLED : FUSE_DISABLED
    const got = wire[index]
    const shown = got === FUSE_ENABLED ? 'on' : got === FUSE_DISABLED ? 'off' : `raw ${got}`
    console.log(`fuse ${name}: ${shown} (expected ${on ? 'on' : 'off'})`)
    if (got !== want) wrong.push(`${name} is ${shown}, expected ${on ? 'on' : 'off'}`)
  }
  if (wrong.length) throw new ProbeError(`fuses not as configured: ${wrong.join('; ')}`)
  console.log('Fuse probe passed')
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2))
  if (command === 'fuses') {
    if (!opts.exe) throw new ProbeError('--exe is required')
    return runFuses(opts.exe)
  }
  if (!opts.exe) throw new ProbeError('--exe is required')
  const timeoutMs = Number(opts['timeout-ms'] ?? (command === 'smoke' ? 60000 : 30000))
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ProbeError(`--timeout-ms must be a positive number of milliseconds`)
  }
  let run
  if (command === 'smoke') {
    run = (dir) => runSmoke(dir, opts.exe, timeoutMs)
  } else if (command === 'mcp') {
    if (!opts.entry) throw new ProbeError('--entry is required for mcp')
    const expected = expectedToolNames(
      readFileSync(opts['server-source'] ?? 'src/mcp/server.ts', 'utf8')
    )
    if (expected.length === 0) {
      throw new ProbeError('found no registerTool() calls in the server source')
    }
    run = (dir) => runMcp(dir, opts.exe, opts.entry, expected, timeoutMs)
  } else {
    throw new ProbeError(`unknown subcommand "${command ?? ''}" (expected smoke, mcp or fuses)`)
  }
  const dir = mkdtempSync(join(tmpdir(), `tt-package-${command}-`))
  try {
    await run(dir)
  } finally {
    // A leftover handle must neither hide the probe's own error nor turn a
    // passing run red; the temp dir is the runner's to discard.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (e) {
      console.warn(`warning: could not remove ${dir}: ${e?.message ?? e}`)
    }
  }
}

try {
  await main()
} catch (e) {
  console.error(`ERROR: ${e instanceof ProbeError ? e.message : (e?.stack ?? String(e))}`)
  process.exitCode = 1
}
