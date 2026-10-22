import type { Client, Entry, Project } from '../../../../shared/types'

/**
 * Pure math behind the month's client breakdown (HANDOFF §3.14).
 *
 * Seconds per client over the given entries, the share of the summed total
 * and a stable order (largest first, ties by name). A running entry counts up
 * to `nowMs` — the caller passes the shared clock from `useNow()`, so there is
 * no own interval. Durations are raw (no rounding): the breakdown shows worked
 * time, like the readouts.
 *
 * Grouped by the colour the bars carry (owner pre-review of PR 3), like the
 * Heute day-scale legend: a project with its own colour is its own row, named
 * after the project; everything else stays under its client.
 */
export interface ClientShare {
  /** Stable row key: `p<projectId>` for a coloured project, `c<clientId>` otherwise. */
  key: string
  clientId: number
  name: string
  /** Client colour; `null` when the client is unknown or has none. */
  color: string | null
  seconds: number
  /** Exact share of the total in percent (0–100) — drives the track width. */
  sharePct: number
}

export function entrySeconds(entry: Entry, nowMs: number): number {
  const start = new Date(entry.started_at).getTime()
  const stop = entry.stopped_at ? new Date(entry.stopped_at).getTime() : nowMs
  return Math.max(0, Math.floor((stop - start) / 1000))
}

export function clientShares(
  entries: Entry[],
  clients: Client[],
  nowMs: number,
  projects: Project[] = []
): ClientShare[] {
  const clientsById = new Map(clients.map((c) => [c.id, c]))
  const projectsById = new Map(projects.map((p) => [p.id, p]))
  const groups = new Map<string, ClientShare>()
  for (const e of entries) {
    const project = e.project_id != null ? projectsById.get(e.project_id) : undefined
    const client = clientsById.get(e.client_id)
    const key = project?.color ? `p${project.id}` : `c${e.client_id}`
    const g = groups.get(key) ?? {
      key,
      clientId: e.client_id,
      name: project?.color ? project.name : (client?.name ?? ''),
      color: (project?.color || client?.color) ?? null,
      seconds: 0,
      sharePct: 0
    }
    g.seconds += entrySeconds(e, nowMs)
    groups.set(key, g)
  }

  const total = [...groups.values()].reduce((sum, g) => sum + g.seconds, 0)
  if (total === 0) return []

  return [...groups.values()]
    .filter((g) => g.seconds > 0)
    .map((g) => ({ ...g, color: g.color || null, sharePct: (g.seconds / total) * 100 }))
    .sort(
      (a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name) || a.key.localeCompare(b.key)
    )
}
