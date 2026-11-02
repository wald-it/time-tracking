import { powerMonitor, BrowserWindow } from 'electron'
import { Console } from 'node:console'

// index.ts redirects the global console to electron-log. Keep this probe on
// stdout only: a persistent presence trace would violate Q21.
const probeConsole = new Console({ stdout: process.stdout, stderr: process.stderr })

/**
 * Polls system idle time and emits `timer:idle-detected` to the renderer
 * exactly once per idle episode. Renderer is responsible for showing the
 * modal and acknowledging via `idle:dismiss` to re-arm.
 *
 * Polling and power-event listeners only run while a timer is active.
 */
const POLL_INTERVAL_MS = 30_000

let timer: NodeJS.Timeout | null = null
let active = false
let alreadyEmitted = false
let awaySince: number | null = null
let probeEnabled = false
let thresholdSeconds = 300 // default 5 min, overridden by setThreshold
let getWindow: () => BrowserWindow | null = () => null

export function configureIdleWatcher(opts: { getWindow: () => BrowserWindow | null }): void {
  getWindow = opts.getWindow
}

export function setIdleThresholdMinutes(minutes: number): void {
  // Clamp to reasonable range (1 min to 12h).
  const clamped = Math.max(1, Math.min(720, minutes))
  thresholdSeconds = clamped * 60
}

export function startIdleWatcher(): void {
  if (active) return
  active = true
  alreadyEmitted = false
  probeEnabled = process.env.TIMETRACK_IDLE_PROBE === '1'
  powerMonitor.on('suspend', onAway)
  powerMonitor.on('lock-screen', onAway)
  powerMonitor.on('resume', onResume)
  powerMonitor.on('unlock-screen', onUnlock)
  if (timer) clearInterval(timer)
  timer = setInterval(check, POLL_INTERVAL_MS)
}

export function stopIdleWatcher(): void {
  active = false
  alreadyEmitted = false
  // A stopped timer must not carry a pending absence into the next run.
  awaySince = null
  powerMonitor.removeListener('suspend', onAway)
  powerMonitor.removeListener('lock-screen', onAway)
  powerMonitor.removeListener('resume', onResume)
  powerMonitor.removeListener('unlock-screen', onUnlock)
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** Renderer dismisses the modal — re-arm so the next idle episode can fire. */
export function rearmIdleWatcher(): void {
  alreadyEmitted = false
  // Keep awaySince: an absence that is still ongoing stays pending.
}

function onAway(): void {
  if (awaySince === null) awaySince = Date.now()
}

function onResume(): void {
  onReturn('resume')
}

function onUnlock(): void {
  onReturn('unlock-screen')
}

function onReturn(event: 'resume' | 'unlock-screen'): void {
  if (awaySince === null) return
  const startedAt = awaySince
  const awaySeconds = Math.floor((Date.now() - startedAt) / 1000)
  awaySince = null
  if (awaySeconds >= thresholdSeconds) emit(startedAt, awaySeconds, event)
}

function emit(idleSinceMs: number, idleSeconds: number, path: string): void {
  if (!active || alreadyEmitted) return
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    const idleSince = new Date(idleSinceMs).toISOString()
    win.webContents.send('timer:idle-detected', { idleSince, idleSeconds })
    alreadyEmitted = true
    if (probeEnabled) probeConsole.log(`[idle-probe] ${path} ${new Date().toISOString()}`)
  }
}

function check(): void {
  if (!active || alreadyEmitted) return
  const idleSeconds = powerMonitor.getSystemIdleTime()
  if (idleSeconds >= thresholdSeconds) {
    emit(Date.now() - idleSeconds * 1000, idleSeconds, 'poll')
  }
}
