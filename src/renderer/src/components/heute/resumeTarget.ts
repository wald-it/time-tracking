import type { Client, Entry, Project } from '../../../../shared/types'

/** What "Fortsetzen" starts: an entry's client, project and description. */
export interface ResumeTarget {
  clientId: number
  projectId: number | null
  description: string
}

/**
 * What "Fortsetzen" on a row of Heute's entry table starts again (Q8, 2.2),
 * by the same rule as the last pair (shared/startPair): an archived or
 * unknown client cannot be resumed (`null`, the key is disabled), an archived
 * project is left out. A running entry already runs: `null` as well.
 */
export function resumeTarget(
  entry: Entry,
  client: Client | undefined,
  project: Project | undefined
): ResumeTarget | null {
  if (entry.stopped_at === null) return null
  if (client?.active !== 1) return null
  return {
    clientId: entry.client_id,
    projectId: entry.project_id != null && project?.active === 1 ? entry.project_id : null,
    description: entry.description
  }
}
