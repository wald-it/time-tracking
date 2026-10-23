/**
 * #301 — the bounded MCP write approval.
 *
 * "Remember" in the confirmation dialog, and the 'session' confirm mode,
 * used to approve every later write until the app restarted. Now an approval
 * covers only starting and stopping the timer, and only for a while: until
 * APPROVAL_WINDOW_MS has passed or APPROVAL_MAX_WRITES writes have used it,
 * whichever comes first. Then TimeTrack asks again. Adding or changing an
 * entry always asks (owner decision, 2026-10-23).
 *
 * The budget counts approved calls, not successful writes: a call the bridge
 * lets through and that then fails (the timer changed since the preview, or
 * nothing ran to stop) still uses one. That keeps the bound simple and errs
 * towards asking sooner.
 *
 * The window runs on a monotonic clock, so setting the system clock back
 * cannot stretch it. An approval also holds only for the confirm mode it was
 * granted under: switching to "ask on every change" ends it at once.
 *
 * Electron-free and clock-injected, so the bounds are testable.
 */
export const APPROVAL_WINDOW_MS = 30 * 60 * 1000
export const APPROVAL_MAX_WRITES = 20

/** The writes an approval may cover; everything else always asks. */
export const APPROVABLE_OPS: ReadonlySet<string> = new Set(['start_timer', 'stop_running_timer'])

export class ApprovalWindow {
  private until = 0
  private writesLeft = 0
  private mode: string | null = null

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Approve start and stop for the next window, under confirm mode `mode`. */
  grant(mode: string): void {
    this.until = this.now() + APPROVAL_WINDOW_MS
    this.writesLeft = APPROVAL_MAX_WRITES
    this.mode = mode
  }

  /** Forget the approval (bridge restart, write access switched off). */
  reset(): void {
    this.until = 0
    this.writesLeft = 0
    this.mode = null
  }

  /** Whether an approval is in force right now under confirm mode `mode`. */
  activeFor(mode: string): boolean {
    return this.mode === mode && this.writesLeft > 0 && this.now() < this.until
  }

  /**
   * True when the approval covers `op` under the current confirm `mode`
   * without a dialog; that use counts against the budget. False for an op it
   * never covers, after a mode change, or once the window or the budget is
   * used up.
   */
  covers(op: string, mode: string): boolean {
    if (!APPROVABLE_OPS.has(op) || !this.activeFor(mode)) return false
    this.writesLeft--
    return true
  }
}
