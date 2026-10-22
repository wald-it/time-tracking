/**
 * Tests for the timer dial's model (#186) — the part that decides what the
 * wheel lands on and what a press starts. No SDK, no bridge, no device.
 */
import { describe, it, expect, vi } from 'vitest'
import type { TargetClient } from './bridge'
import {
  buildTargets,
  clientOnly,
  createPressGesture,
  displayTotals,
  elapsedSeconds,
  formatHm,
  indexOfKey,
  isRunning,
  step,
  targetKey
} from './dialModel'

const CLIENTS: TargetClient[] = [
  {
    id: 1,
    name: 'Acme',
    color: '#ff0000',
    projects: [
      { id: 10, name: 'Rollout' },
      { id: 11, name: 'Support' }
    ]
  },
  { id: 2, name: 'Beta', color: '#00ff00', projects: [] },
  { id: 3, name: 'Gamma', color: '#0000ff', projects: [{ id: 30, name: 'Audit' }] }
]

describe('buildTargets', () => {
  it('lists projects, and clients only when they have none', () => {
    const targets = buildTargets(CLIENTS)
    expect(targets.map((t) => `${t.clientName}/${t.projectName ?? '—'}`)).toEqual([
      'Acme/Rollout',
      'Acme/Support',
      'Beta/—',
      'Gamma/Audit'
    ])
    // Acme has projects, so it must NOT also appear on its own — that entry
    // is what the long press is for.
    expect(targets.filter((t) => t.clientId === 1 && t.projectId === null)).toEqual([])
  })

  it('keeps the bridge order and carries the client colour', () => {
    const targets = buildTargets(CLIENTS)
    expect(targets[0].color).toBe('#ff0000')
    expect(targets[2].color).toBe('#00ff00')
  })

  it('is empty for an empty client list', () => {
    expect(buildTargets([])).toEqual([])
  })
})

describe('clientOnly', () => {
  it('drops the project — what a long press starts', () => {
    const [rollout] = buildTargets(CLIENTS)
    const bare = clientOnly(rollout)
    expect(bare).toMatchObject({ clientId: 1, projectId: null, clientName: 'Acme' })
    expect(bare.key).toBe(targetKey(1, null))
  })

  it('is the identity on a client that has no projects', () => {
    const beta = buildTargets(CLIENTS)[2]
    expect(clientOnly(beta)).toBe(beta)
  })
})

describe('indexOfKey', () => {
  it('re-finds the selection after the list changed above it', () => {
    const before = buildTargets(CLIENTS)
    const selected = before[2].key // Beta
    // A new project appears on Acme, pushing everything down by one.
    const after = buildTargets([
      {
        ...CLIENTS[0],
        projects: [{ id: 9, name: 'Aufmass' }, ...CLIENTS[0].projects]
      },
      CLIENTS[1],
      CLIENTS[2]
    ])
    expect(indexOfKey(before, selected)).toBe(2)
    expect(indexOfKey(after, selected)).toBe(3)
    expect(after[3].clientName).toBe('Beta')
  })

  it('falls back to the top for an unknown or missing key', () => {
    const targets = buildTargets(CLIENTS)
    expect(indexOfKey(targets, '999:')).toBe(0)
    expect(indexOfKey(targets, undefined)).toBe(0)
  })
})

describe('step', () => {
  it('wraps in both directions', () => {
    expect(step(0, 1, 4)).toBe(1)
    expect(step(3, 1, 4)).toBe(0)
    expect(step(0, -1, 4)).toBe(3)
    expect(step(0, -6, 4)).toBe(2)
    expect(step(1, 9, 4)).toBe(2)
  })

  it('stays at 0 without entries', () => {
    expect(step(0, 3, 0)).toBe(0)
  })
})

describe('isRunning', () => {
  const [rollout, , beta] = buildTargets(CLIENTS)
  const running = {
    id: 1,
    client_id: 1,
    project_id: 10,
    description: '',
    started_at: '2026-08-02T09:00:00.000Z',
    client_name: 'Acme',
    project_name: 'Rollout'
  }

  it('matches on client AND project', () => {
    expect(isRunning(rollout, running)).toBe(true)
    expect(isRunning(beta, running)).toBe(false)
    expect(isRunning(rollout, null)).toBe(false)
  })

  it('does not confuse "client without project" with "client with project"', () => {
    expect(isRunning(clientOnly(rollout), running)).toBe(false)
    expect(isRunning(clientOnly(rollout), { ...running, project_id: null })).toBe(true)
  })
})

describe('formatHm / elapsedSeconds', () => {
  it('formats h:mm and never goes negative', () => {
    expect(formatHm(0)).toBe('0:00')
    expect(formatHm(59)).toBe('0:00')
    expect(formatHm(3599)).toBe('0:59')
    expect(formatHm(3600)).toBe('1:00')
    expect(formatHm(45296)).toBe('12:34')
    expect(formatHm(-5)).toBe('0:00')
  })

  it('measures from started_at, clamps a clock that ran backwards', () => {
    const now = Date.parse('2026-08-02T10:00:00.000Z')
    expect(elapsedSeconds('2026-08-02T09:30:00.000Z', now)).toBe(1800)
    expect(elapsedSeconds('2026-08-02T10:30:00.000Z', now)).toBe(0)
    expect(elapsedSeconds('not a date', now)).toBe(0)
  })
})

describe('displayTotals', () => {
  it('shows the worked (raw) seconds, like the app since Messinstrument', () => {
    // Heute now shows the worked time large and the rounded value as a
    // sub-line (owner decision 2026-10-22: hours are worked time, euros follow
    // the invoice). The bridge still sends the rounded pair — it must not win.
    expect(
      displayTotals({
        today_seconds: 0,
        week_seconds: 23051,
        today_display_seconds: 0,
        week_display_seconds: 23400
      })
    ).toEqual({ today: 0, week: 23051 })
  })

  it('falls back to raw against an app that does not send them yet', () => {
    // Plugin and app ship separately — an older app answers get_summary
    // without the display fields, and "slightly off" beats "NaN:NaN".
    expect(displayTotals({ today_seconds: 120, week_seconds: 23051 })).toEqual({
      today: 120,
      week: 23051
    })
  })

  it('survives a garbage payload', () => {
    expect(
      displayTotals({
        today_seconds: NaN,
        week_seconds: 60,
        week_display_seconds: NaN
      } as unknown as Parameters<typeof displayTotals>[0])
    ).toEqual({ today: 0, week: 60 })
  })
})

describe('createPressGesture', () => {
  it('a short press reports short and never fires the long action', () => {
    vi.useFakeTimers()
    try {
      const long = vi.fn()
      const g = createPressGesture(long, 500)
      g.down()
      vi.advanceTimersByTime(200)
      expect(g.up()).toBe(true)
      vi.advanceTimersByTime(1000)
      expect(long).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the long action fires at the threshold, and the release is then not short', () => {
    vi.useFakeTimers()
    try {
      const long = vi.fn()
      const g = createPressGesture(long, 500)
      g.down()
      vi.advanceTimersByTime(500)
      expect(long).toHaveBeenCalledTimes(1)
      expect(g.up()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rotating while pressed voids the gesture — nothing starts on release', () => {
    vi.useFakeTimers()
    try {
      const long = vi.fn()
      const g = createPressGesture(long, 500)
      g.down()
      vi.advanceTimersByTime(100)
      g.cancel()
      vi.advanceTimersByTime(1000)
      expect(long).not.toHaveBeenCalled()
      expect(g.up()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a fresh press after a long one is short again', () => {
    vi.useFakeTimers()
    try {
      const long = vi.fn()
      const g = createPressGesture(long, 500)
      g.down()
      vi.advanceTimersByTime(500)
      g.up()
      g.down()
      vi.advanceTimersByTime(100)
      expect(g.up()).toBe(true)
      expect(long).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
