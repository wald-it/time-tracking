/**
 * Pure logic of the Schnellstart project list (HANDOFF §3.11, B1): which rows
 * the list shows and in what order, where the focus starts and moves, and
 * whether the list opens downwards or upwards. No React, no DOM — the
 * component measures and renders, this decides.
 */

/** The fields of a project the list needs (a subset of `Project`). */
export interface ListProject {
  id: number
  client_id: number | null
  name: string
  color: string
  /** 1 = active. The list only offers active projects. */
  active: number
}

export interface QuickStartRow {
  /** Stable React key: `p<id>` or `none`. */
  key: string
  /** The project to start; null = "Kein Projekt". */
  projectId: number | null
  isNoProject: boolean
  /** This (client, project) pair is the running timer — the row has no action. */
  isRunning: boolean
  /** The pair the key's main area starts ("ZULETZT"), unless it is running. */
  isLast: boolean
}

/** The running timer, as far as the list cares. */
export interface RunningPair {
  clientId: number
  projectId: number | null
}

/** Active projects of one client, in the order they come in. */
export function activeProjectsOf<P extends ListProject>(
  projects: Iterable<P>,
  clientId: number
): P[] {
  const out: P[] = []
  for (const p of projects) {
    if (p.client_id === clientId && p.active === 1) out.push(p)
  }
  return out
}

/**
 * The list rows: one per active project of the client, in the order given
 * (the projects store's order), then "Kein Projekt" as the last row.
 *
 * `isLast` marks the pair the main area starts — `lastProjectId`, with null
 * meaning the "Kein Projekt" row — and is dropped while that pair runs: the
 * running row shows "LÄUFT" instead.
 */
export function buildRows(
  projects: readonly ListProject[],
  clientId: number,
  lastProjectId: number | null,
  running: RunningPair | null
): QuickStartRow[] {
  const runsHere = running !== null && running.clientId === clientId
  const row = (projectId: number | null): QuickStartRow => {
    const isRunning = runsHere && running.projectId === projectId
    return {
      key: projectId === null ? 'none' : `p${projectId}`,
      projectId,
      isNoProject: projectId === null,
      isRunning,
      isLast: !isRunning && lastProjectId === projectId
    }
  }
  return [...activeProjectsOf(projects, clientId).map((p) => row(p.id)), row(null)]
}

/**
 * Where the focus starts when the list opens: on "ZULETZT", else on the first
 * row that has an action, else on the first row.
 */
export function initialIndex(rows: readonly QuickStartRow[]): number {
  const last = rows.findIndex((r) => r.isLast)
  if (last >= 0) return last
  const actionable = rows.findIndex((r) => !r.isRunning)
  return actionable >= 0 ? actionable : 0
}

/**
 * ↑/↓ in the list: one row up or down, wrapping at both ends (menu pattern).
 * The "Kein Projekt" row is an ordinary stop; so is the running row (it is
 * reachable, it just does nothing).
 */
export function moveIndex(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return 0
  return (((current + delta) % count) + count) % count
}

/**
 * Open downwards, unless the list does not fit below the key but does fit
 * above it. Both spaces are measured against the scroll container the key
 * sits in, not the window. When it fits neither way it opens downwards — the
 * container scrolls.
 */
export function openDirection(
  spaceBelow: number,
  spaceAbove: number,
  listHeight: number
): 'down' | 'up' {
  if (spaceBelow >= listHeight) return 'down'
  return spaceAbove >= listHeight ? 'up' : 'down'
}

/** What a click on a key's main area does (B1 and the owner correction). */
export type MainAction =
  | { kind: 'start'; projectId: number | null }
  | { kind: 'switch'; projectId: number | null }
  /** Client and last project already run: no restart, no stop. */
  | { kind: 'none' }

export function mainAction(
  clientId: number,
  lastProjectId: number | null,
  running: RunningPair | null
): MainAction {
  if (running === null) return { kind: 'start', projectId: lastProjectId }
  if (running.clientId === clientId && running.projectId === lastProjectId) return { kind: 'none' }
  return { kind: 'switch', projectId: lastProjectId }
}
