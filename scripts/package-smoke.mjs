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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function parseArgs(argv) {
  const [command, ...rest] = argv
  const opts = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]
    if (!key?.startsWith('--') || rest[i + 1] === undefined) {
      throw new Error(`bad argument near "${key ?? ''}"`)
    }
    opts[key.slice(2)] = rest[i + 1]
  }
  return { command, opts }
}

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

/** Tool names registered in the server source, in source order. */
function expectedToolNames(source) {
  return [...source.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1])
}

async function runSmoke(exe, timeoutMs) {
  // Starting the GUI app outside CI could collide with a running TimeTrack
  // (single-instance lock, MCP pipe) — the runner is the only place for it.
  if (process.env.CI !== 'true') fail('the smoke subcommand only runs in CI (CI=true)')
  const dir = mkdtempSync(join(tmpdir(), 'tt-package-smoke-'))
  const out = join(dir, 'smoke.json')
  console.log(`Running smoke test: ${exe} --smoke-test=${out}`)
  const child = spawn(exe, [`--smoke-test=${out}`], { stdio: 'inherit' })
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve('timeout')
    }, timeoutMs)
    child.on('exit', (c, signal) => {
      clearTimeout(timer)
      resolve(signal ? 1 : (c ?? 1))
    })
  })
  if (code === 'timeout') fail(`smoke test timed out after ${timeoutMs} ms`)
  let report
  try {
    report = JSON.parse(readFileSync(out, 'utf8'))
  } catch {
    fail(`smoke test exited with ${code} and wrote no readable report at ${out}`)
  }
  console.log(`Smoke result: ${JSON.stringify(report)}`)
  if (code !== 0) fail(`smoke test exited with code ${code}`)
  if (!report.ok) fail(`smoke test reported ok=false: ${report.error}`)
  if (!(report.schemaVersion >= 3)) fail(`expected schemaVersion >= 3, got ${report.schemaVersion}`)
  if (!(report.pdfBytes >= 1000)) fail(`expected pdfBytes >= 1000, got ${report.pdfBytes}`)
  console.log(
    `Smoke test passed (schema v${report.schemaVersion}, Electron ${report.electronVersion ?? '?'}, PDF ${report.pdfBytes} bytes)`
  )
  rmSync(dir, { recursive: true, force: true })
}

async function runMcp(exe, entry, expected, timeoutMs) {
  const dir = mkdtempSync(join(tmpdir(), 'tt-package-mcp-'))
  const dbPath = join(dir, 'empty.sqlite')
  // A zero-byte file is a valid, empty SQLite database.
  writeFileSync(dbPath, '')
  const child = spawn(exe, [entry], {
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
  let stdoutRest = ''
  let exited = null
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdoutRest += chunk
    let nl
    while ((nl = stdoutRest.indexOf('\n')) >= 0) {
      const line = stdoutRest.slice(0, nl).trim()
      stdoutRest = stdoutRest.slice(nl + 1)
      if (!line) continue
      console.log(
        `[stdout] ${line.length > 300 ? `${line.slice(0, 300)}… (${line.length} chars)` : line}`
      )
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id !== undefined) {
        responses.set(msg.id, msg)
        waiters.get(msg.id)?.()
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/)) if (line.trim()) console.log(`[stderr] ${line}`)
  })
  child.on('exit', (code, signal) => {
    exited = { code, signal }
    for (const w of waiters.values()) w()
  })

  const deadline = Date.now() + timeoutMs
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`)
  const request = (id, method, params) => {
    send({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no response to ${method} within ${timeoutMs} ms`)),
        Math.max(0, deadline - Date.now())
      )
      waiters.set(id, () => {
        clearTimeout(timer)
        waiters.delete(id)
        if (responses.has(id)) resolve(responses.get(id))
        else
          reject(new Error(`server exited (${JSON.stringify(exited)}) before answering ${method}`))
      })
      if (exited) waiters.get(id)()
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
      throw new Error(`initialize: unexpected answer ${JSON.stringify(init)}`)
    }
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })

    const list = await request(2, 'tools/list', {})
    const names = (list.result?.tools ?? []).map((t) => t.name)
    const missing = expected.filter((n) => !names.includes(n))
    const extra = names.filter((n) => !expected.includes(n))
    if (missing.length || extra.length || names.length === 0) {
      throw new Error(
        `tools/list: ${names.length} tools; missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`
      )
    }
    console.log(`tools/list: ${names.length} tools (${names.join(', ')})`)

    const call = await request(3, 'tools/call', { name: 'list_clients', arguments: {} })
    const text = call.result?.content?.map((c) => c.text).join(' ') ?? JSON.stringify(call)
    if (!/no such table/i.test(text)) {
      throw new Error(`tools/call list_clients did not reach SQLite: ${text}`)
    }
    console.log('tools/call list_clients: SQLite answered "no such table" (driver loaded)')
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e)
  }

  child.stdin.end()
  if (!exited) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 5000)
      child.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  console.log(`MCP server exit: ${JSON.stringify(exited)}`)
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  if (problem) fail(problem)
  console.log('MCP probe passed')
}

let parsed
try {
  parsed = parseArgs(process.argv.slice(2))
} catch (e) {
  fail(`${e.message}\nusage: package-smoke.mjs smoke|mcp --exe <binary> [...]`)
}
const { command, opts } = parsed
if (!opts.exe) fail('--exe is required')
const timeoutMs = Number(opts['timeout-ms'] ?? (command === 'smoke' ? 60000 : 30000))

if (command === 'smoke') {
  await runSmoke(opts.exe, timeoutMs)
} else if (command === 'mcp') {
  if (!opts.entry) fail('--entry is required for mcp')
  const expected = expectedToolNames(
    readFileSync(opts['server-source'] ?? 'src/mcp/server.ts', 'utf8')
  )
  if (expected.length === 0) fail('found no registerTool() calls in the server source')
  await runMcp(opts.exe, opts.entry, expected, timeoutMs)
} else {
  fail(`unknown subcommand "${command ?? ''}" (expected smoke or mcp)`)
}
