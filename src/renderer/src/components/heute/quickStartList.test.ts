import { describe, it, expect } from 'vitest'
import {
  activeProjectsOf,
  buildRows,
  initialIndex,
  mainAction,
  moveIndex,
  openDirection,
  type ListProject
} from './quickStartList'

const P = (id: number, client_id: number | null, active = 1): ListProject => ({
  id,
  client_id,
  name: `P${id}`,
  color: '',
  active
})

const PROJECTS = [P(10, 1), P(11, 1), P(12, 1, 0), P(20, 2), P(13, null)]

describe('activeProjectsOf', () => {
  it('keeps the active projects of the client, in the given order', () => {
    expect(activeProjectsOf(PROJECTS, 1).map((p) => p.id)).toEqual([10, 11])
  })
})

describe('buildRows', () => {
  it('lists the active projects, then "Kein Projekt" last', () => {
    const rows = buildRows(PROJECTS, 1, 11, null)
    expect(rows.map((r) => r.key)).toEqual(['p10', 'p11', 'none'])
    expect(rows[2]).toMatchObject({ projectId: null, isNoProject: true })
  })

  it('marks the last used project as ZULETZT', () => {
    const rows = buildRows(PROJECTS, 1, 11, null)
    expect(rows.map((r) => r.isLast)).toEqual([false, true, false])
  })

  it('marks "Kein Projekt" as ZULETZT when the last start had no project', () => {
    expect(buildRows(PROJECTS, 1, null, null).map((r) => r.isLast)).toEqual([false, false, true])
  })

  it('marks the running pair and drops ZULETZT from it', () => {
    const rows = buildRows(PROJECTS, 1, 11, { clientId: 1, projectId: 11 })
    expect(rows[1]).toMatchObject({ isRunning: true, isLast: false })
    expect(rows.filter((r) => r.isRunning)).toHaveLength(1)
  })

  it('a timer of another client marks nothing as running', () => {
    const rows = buildRows(PROJECTS, 1, 11, { clientId: 2, projectId: 20 })
    expect(rows.some((r) => r.isRunning)).toBe(false)
  })

  it('a running "Kein Projekt" of this client is the running row', () => {
    const rows = buildRows(PROJECTS, 1, 10, { clientId: 1, projectId: null })
    expect(rows[2].isRunning).toBe(true)
  })
})

describe('initialIndex', () => {
  it('starts on ZULETZT', () => {
    expect(initialIndex(buildRows(PROJECTS, 1, 11, null))).toBe(1)
  })

  it('without ZULETZT, starts on the first row that has an action', () => {
    const rows = buildRows(PROJECTS, 1, 10, { clientId: 1, projectId: 10 })
    expect(initialIndex(rows)).toBe(1)
  })
})

describe('moveIndex', () => {
  it('moves down and up through every row, "Kein Projekt" included', () => {
    expect(moveIndex(0, 1, 3)).toBe(1)
    expect(moveIndex(1, 1, 3)).toBe(2)
    expect(moveIndex(2, -1, 3)).toBe(1)
  })

  it('wraps at both ends', () => {
    expect(moveIndex(2, 1, 3)).toBe(0)
    expect(moveIndex(0, -1, 3)).toBe(2)
  })

  it('is 0 for an empty list', () => {
    expect(moveIndex(0, 1, 0)).toBe(0)
  })
})

describe('openDirection', () => {
  it('opens down when the list fits below', () => {
    expect(openDirection(300, 600, 250)).toBe('down')
  })

  it('opens up only when it does not fit below but fits above', () => {
    expect(openDirection(100, 600, 250)).toBe('up')
  })

  it('opens down when it fits neither way', () => {
    expect(openDirection(100, 200, 250)).toBe('down')
  })
})

describe('mainAction', () => {
  it('idle: starts the last project', () => {
    expect(mainAction(1, 11, null)).toEqual({ kind: 'start', projectId: 11 })
  })

  it('another client runs: switches to the last project', () => {
    expect(mainAction(1, 11, { clientId: 2, projectId: 20 })).toEqual({
      kind: 'switch',
      projectId: 11
    })
  })

  it('same client, another project runs: switches to the last project', () => {
    expect(mainAction(1, 11, { clientId: 1, projectId: 10 })).toEqual({
      kind: 'switch',
      projectId: 11
    })
  })

  it('client and last project already run: no action', () => {
    expect(mainAction(1, 11, { clientId: 1, projectId: 11 })).toEqual({ kind: 'none' })
    expect(mainAction(1, null, { clientId: 1, projectId: null })).toEqual({ kind: 'none' })
  })
})
