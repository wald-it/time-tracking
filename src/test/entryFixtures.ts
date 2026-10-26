/**
 * Test fixtures for the 2.0 entry tables (design doc sections 4 and 6).
 *
 * Reader suites used to seed `entries` rows straight into the 1.x table,
 * including shapes the write path refuses (overlaps, a trashed row, a
 * running row with a fixed id, timestamps without milliseconds). Since
 * migration 028 `entries` is a read-only view, so this is the one place a test
 * may write the tables directly: the guard test `entryWriteGuard.test.ts`
 * allows it here and nowhere else outside `writeEntry` and the migration.
 *
 * `seedEntry` writes exactly what the 1.x row (or the linked pair) would have
 * become after the migration: one entry, version 1 with the content, one
 * segment per row, and for a deleted row a second version with `deleted = 1`
 * written at `deleted_at`. It validates nothing, on purpose.
 */
import type Database from 'better-sqlite3'

export interface SeedSegment {
  started_at: string
  /** null for the open segment of a running entry (only the last one). */
  stopped_at: string | null
  /** The stored local date; default: the start's date in this zone. Set it to seed a cut made in another zone. */
  segment_date?: string
}

export interface SeedEntryInput {
  /** Fixed entry id; otherwise AUTOINCREMENT. */
  id?: number
  client_id: number
  project_id?: number | null
  description?: string
  /** One segment; or give `segments` for a midnight-split entry. */
  started_at?: string
  stopped_at?: string | null
  segments?: SeedSegment[]
  tags?: string
  reference?: string
  billable?: number
  private_note?: string
  /** Set → the entry is in the trash (version 2, deleted, written then). */
  deleted_at?: string | null
  /** entry.heartbeat_at; only meaningful for a running entry. */
  heartbeat_at?: string | null
  /** entry.created_at (and version 1's written_at); default: the start. */
  created_at?: string
  graph_event_id?: string | null
  created_source?: 'app' | 'timer' | 'import' | 'mcp' | 'controller' | 'migration'
  source?:
    | 'app'
    | 'quicknote'
    | 'idle'
    | 'import'
    | 'mcp'
    | 'controller'
    | 'tag-rename'
    | 'migration'
    | 'recovery'
}

/** Local date (YYYY-MM-DD) in the zone the process runs in, as the app does. */
export function localDateOf(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Write one entry with its version(s) and segments; returns the entry id. */
export function seedEntry(db: Database.Database, input: SeedEntryInput): number {
  const segments: SeedSegment[] = input.segments ?? [
    { started_at: input.started_at!, stopped_at: input.stopped_at ?? null }
  ]
  if (segments.length === 0) throw new Error('seedEntry: at least one segment')
  const open = segments[segments.length - 1].stopped_at === null
  const content = {
    client_id: input.client_id,
    project_id: input.project_id ?? null,
    description: input.description ?? '',
    tags: input.tags ?? '',
    reference: input.reference ?? '',
    billable: input.billable ?? 1,
    private_note: input.private_note ?? ''
  }
  const createdAt = input.created_at ?? segments[0].started_at
  const deleted = input.deleted_at != null

  return db.transaction((): number => {
    const info = db
      .prepare(
        `INSERT INTO entry (id, created_at, created_source, current_version_id, is_deleted, heartbeat_at, graph_event_id)
         VALUES (?, ?, ?, 0, ?, ?, ?)`
      )
      .run(
        input.id ?? null,
        createdAt,
        input.created_source ?? 'app',
        deleted ? 1 : 0,
        open && !deleted ? (input.heartbeat_at ?? segments[0].started_at) : null,
        input.graph_event_id ?? null
      )
    const entryId = Number(info.lastInsertRowid)
    const insVersion = db.prepare(
      `INSERT INTO entry_version (entry_id, version_no, state, deleted, client_id, project_id, description,
         started_at, stopped_at, tags, reference, billable, private_note, written_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insSegment = db.prepare(
      `INSERT INTO entry_segment (version_id, seq, segment_date, started_at, stopped_at) VALUES (?, ?, ?, ?, ?)`
    )
    const writeVersion = (no: number, isDeleted: boolean, writtenAt: string): number => {
      // A deleted running row is sealed where it stood, in both versions, as
      // the migration does it (decision L5).
      const segs = segments.map((s) => ({
        started_at: s.started_at,
        stopped_at: s.stopped_at ?? (deleted ? (input.heartbeat_at ?? s.started_at) : null),
        segment_date: s.segment_date ?? localDateOf(s.started_at)
      }))
      const state = open && !deleted ? 'open' : 'sealed'
      const versionId = Number(
        insVersion.run(
          entryId,
          no,
          state,
          isDeleted ? 1 : 0,
          content.client_id,
          content.project_id,
          content.description,
          segs[0].started_at,
          segs[segs.length - 1].stopped_at,
          content.tags,
          content.reference,
          content.billable,
          content.private_note,
          writtenAt,
          input.source ?? 'app'
        ).lastInsertRowid
      )
      segs.forEach((s, seq) =>
        insSegment.run(versionId, seq, s.segment_date, s.started_at, s.stopped_at)
      )
      return versionId
    }
    let current = writeVersion(1, false, createdAt)
    if (deleted) current = writeVersion(2, true, input.deleted_at!)
    db.prepare('UPDATE entry SET current_version_id = ? WHERE id = ?').run(current, entryId)
    return entryId
  })()
}
