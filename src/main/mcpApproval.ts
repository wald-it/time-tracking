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
 * Electron-free and clock-injected, so the bounds are testable.
 */
export const APPROVAL_WINDOW_MS = 30 * 60 * 1000
export const APPROVAL_MAX_WRITES = 20

/** The writes an approval may cover; everything else always asks. */
export const APPROVABLE_OPS: ReadonlySet<string> = new Set(['start_timer', 'stop_running_timer'])

export class ApprovalWindow {
  private until = 0
  private writesLeft = 0

  constructor(private readonly now: () => number = Date.now) {}

  /** Approve start and stop for the next window. */
  grant(): void {
    this.until = this.now() + APPROVAL_WINDOW_MS
    this.writesLeft = APPROVAL_MAX_WRITES
  }

  /** Forget the approval (bridge restart, write access switched off). */
  reset(): void {
    this.until = 0
    this.writesLeft = 0
  }

  /** Whether an approval is in force right now (for any op). */
  get active(): boolean {
    return this.writesLeft > 0 && this.now() < this.until
  }

  /**
   * True when the approval covers `op` without a dialog; that use counts
   * against the write budget. False for an op it never covers, or once the
   * window or the budget is used up.
   */
  covers(op: string): boolean {
    if (!APPROVABLE_OPS.has(op) || !this.active) return false
    this.writesLeft--
    return true
  }
}
