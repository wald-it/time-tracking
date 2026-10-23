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
    const covers = body.search(/\n\s*if \(approval\.covers\(op\)\) return true/)
    const dialog = body.indexOf('showMessageBox')
    expect(silent).toBeGreaterThan(-1)
    expect(covers).toBeGreaterThan(silent)
    expect(dialog).toBeGreaterThan(covers)
  })

  it('grants only on an approved dialog with "remember" or in session mode', () => {
    expect(body).toMatch(
      /\n\s*if \(approved && \(mode === 'session' \|\| res\.checkboxChecked\)\) approval\.grant\(\)/
    )
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
    const w = new ApprovalWindow(clock().now)
    expect(w.covers('start_timer')).toBe(false)
    expect(w.covers('stop_running_timer')).toBe(false)
  })

  it('covers start and stop once granted', () => {
    const w = new ApprovalWindow(clock().now)
    w.grant()
    expect(w.covers('start_timer')).toBe(true)
    expect(w.covers('stop_running_timer')).toBe(true)
  })

  it('never covers adding or changing an entry', () => {
    const w = new ApprovalWindow(clock().now)
    w.grant()
    expect(w.covers('create_manual_entry')).toBe(false)
    expect(w.covers('update_entry_fields')).toBe(false)
  })

  it('ends after the time window', () => {
    const c = clock()
    const w = new ApprovalWindow(c.now)
    w.grant()
    c.advance(APPROVAL_WINDOW_MS - 1)
    expect(w.covers('start_timer')).toBe(true)
    c.advance(1)
    expect(w.covers('start_timer')).toBe(false)
  })

  it('ends after the write budget', () => {
    const w = new ApprovalWindow(clock().now)
    w.grant()
    for (let i = 0; i < APPROVAL_MAX_WRITES; i++) expect(w.covers('start_timer')).toBe(true)
    expect(w.covers('stop_running_timer')).toBe(false)
    expect(w.active).toBe(false)
  })

  it('a refused op does not use the budget', () => {
    const w = new ApprovalWindow(clock().now)
    w.grant()
    for (let i = 0; i < 5; i++) w.covers('create_manual_entry')
    for (let i = 0; i < APPROVAL_MAX_WRITES; i++) expect(w.covers('stop_running_timer')).toBe(true)
  })

  it('a new grant starts a fresh window and budget; reset ends it', () => {
    const c = clock()
    const w = new ApprovalWindow(c.now)
    w.grant()
    for (let i = 0; i < APPROVAL_MAX_WRITES; i++) w.covers('start_timer')
    c.advance(APPROVAL_WINDOW_MS)
    w.grant()
    expect(w.covers('start_timer')).toBe(true)
    w.reset()
    expect(w.covers('start_timer')).toBe(false)
  })
})
