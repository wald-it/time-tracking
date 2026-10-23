/**
 * The client + project a start without a selection uses (#297) — the global
 * hotkey and the mini widget's play key — and the START dialog's prefill (B6).
 * One rule for those three, so they agree. The quick-start keys on Heute are
 * per client and pick a project their own way (readTopClients30d).
 *
 * Main feeds it from the database, the renderer from the dashboard summary
 * and its project list; only the data sources differ.
 */
export interface StartPair {
  clientId: number
  projectId: number | null
  /**
   * Set when the last entry had a project the rule left out (archived or
   * unknown). A direct start then books without a project; the START dialog
   * leaves the project unset instead, so it picks the client's single active
   * project as if the user had chosen the client.
   */
  droppedProject?: true
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
  if (last.project_id == null) return { clientId: last.client_id, projectId: null }
  const project = projects.find((p) => p.id === last.project_id)
  if (project?.active === 1) return { clientId: last.client_id, projectId: project.id }
  return { clientId: last.client_id, projectId: null, droppedProject: true }
}
