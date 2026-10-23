/**
 * #301 — an approval covers start and stop for 30 minutes or 20 writes,
 * whichever comes first; adding and changing an entry always ask.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { APPROVAL_MAX_WRITES, APPROVAL_WINDOW_MS, ApprovalWindow } from './mcpApproval'

// mcpBridge.ts talks to Electron's dialog and is not unit-tested; its use of
// the window is pinned here, so dropping a call turns this red.
describe('mcpBridge.ts wiring', () => {
  const src = readFileSync(join(__dirname, 'mcpBridge.ts'), 'utf8')
  const body = src.slice(
    src.indexOf('async function confirm('),
    src.indexOf('async function ensureBackup')
  )

  it('silent first, then the approval, then the dialog', () => {
    const silent = body.search(/\n\s*if \(mode === 'silent'\) return true/)
    const covers = body.search(/\n\s*if \(approval\.covers\(op, mode\)\) return true/)
    const dialog = body.indexOf('showMessageBox')
    expect(silent).toBeGreaterThan(-1)
    expect(covers).toBeGreaterThan(silent)
    expect(dialog).toBeGreaterThan(covers)
  })

  it('grants only for an approved start or stop, with "remember" or in session mode', () => {
    expect(body).toMatch(/\n\s*const approvable = APPROVABLE_OPS\.has\(op\)/)
    expect(body).toMatch(
      /\n\s*if \(approved && approvable && \(mode === 'session' \|\| res\.checkboxChecked\)\) \{[\s\S]*?approval\.grantIfUnchanged\(mode, opened\)/
    )
  })

  it('offers "remember" only on a start or stop dialog in per-write mode', () => {
    expect(body).toMatch(/mcpConfirmDialog\(locale, summary, approvable && mode === 'per-write'\)/)
  })

  it('a bridge restart forgets the approval', () => {
    const start = src.slice(src.indexOf('export function startMcpBridge'))
    expect(start).toMatch(/\n\s*approval\.reset\(\)/)
  })

  it('no unbounded approval flag is left', () => {
    expect(src).not.toContain('sessionApproved')
  })
})

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

describe('ApprovalWindow', () => {
  it('covers nothing before it is granted', () => {
    const w = new ApprovalWindow(clock().now, clock().now)
    expect(w.covers('start_timer', 'session')).toBe(false)
    expect(w.covers('stop_running_timer', 'session')).toBe(false)
  })

  it('covers start and stop once granted', () => {
    const w = new ApprovalWindow(clock().now, clock().now)
    w.grant('session')
    expect(w.covers('start_timer', 'session')).toBe(true)
    expect(w.covers('stop_running_timer', 'session')).toBe(true)
  })

  it('never covers adding or changing an entry', () => {
    const w = new ApprovalWindow(clock().now, clock().now)
    w.grant('session')
    expect(w.covers('create_manual_entry', 'session')).toBe(false)
    expect(w.covers('update_entry_fields', 'session')).toBe(false)
  })

  it('ends after the time window', () => {
    const c = clock()
    const w = new ApprovalWindow(c.now, c.now)
    w.grant('session')
    c.advance(APPROVAL_WINDOW_MS - 1)
    expect(w.covers('start_timer', 'session')).toBe(true)
    c.advance(1)
    expect(w.covers('start_timer', 'session')).toBe(false)
  })

  it('ends after the write budget', () => {
    const w = new ApprovalWindow(clock().now, clock().now)
    w.grant('session')
    for (let i = 0; i < APPROVAL_MAX_WRITES; i++)
      expect(w.covers('start_timer', 'session')).toBe(true)
    expect(w.covers('stop_running_timer', 'session')).toBe(false)
    expect(w.activeFor('session')).toBe(false)
  })

  it('a refused op does not use the budget', () => {
    const w = new ApprovalWindow(clock().now, clock().now)
    w.grant('session')
    for (let i = 0; i < 5; i++) w.covers('create_manual_entry', 'session')
    for (let i = 0; i < APPROVAL_MAX_WRITES; i++)
      expect(w.covers('stop_running_timer', 'session')).toBe(true)
  })

  it('a new grant starts a fresh window and budget; reset ends it', () => {
    const c = clock()
    const w = new ApprovalWindow(c.now, c.now)
    w.grant('session')
    for (let i = 0; i < APPROVAL_MAX_WRITES; i++) w.covers('start_timer', 'session')
    c.advance(APPROVAL_WINDOW_MS)
    w.grant('session')
    expect(w.covers('start_timer', 'session')).toBe(true)
    w.reset()
    expect(w.covers('start_timer', 'session')).toBe(false)
  })
})

describe('ApprovalWindow and the confirm mode', () => {
  it('a mode change ends the approval at once', () => {
    const w = new ApprovalWindow(clock().now, clock().now)
    w.grant('session')
    expect(w.covers('start_timer', 'per-write')).toBe(false)
    expect(w.covers('start_timer', 'session')).toBe(true)
  })

  it('"remember" in per-write mode holds only while per-write stays', () => {
    const w = new ApprovalWindow(clock().now, clock().now)
    w.grant('per-write')
    expect(w.covers('stop_running_timer', 'per-write')).toBe(true)
    expect(w.covers('stop_running_timer', 'session')).toBe(false)
  })

  // Review round 2: on macOS and Linux the monotonic clock stops while the
  // machine sleeps, the wall clock does not; either one alone could be stretched.
  it('ends when the wall clock passes the window, even if the monotonic one did not (sleep)', () => {
    const wall = clock()
    const mono = clock()
    const w = new ApprovalWindow(wall.now, mono.now)
    w.grant('session')
    wall.advance(15 * 60 * 60 * 1000)
    expect(w.covers('start_timer', 'session')).toBe(false)
  })

  it('ends when the monotonic clock passes the window, even if the wall clock was set back', () => {
    const wall = clock()
    const mono = clock()
    const w = new ApprovalWindow(wall.now, mono.now)
    w.grant('session')
    wall.advance(-2 * 60 * 60 * 1000)
    mono.advance(APPROVAL_WINDOW_MS)
    expect(w.covers('start_timer', 'session')).toBe(false)
  })
})

describe('the production clocks', () => {
  // All behaviour tests inject both clocks; this pins what mcpBridge.ts gets.
  it('default to the wall clock and the monotonic clock', () => {
    const src = readFileSync(join(__dirname, 'mcpApproval.ts'), 'utf8')
    expect(src).toMatch(/private readonly wall: \(\) => number = Date\.now/)
    expect(src).toMatch(/private readonly mono: \(\) => number = \(\) => performance\.now\(\)/)
  })
})

// Codex follow-up 2: a dialog answered after resets must not grant, even when
// the confirm mode is back where it was (per-write → session → per-write).
describe('a grant from a dialog that outlived a reset', () => {
  it('two resets while the dialog was open: nothing is granted', () => {
    const w = new ApprovalWindow(clock().now, clock().now)
    const opened = w.generation
    w.reset()
    w.reset()
    expect(w.grantIfUnchanged('per-write', opened)).toBe(false)
    expect(w.covers('start_timer', 'per-write')).toBe(false)
  })

  it('a single reset while the dialog was open blocks the grant too', () => {
    const w = new ApprovalWindow(clock().now, clock().now)
    const opened = w.generation
    w.reset()
    expect(w.grantIfUnchanged('session', opened)).toBe(false)
    expect(w.covers('start_timer', 'session')).toBe(false)
  })

  it('without a reset in between, the answer grants', () => {
    const w = new ApprovalWindow(clock().now, clock().now)
    const opened = w.generation
    expect(w.grantIfUnchanged('session', opened)).toBe(true)
    expect(w.covers('start_timer', 'session')).toBe(true)
  })
})
describe('mcpBridge.ts reads the generation before the dialog', () => {
  it('opened is read before showMessageBox and used for the grant', () => {
    const src = readFileSync(join(__dirname, 'mcpBridge.ts'), 'utf8')
    const body = src.slice(
      src.indexOf('async function confirm('),
      src.indexOf('export function forgetMcpApproval')
    )
    const read = body.search(/\n\s*const opened = approval\.generation/)
    const dialog = body.indexOf('showMessageBox')
    expect(read).toBeGreaterThan(-1)
    expect(dialog).toBeGreaterThan(read)
    expect(body).not.toMatch(/approval\.grant\(mode\)/)
  })
})
