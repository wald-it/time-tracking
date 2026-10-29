import type { EntryVersion } from './types'

// OQ5 (docs/design/2.0-entry-lifecycle.md): capture includes additions up to
// five minutes after its stop, inclusive. Always anchor to the first version,
// and to the moment it was sealed (`written_at`), not to its `stopped_at`: the
// idle prompt stops at the start of the idle time, so a quick note right after
// it would otherwise fall outside the window.
export const CAPTURE_ADDITIONS_WINDOW_MS = 5 * 60 * 1000

export interface EntryHistoryGroup {
  capture: boolean
  versions: EntryVersion[]
}

/** Oldest first; every version in the capture window remains inspectable. */
export function collapseEntryVersions(versions: readonly EntryVersion[]): EntryHistoryGroup[] {
  const ordered = [...versions].sort((a, b) => a.version_no - b.version_no)
  if (!ordered.length) return []
  const first = ordered[0]
  const stop = first.state === 'sealed' && first.stopped_at ? Date.parse(first.written_at) : NaN
  const groups: EntryHistoryGroup[] = [{ capture: true, versions: [first] }]
  let capturing = Number.isFinite(stop)
  for (const version of ordered.slice(1)) {
    const afterStop = Date.parse(version.written_at) - stop
    if (capturing && afterStop >= 0 && afterStop <= CAPTURE_ADDITIONS_WINDOW_MS) {
      groups[0].versions.push(version)
    } else {
      capturing = false
      groups.push({ capture: false, versions: [version] })
    }
  }
  return groups
}

export type EntryHistoryChange =
  | 'times'
  | 'client'
  | 'project'
  | 'description'
  | 'billable'
  | 'tags'
  | 'reference'
  | 'private_note'
  | 'deleted'
  | 'restored'

/** Compare stored content, including every day segment, never transport metadata. */
export function diffEntryVersions(
  previous: EntryVersion,
  current: EntryVersion
): EntryHistoryChange[] {
  const changes: EntryHistoryChange[] = []
  if (
    previous.started_at !== current.started_at ||
    previous.stopped_at !== current.stopped_at ||
    previous.segments.length !== current.segments.length ||
    previous.segments.some((segment, i) => {
      const next = current.segments[i]
      return (
        !next ||
        segment.seq !== next.seq ||
        segment.segment_date !== next.segment_date ||
        segment.started_at !== next.started_at ||
        segment.stopped_at !== next.stopped_at
      )
    })
  )
    changes.push('times')
  const fields = {
    client_id: 'client',
    project_id: 'project',
    description: 'description',
    billable: 'billable',
    tags: 'tags',
    reference: 'reference',
    private_note: 'private_note'
  } as const
  for (const field of Object.keys(fields) as Array<keyof typeof fields>) {
    if (previous[field] !== current[field]) changes.push(fields[field])
  }
  if (previous.deleted !== current.deleted) changes.push(current.deleted ? 'deleted' : 'restored')
  return changes
}
