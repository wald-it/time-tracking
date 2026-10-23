#!/usr/bin/env node
/**
 * Smoke checks against a packaged build (#269, PR order step (i)).
 *
 * Usage:
 *   node scripts/package-smoke.mjs smoke --exe <packaged binary>
 *   node scripts/package-smoke.mjs mcp --exe <packaged binary> --entry <server.js>
 *        [--server-source src/mcp/server.ts] [--timeout-ms 30000]
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
import { join } from 'node:path'

class ProbeError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const opts = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]
    if (!key?.startsWith('--') || rest[i + 1] === undefined) {
      throw new ProbeError(`bad argument near "${key ?? ''}"`)
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

/** Spawn, turning a missing or non-executable binary into a ProbeError. */
function start(exe, args, options) {
  if (!existsSync(exe)) throw new ProbeError(`binary not found at ${exe}`)
  const child = spawn(exe, args, options)
  // Resolves with the spawn error, if any; 'close' still follows it.
  child.spawnError = new Promise((resolve) => child.once('error', resolve))
  return child
}

async function runSmoke(dir, exe, timeoutMs) {
  // Starting the GUI app outside CI could collide with a running TimeTrack
  // (single-instance lock, MCP pipe) — the runner is the only place for it.
  if (process.env.CI !== 'true')
    throw new ProbeError('the smoke subcommand only runs in CI (CI=true)')
  const out = join(dir, 'smoke.json')
  console.log(`Running smoke test: ${exe} --smoke-test=${out}`)
  const child = start(exe, [`--smoke-test=${out}`], { stdio: 'inherit' })
  let spawnError = null
  child.spawnError.then((e) => (spawnError = e))
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve('timeout')
    }, timeoutMs)
    child.on('close', (c, signal) => {
      clearTimeout(timer)
      resolve(signal ? 1 : (c ?? 1))
    })
  })
  if (spawnError) throw new ProbeError(`could not start ${exe}: ${spawnError.message}`)
  if (code === 'timeout') throw new ProbeError(`smoke test timed out after ${timeoutMs} ms`)
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
  // Set on 'close', which fires only after stdout and stderr are drained, so
  // an answer written just before the exit is never mistaken for a missing one.
  let closed = null
  let spawnError = null
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
  // through 'close' below, not as an uncaught exception.
  child.stdin.on('error', () => {})
  child.spawnError.then((e) => (spawnError = e))
  const closedPromise = new Promise((resolve) =>
    child.on('close', (code, signal) => {
      closed = { code, signal }
      for (const w of [...waiters.values()]) w()
      resolve()
    })
  )

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
        else if (spawnError) {
          reject(new ProbeError(`could not start ${exe}: ${spawnError.message}`))
        } else {
          reject(
            new ProbeError(`server exited (${JSON.stringify(closed)}) before answering ${method}`)
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
  await closedPromise
  clearTimeout(killTimer)
  console.log(`MCP server exit: ${JSON.stringify(closed)}`)
  if (problem) throw problem
  console.log('MCP probe passed')
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2))
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
    throw new ProbeError(`unknown subcommand "${command ?? ''}" (expected smoke or mcp)`)
  }
  const dir = mkdtempSync(join(tmpdir(), `tt-package-${command}-`))
  try {
    await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

try {
  await main()
} catch (e) {
  console.error(`ERROR: ${e instanceof ProbeError ? e.message : (e?.stack ?? String(e))}`)
  process.exitCode = 1
}
