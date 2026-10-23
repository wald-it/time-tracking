/**
 * MCP write bridge (Electron side).
 *
 * Hosts a local IPC endpoint (named pipe on Windows, unix socket elsewhere)
 * that the standalone MCP server connects to for WRITE operations. Every
 * request is authenticated by a token and runs through the guarded
 * `handleRequest` core, which executes mutations via the shared entry-mutation
 * functions against the live main-process DB handle. Reads never touch this —
 * they go directly against the read-only SQLite connection in the MCP process.
 *
 * Lifecycle: started in `whenReady` (and on the write-enable toggle) only on
 * the primary instance; torn down on `will-quit` / disable. See index.ts.
 */
import net from 'net'
import { existsSync, unlinkSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { randomBytes } from 'crypto'
import { dirname } from 'path'
import { dialog, type BrowserWindow } from 'electron'
import log from 'electron-log/main'
import type Database from 'better-sqlite3'
import { getDbPath } from './db'
import { createBackup } from './backup'
import { auditWrite } from './mcpAudit'
import { handleRequest, type BridgeCtx, type BridgeRequest, type WriteOp } from './mcpBridgeCore'
import { APPROVABLE_OPS, ApprovalWindow } from './mcpApproval'
import { emitWebhooks, eventForWriteOp } from './webhooks'
import { logWebhookDelivery } from './webhookLog'
import { socketPathForDir, tokenPathForDir, controllerTokenPathForDir } from '../mcp/socketPath'
import { mcpConfirmDialog } from './mainI18n'
import type { Locale } from '../shared/i18n'

export interface BridgeDeps {
  getDb: () => Database.Database
  refreshTray: () => void
  broadcast: (channel: string, payload?: unknown) => void
  getMainWindow: () => BrowserWindow | null
  getSetting: (key: string) => string | undefined
}

let server: net.Server | null = null
let deps: BridgeDeps | null = null
// #301: "remember" and the 'session' mode approve start/stop for a bounded
// window; reset whenever the bridge (re)starts.
const approval = new ApprovalWindow()
let backupDone = false

// Anchor token + socket on the DIRECTORY OF THE DB the app actually uses
// (getDbPath() === <userData>/timetrack.sqlite). The MCP side derives the same
// paths from dirname(resolveDbPath()), so both agree as long as the MCP server
// points at the app's real DB (see socketPath.ts / README).
function endpointDir(): string {
  return dirname(getDbPath())
}
function tokenPath(): string {
  return tokenPathForDir(endpointDir())
}
function controllerTokenPath(): string {
  return controllerTokenPathForDir(endpointDir())
}
function sockPath(): string {
  return socketPathForDir(endpointDir())
}

function generateTokenFile(path: string): string {
  const token = randomBytes(32).toString('hex')
  writeFileSync(path, token, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // chmod is a no-op / unsupported on Windows — the token still isn't shared.
  }
  return token
}

function clearTokenFile(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // ignore
  }
}

function readTokenFile(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8').trim() : null
  } catch {
    return null
  }
}

/** Generate + persist a fresh write token (mode 0600). Returns it. */
export function generateWriteToken(): string {
  return generateTokenFile(tokenPath())
}

/** Delete the token file (on disable). */
export function clearWriteToken(): void {
  clearTokenFile(tokenPath())
}

/** Mint a fresh controller token (#133; per app run / on enable, like the write token). */
export function generateControllerToken(): string {
  return generateTokenFile(controllerTokenPath())
}

/** Delete the controller token file (on disable). */
export function clearControllerToken(): void {
  clearTokenFile(controllerTokenPath())
}

function confirmMode(): 'per-write' | 'session' | 'silent' {
  const v = deps?.getSetting('mcp_write_confirm_mode')
  return v === 'silent' || v === 'session' ? v : 'per-write'
}

/**
 * Native confirm honouring per-write / session / silent + "remember".
 * 'silent' never asks (choosing it takes its own native confirmation). An
 * approval from "remember" or the 'session' mode covers only start and stop,
 * for 30 minutes or 20 writes (mcpApproval.ts); adding and changing an entry
 * always ask.
 */
async function confirm(summary: string, locale: Locale, op: WriteOp): Promise<boolean> {
  const mode = confirmMode()
  if (mode === 'silent') return true
  if (approval.covers(op, mode)) return true

  const win = deps?.getMainWindow() ?? null
  if (win) {
    if (!win.isVisible()) win.show()
    win.focus()
  }
  // Only start and stop can be approved for a while: only their dialog
  // offers "remember", and in session mode only their approval grants it.
  const approvable = APPROVABLE_OPS.has(op)
  const opts = mcpConfirmDialog(locale, summary, approvable && mode === 'per-write')
  const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  const approved = res.response === 1
  // A mode change while the dialog was open already ended any approval; the
  // answer to the old dialog must not start a new one.
  if (approved && approvable && (mode === 'session' || res.checkboxChecked)) {
    if (confirmMode() === mode) approval.grant(mode)
  }
  return approved
}

/** #301: end any start/stop approval (write access off, confirm mode changed). */
export function forgetMcpApproval(): void {
  approval.reset()
}

async function ensureBackup(): Promise<void> {
  if (backupDone) return
  backupDone = true // set first so concurrent requests don't double-snapshot
  try {
    await createBackup(deps!.getDb(), 'mcp')
  } catch (e) {
    log.warn('[mcp-bridge] pre-write backup failed', e)
  }
}

function buildCtx(): BridgeCtx {
  return {
    db: deps!.getDb(),
    token: readTokenFile(tokenPath()),
    isWriteEnabled: () => deps!.getSetting('mcp_write_enabled') === '1',
    controllerToken: readTokenFile(controllerTokenPath()),
    isControllerEnabled: () => deps!.getSetting('controller_enabled') === '1',
    confirm,
    ensureBackup,
    audit: auditWrite,
    onChange: () => {
      deps!.broadcast('data:changed')
      deps!.refreshTray()
    },
    // Outbound webhooks for writes coming through the MCP bridge (#134).
    emitWebhook: (op, entry) =>
      emitWebhooks(deps!.getDb(), eventForWriteOp(op), entry, { log: logWebhookDelivery })
  }
}

function onConnection(conn: net.Socket): void {
  let buf = ''
  // Serialise requests on a connection so modal confirm dialogs don't stack.
  let chain: Promise<void> = Promise.resolve()

  conn.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      chain = chain.then(() => processLine(line, conn))
    }
  })
  conn.on('error', () => {
    /* client went away — nothing to do */
  })
}

async function processLine(line: string, conn: net.Socket): Promise<void> {
  let req: BridgeRequest
  try {
    req = JSON.parse(line)
  } catch {
    writeLine(conn, { ok: false, error: 'Ungültiges JSON', code: 'invalid' })
    return
  }
  try {
    const res = await handleRequest(buildCtx(), req)
    writeLine(conn, res)
  } catch (e) {
    log.error('[mcp-bridge] request failed', e)
    writeLine(conn, { ok: false, error: String(e), code: 'invalid' })
  }
}

function writeLine(conn: net.Socket, obj: unknown): void {
  try {
    conn.write(JSON.stringify(obj) + '\n')
  } catch {
    // socket closed mid-flight
  }
}

/** Start the bridge. Idempotent. Call only on the primary instance.
 *  Token files are managed by the callers (index.ts) per enabled scope. */
export function startMcpBridge(d: BridgeDeps): void {
  if (server) return
  deps = d
  approval.reset()
  backupDone = false

  const p = sockPath()
  if (process.platform !== 'win32' && existsSync(p)) {
    try {
      unlinkSync(p)
    } catch {
      // stale socket removal best-effort
    }
  }
  const srv = net.createServer(onConnection)
  srv.on('error', (e) => {
    log.error('[mcp-bridge] server error', e)
    server = null
  })
  srv.listen(p, () => log.info('[mcp-bridge] write bridge listening on', p))
  server = srv
}

/** Stop the bridge and clean up the socket file. Idempotent. */
export function stopMcpBridge(): void {
  if (server) {
    try {
      server.close()
    } catch {
      // ignore
    }
    server = null
  }
  if (process.platform !== 'win32') {
    const p = sockPath()
    if (existsSync(p)) {
      try {
        unlinkSync(p)
      } catch {
        // ignore
      }
    }
  }
}
