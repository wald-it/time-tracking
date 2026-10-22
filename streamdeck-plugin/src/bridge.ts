/**
 * Client for TimeTrack's local control bridge (controller scope, #133).
 *
 * Mirrors src/mcp/writeClient.ts in the app repo: connect to the named pipe
 * (Windows) or unix socket (macOS/Linux) hosted by the running TimeTrack app,
 * authenticate with the controller token file, send one newline-delimited JSON
 * request and resolve the single JSON response. The plugin never touches the
 * database — every mutation runs through the app's validated handlers.
 *
 * Paths must match src/mcp/socketPath.ts:
 *   Windows : \\.\pipe\timetrack-mcp,  %APPDATA%\time-tracking\controller.token
 *   macOS   : <userData>/mcp.sock,     <userData>/controller.token
 *   (userData is `time-tracking`, the Electron app.getName() — NOT `TimeTrack`.)
 */
import net from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface BridgeResult {
  ok: boolean
  data?: unknown
  error?: string
  code?: string
}

export interface RunningTimer {
  id: number
  client_id: number
  project_id: number | null
  description: string
  started_at: string
  client_name: string
  project_name: string | null
}

export interface TargetClient {
  id: number
  name: string
  color: string
  projects: Array<{ id: number; name: string }>
}

const APP_DIR = 'time-tracking'
const WIN_PIPE = '\\\\.\\pipe\\timetrack-mcp'
// Controller ops never wait on a confirm dialog — a short deadline keeps a
// dead app from freezing the key for minutes.
const RESPONSE_DEADLINE_MS = 10_000

function userDataDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), APP_DIR)
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_DIR)
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), APP_DIR)
}

function socketPath(): string {
  return process.platform === 'win32' ? WIN_PIPE : join(userDataDir(), 'mcp.sock')
}

function tokenPath(): string {
  return join(userDataDir(), 'controller.token')
}

export const UNAVAILABLE =
  'TimeTrack is not running or hardware keys are disabled (Settings → Integrations).'

export function sendRequest(op: string, args: Record<string, unknown> = {}): Promise<BridgeResult> {
  return new Promise((resolve) => {
    const tokenFile = tokenPath()
    if (!existsSync(tokenFile)) {
      resolve({ ok: false, error: UNAVAILABLE, code: 'unavailable' })
      return
    }
    let token: string
    try {
      token = readFileSync(tokenFile, 'utf8').trim()
    } catch {
      resolve({ ok: false, error: UNAVAILABLE, code: 'unavailable' })
      return
    }

    let buf = ''
    let done = false
    const conn = net.createConnection(socketPath())
    const timer = setTimeout(() => {
      finish({ ok: false, error: 'Timed out talking to TimeTrack.', code: 'timeout' })
    }, RESPONSE_DEADLINE_MS)

    function finish(r: BridgeResult): void {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        conn.destroy()
      } catch {
        // ignore
      }
      resolve(r)
    }

    conn.on('connect', () => {
      conn.write(JSON.stringify({ v: 1, token, op, args }) + '\n')
    })
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const idx = buf.indexOf('\n')
      if (idx >= 0) {
        try {
          finish(JSON.parse(buf.slice(0, idx)) as BridgeResult)
        } catch {
          finish({ ok: false, error: 'Invalid response from TimeTrack.' })
        }
      }
    })
    conn.on('error', () => finish({ ok: false, error: UNAVAILABLE, code: 'unavailable' }))
    conn.on('close', () => finish({ ok: false, error: UNAVAILABLE, code: 'unavailable' }))
  })
}

export async function getTimerStatus(): Promise<RunningTimer | null | 'unavailable'> {
  const res = await sendRequest('get_timer_status')
  if (!res.ok) return 'unavailable'
  return (res.data as { running: RunningTimer | null }).running
}

/**
 * One round trip for everything the dial's ambient face needs (#186): the
 * running timer plus the two totals the app's "Heute" page shows. Both come
 * from one read so they can never describe different moments.
 */
export interface Summary {
  running: RunningTimer | null
  /** Raw seconds. */
  today_seconds: number
  week_seconds: number
  /**
   * Rounding step the app applies before showing a duration; 0 = off.
   * Optional: an app older than #186's fix does not send these fields — see
   * `displayTotals()` for the fallback.
   */
  round_minutes?: number
  /**
   * What the app's "Heute" page puts on screen: raw, rounded up to
   * `round_minutes`. The dial shows these — rendering the raw seconds made it
   * disagree with the app by up to one rounding step (6:24 vs. 6:30).
   */
  /** Rounded (`pdf_round_minutes`); the dial shows the raw seconds. */
  today_rounded_seconds?: number
  week_rounded_seconds?: number
  /** Legacy name of the rounded pair, kept for older plugin builds. */
  today_display_seconds?: number
  week_display_seconds?: number
}

export async function getSummary(): Promise<Summary | 'unavailable'> {
  const res = await sendRequest('get_summary')
  if (!res.ok) return 'unavailable'
  return res.data as Summary
}

export async function listTargets(): Promise<TargetClient[] | null> {
  const res = await sendRequest('list_targets')
  if (!res.ok) return null
  return (res.data as { clients: TargetClient[] }).clients
}

export async function toggleTimer(
  clientId: number,
  projectId: number | null
): Promise<BridgeResult> {
  return sendRequest('toggle_timer', { client_id: clientId, project_id: projectId })
}
