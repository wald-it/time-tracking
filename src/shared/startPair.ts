/**
 * The client + project a start without a selection uses (#297) — the global
 * hotkey and the mini widget's play key — and the START dialog's prefill (B6).
 * One rule for both, so the three ways to start a timer agree.
 *
 * Main feeds it from the database, the renderer from the dashboard summary
 * and its project list; only the data sources differ.
 */
export interface StartPair {
  clientId: number
  projectId: number | null
}

/**
 * The most recent entry's client and project. `null` when there is no entry
 * yet or that client is archived: then nothing is started, and the START
 * dialog opens instead. An archived (or unknown) project falls back to "no
 * project", so a direct start never books on it.
 */
export function lastStartPair(
  last: { client_id: number; project_id?: number | null } | null | undefined,
  clients: ReadonlyArray<{ id: number; active: number }>,
  projects: ReadonlyArray<{ id: number; active: number }>
): StartPair | null {
  if (!last) return null
  const client = clients.find((c) => c.id === last.client_id)
  if (client?.active !== 1) return null
  const project =
    last.project_id == null ? undefined : projects.find((p) => p.id === last.project_id)
  return { clientId: last.client_id, projectId: project?.active === 1 ? project.id : null }
}
