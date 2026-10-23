import type Database from 'better-sqlite3'

type Db = Database.Database

/** How many texts the description field suggests at most (Q8). */
export const SUGGESTION_LIMIT = 8

/**
 * The user's own recent descriptions for one client and project (Q8, 2.0.0):
 * the description field suggests them, so a recurring task is recognised
 * instead of retyped. Non-empty texts of live entries, trimmed, each once,
 * newest use first. "No project" (`projectId` null) is a pair of its own.
 * No model and nothing leaves the machine.
 */
export function readDescriptionSuggestions(
  db: Db,
  clientId: number,
  projectId: number | null
): string[] {
  const rows = db
    .prepare(
      `SELECT TRIM(description) AS text, MAX(started_at) AS last_used
         FROM entries
        WHERE deleted_at IS NULL
          AND client_id = ?
          AND project_id IS ?
          AND TRIM(description) <> ''
        GROUP BY TRIM(description)
        ORDER BY last_used DESC
        LIMIT ?`
    )
    .all(clientId, projectId, SUGGESTION_LIMIT) as Array<{ text: string }>
  return rows.map((r) => r.text)
}

/**
 * The argument of `entries:recentDescriptions`, checked at the IPC boundary:
 * integer ids, `projectId` explicitly null for "no project". Anything else
 * is refused (null), so the channel reads exactly one pair.
 */
export function parseSuggestionArgs(
  input: unknown
): { clientId: number; projectId: number | null } | null {
  if (typeof input !== 'object' || input === null) return null
  const { clientId, projectId } = input as { clientId?: unknown; projectId?: unknown }
  if (!Number.isInteger(clientId)) return null
  if (projectId !== null && !Number.isInteger(projectId)) return null
  return { clientId: clientId as number, projectId: projectId as number | null }
}
