/**
 * 2.0 entry lifecycle, P1: migrate a 1.x database into entry / entry_version /
 * entry_segment / entry_legacy_id / rate / billing_profile
 * (docs/design/2.0-entry-lifecycle.md, section 10, with the conductor's P1
 * decisions). Not registered in the runner: P2 does that, and P2 must not do
 * it before P7 has run this against a copy of the owner's backup.
 *
 * Runs inside the caller's transaction and leaves `entries` untouched. It
 * checks its own result before returning: per client and local month, worked
 * time, billed minutes and revenue (rounded and unrounded) over the current
 * segments of live entries must equal the 1.x formulas over `entries`. Any
 * difference, and any timestamp it cannot read, throws MigrationAbortError,
 * so the caller's transaction rolls everything back.
 */
import type Database from 'better-sqlite3'
import { billedMinutes, effectiveRateCent, feeCent } from '../../shared/currency'
import { readRoundMinutes } from '../dashboardTotals'
import { SCHEMA_V2_SQL } from './schemaV2'

/** Shapes the report counts; one entry can have several (an imported pair). */
export const MIGRATION_SHAPES = [
  'single',
  'pair',
  'halfDeletedPair',
  'inconsistentPair',
  'unsplitOverMidnight',
  'zeroLength',
  'running',
  'deletedRunning',
  'imported',
  'deleted'
] as const
export type MigrationShape = (typeof MIGRATION_SHAPES)[number]

/** Exceptions the report lists by id, as codes (P2/P7 count them), never text. */
export type MigrationExceptionCode =
  /** "Inkonsistentes Paar": halves differ in content, migrated as separate entries. */
  | 'migration.inconsistentPair'
  /** A fully deleted group whose rows were deleted at different times. */
  | 'migration.deletedAtDiffers'
  /** created_at could not be read; kept verbatim. */
  | 'migration.createdAtUnreadable'
  /** A deleted row that was still running, sealed at its heartbeat or start. */
  | 'migration.deletedRunningSealed'
  /**
   * Halves of a group that start on the same local date (an edited half, or
   * a database moved between time zones): one version cannot hold two
   * segments of one day, so they become separate entries, like an
   * "Inkonsistentes Paar".
   */
  | 'migration.sameDayPair'

export interface MigrationException {
  code: MigrationExceptionCode
  legacyIds: number[]
}

export interface MigrationReport {
  legacyRows: number
  entries: number
  shapes: Record<MigrationShape, number>
  exceptions: MigrationException[]
}

export type MigrationAbortCode =
  | 'migration.timestampUnreadable'
  | 'migration.selfCheckFailed'
  /** pdf_round_minutes above 60, which a billing profile cannot hold (1 to 60). */
  | 'migration.roundingUnsupported'
  /** Writing one entry failed (a constraint); names its legacy ids. */
  | 'migration.writeFailed'

/** Thrown to abort; the caller's transaction then rolls everything back. */
export class MigrationAbortError extends Error {
  constructor(
    readonly code: MigrationAbortCode,
    readonly details: string[]
  ) {
    super(`${code}: ${details.slice(0, 20).join('; ')}`)
    this.name = 'MigrationAbortError'
  }
}

export interface MigrateOptions {
  /** Test seam: runs after the new tables are written, before the self-check. */
  afterWrite?: (db: Database.Database) => void
}

interface LegacyRow {
  id: number
  client_id: number
  project_id: number | null
  description: string
  started_at: string
  stopped_at: string | null
  heartbeat_at: string | null
  created_at: string
  deleted_at: string | null
  link_id: string | null
  tags: string
  reference: string
  billable: number
  private_note: string
  graph_event_id: string | null
}

const CONTENT_FIELDS = [
  'client_id',
  'project_id',
  'description',
  'tags',
  'reference',
  'billable',
  'private_note'
] as const

/** The default profile and rates count from the beginning of time. */
const VALID_FROM_ALWAYS = '0001-01-01'

const readable = (v: string | null): boolean => v === null || !Number.isNaN(Date.parse(v))

/** created_at as UTC ISO with milliseconds and Z; null when unreadable. */
function normaliseCreatedAt(v: string): string | null {
  // SQLite's datetime('now') default: UTC, a space, no zone.
  const sqlite = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(v)
  const t = sqlite ? Date.parse(`${sqlite[1]}T${sqlite[2]}${sqlite[3] ?? ''}Z`) : Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/** Local date (YYYY-MM-DD) in the zone the process runs in, as readers use it. */
export function localDate(isoString: string): string {
  const d = new Date(isoString)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Run inside the caller's transaction. Leaves `entries` untouched. Throws
 * MigrationAbortError on an unreadable timestamp or a failed self-check.
 */
export function migrateEntriesToV2(
  db: Database.Database,
  options: MigrateOptions = {}
): MigrationReport {
  const rows = db.prepare('SELECT * FROM entries ORDER BY id').all() as LegacyRow[]

  // Decision 7: an unreadable time leaves no local date or bound to work
  // with. That covers start and stop, the delete time (a version's written_at)
  // and, for a deleted row that still ran, the heartbeat it is sealed at.
  const unreadable = rows
    .filter(
      (r) =>
        !readable(r.started_at) ||
        !readable(r.stopped_at) ||
        !readable(r.deleted_at) ||
        (r.deleted_at !== null && r.stopped_at === null && !readable(r.heartbeat_at))
    )
    .map(
      (r) =>
        `id ${r.id}: started_at ${JSON.stringify(r.started_at)}, stopped_at ${JSON.stringify(r.stopped_at)}, ` +
        `deleted_at ${JSON.stringify(r.deleted_at)}, heartbeat_at ${JSON.stringify(r.heartbeat_at)}`
    )
  if (unreadable.length > 0) {
    throw new MigrationAbortError('migration.timestampUnreadable', unreadable)
  }

  // The 1.x step as its readers interpret it; a profile holds 1 to 60.
  const step = readRoundMinutes(db)
  if (step > 60) {
    throw new MigrationAbortError('migration.roundingUnsupported', [`pdf_round_minutes ${step}`])
  }

  db.exec(SCHEMA_V2_SQL)

  const shapes = Object.fromEntries(MIGRATION_SHAPES.map((s) => [s, 0])) as Record<
    MigrationShape,
    number
  >
  const exceptions: MigrationException[] = []

  // 1. Groups: rows sharing a link_id, every other row on its own.
  const groups = new Map<string, LegacyRow[]>()
  for (const r of rows) {
    const key = r.link_id !== null ? `link:${r.link_id}` : `row:${r.id}`
    const g = groups.get(key)
    if (g) g.push(r)
    else groups.set(key, [r])
  }

  // 2. Parts: a group becomes one entry unless its halves differ in content
  // (decision 3, "Inkonsistentes Paar") or are half deleted (OQ8).
  type Part = { rows: LegacyRow[]; base: MigrationShape }
  const parts: Part[] = []
  for (const g of groups.values()) {
    if (g.length === 1) {
      parts.push({ rows: g, base: 'single' })
      continue
    }
    const consistent = CONTENT_FIELDS.every((f) => g.every((r) => r[f] === g[0][f]))
    if (!consistent) {
      exceptions.push({ code: 'migration.inconsistentPair', legacyIds: g.map((r) => r.id) })
      for (const r of g) parts.push({ rows: [r], base: 'inconsistentPair' })
      continue
    }
    const live = g.filter((r) => r.deleted_at === null)
    const trashed = g.filter((r) => r.deleted_at !== null)
    const split: Part[] =
      live.length > 0 && trashed.length > 0
        ? [
            { rows: live, base: 'halfDeletedPair' },
            { rows: trashed, base: 'halfDeletedPair' }
          ]
        : [{ rows: g, base: 'pair' }]
    for (const part of split) {
      const dates = part.rows.map((r) => localDate(r.started_at))
      if (new Set(dates).size < dates.length) {
        exceptions.push({ code: 'migration.sameDayPair', legacyIds: part.rows.map((r) => r.id) })
        for (const r of part.rows) parts.push({ rows: [r], base: 'inconsistentPair' })
      } else {
        parts.push(part)
      }
    }
  }

  // 3. Write entry, versions, segments and legacy ids.
  const insEntry = db.prepare(
    `INSERT INTO entry (id, created_at, created_source, current_version_id, is_deleted, heartbeat_at, graph_event_id)
     VALUES (?, ?, 'migration', 0, ?, ?, ?)`
  )
  const insVersion = db.prepare(
    `INSERT INTO entry_version (entry_id, version_no, state, deleted, client_id, project_id, description,
       started_at, stopped_at, tags, reference, billable, private_note, written_at, source)
     VALUES (@entry_id, @version_no, @state, @deleted, @client_id, @project_id, @description,
       @started_at, @stopped_at, @tags, @reference, @billable, @private_note, @written_at, 'migration')`
  )
  const insSegment = db.prepare(
    `INSERT INTO entry_segment (version_id, seq, segment_date, started_at, stopped_at) VALUES (?, ?, ?, ?, ?)`
  )
  const setCurrent = db.prepare('UPDATE entry SET current_version_id = ? WHERE id = ?')
  const insLegacy = db.prepare('INSERT INTO entry_legacy_id (legacy_id, entry_id) VALUES (?, ?)')

  for (const part of parts) {
    try {
      writePart(part)
    } catch (err) {
      // A constraint names a column, not the row; the ids lead to the row.
      throw new MigrationAbortError('migration.writeFailed', [
        `legacy ids ${part.rows.map((r) => r.id).join(', ')}: ${(err as Error).message}`
      ])
    }
  }

  function writePart(part: Part): void {
    const rs = [...part.rows].sort(
      (a, b) => a.started_at.localeCompare(b.started_at) || a.id - b.id
    )
    const id = rs.reduce((min, r) => (r.id < min ? r.id : min), rs[0].id)
    const deleted = rs.every((r) => r.deleted_at !== null)
    const running = rs.some((r) => r.stopped_at === null)
    const open = running && !deleted
    const entryShapes = new Set<MigrationShape>([part.base])

    // Segments exactly as stored. A deleted row that still ran is sealed at
    // its last heartbeat, or at its start without one, as crash recovery does
    // (decision 5); an open version keeps its open segment.
    const segments = rs.map((r) => ({
      started_at: r.started_at,
      stopped_at: r.stopped_at ?? (deleted ? (r.heartbeat_at ?? r.started_at) : null)
    }))
    if (deleted) entryShapes.add('deleted')
    if (open) entryShapes.add('running')
    if (running && deleted) {
      entryShapes.add('deletedRunning')
      exceptions.push({ code: 'migration.deletedRunningSealed', legacyIds: rs.map((r) => r.id) })
    }
    if (rs.some((r) => r.graph_event_id !== null)) entryShapes.add('imported')
    if (part.base === 'single' && rs[0].stopped_at !== null) {
      const r = rs[0]
      if (r.stopped_at === r.started_at) entryShapes.add('zeroLength')
      const lastInstant = new Date(Date.parse(r.stopped_at!) - 1).toISOString()
      if (
        Date.parse(r.stopped_at!) > Date.parse(r.started_at) &&
        localDate(lastInstant) !== localDate(r.started_at)
      ) {
        entryShapes.add('unsplitOverMidnight')
      }
    }
    for (const s of entryShapes) shapes[s]++

    // created_at: the earliest of the group (decision 6: ISO with Z).
    const created = rs.map((r) => normaliseCreatedAt(r.created_at))
    if (created.some((c) => c === null)) {
      exceptions.push({ code: 'migration.createdAtUnreadable', legacyIds: rs.map((r) => r.id) })
    }
    const readableCreated = created.filter((c): c is string => c !== null).sort()
    const createdAt = readableCreated[0] ?? rs[0].created_at

    const openRow = rs.find((r) => r.stopped_at === null)
    insEntry.run(
      id,
      createdAt,
      deleted ? 1 : 0,
      open ? (openRow?.heartbeat_at ?? null) : null,
      rs.find((r) => r.graph_event_id !== null)?.graph_event_id ?? null
    )

    const content = Object.fromEntries(CONTENT_FIELDS.map((f) => [f, rs[0][f]]))
    const writeVersion = (versionNo: number, isDeleted: boolean, writtenAt: string): number => {
      const versionId = Number(
        insVersion.run({
          ...content,
          entry_id: id,
          version_no: versionNo,
          state: open ? 'open' : 'sealed',
          deleted: isDeleted ? 1 : 0,
          started_at: segments[0].started_at,
          stopped_at: segments[segments.length - 1].stopped_at,
          written_at: writtenAt
        }).lastInsertRowid
      )
      segments.forEach((s, seq) =>
        insSegment.run(versionId, seq, localDate(s.started_at), s.started_at, s.stopped_at)
      )
      return versionId
    }

    let current = writeVersion(1, false, createdAt)
    if (deleted) {
      // A delete is a version that carries the previous content (decision 4:
      // written at the last of the rows' delete times).
      const deletedAts = [...new Set(rs.map((r) => r.deleted_at!))]
      if (deletedAts.length > 1) {
        exceptions.push({ code: 'migration.deletedAtDiffers', legacyIds: rs.map((r) => r.id) })
      }
      const writtenAt = deletedAts
        .map((d) => normaliseCreatedAt(d) ?? d)
        .sort()
        .at(-1)!
      current = writeVersion(2, true, writtenAt)
    }
    setCurrent.run(current, id)
    for (const r of rs) insLegacy.run(r.id, id)
  }

  // New entries start above every 1.x id, so none can take a second half's id.
  if (rows.length > 0) {
    const maxLegacy = rows.reduce((max, r) => (r.id > max ? r.id : max), rows[0].id)
    const updated = db
      .prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'entry'")
      .run(maxLegacy)
    if (updated.changes === 0) {
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('entry', ?)").run(maxLegacy)
    }
  }

  // 4. Rates from the beginning of time; a project without a rate of its own
  // gets no row, so it keeps inheriting (decision 9).
  db.prepare(
    `INSERT INTO rate (client_id, rate_cent, valid_from) SELECT id, rate_cent, ? FROM clients`
  ).run(VALID_FROM_ALWAYS)
  db.prepare(
    `INSERT INTO rate (project_id, rate_cent, valid_from)
     SELECT id, rate_cent, ? FROM projects WHERE rate_cent IS NOT NULL`
  ).run(VALID_FROM_ALWAYS)

  // 5. The default billing profile replaces pdf_round_minutes. German, as the
  // PDF is today whatever the app language (decision 8).
  db.prepare(
    `INSERT INTO billing_profile (client_id, project_id, interval_min, min_unit_min, alignment, columns,
       language, fee_column, group_by)
     VALUES (NULL, NULL, ?, 0, ?, 'times', 'de', 'auto', 'none')`
  ).run(step, step > 0 ? 'grid' : 'none')

  options.afterWrite?.(db)

  selfCheck(db, rows, step)

  return { legacyRows: rows.length, entries: parts.length, shapes, exceptions }
}

interface Sums {
  workedMs: number
  billedMin: number
  feeCent: number
  feeUnroundedCent: number
  segments: number
}

function addTo(sums: Map<string, Sums>, key: string, ms: number, step: number, rate: number): void {
  const s = sums.get(key) ?? {
    workedMs: 0,
    billedMin: 0,
    feeCent: 0,
    feeUnroundedCent: 0,
    segments: 0
  }
  const billed = billedMinutes(ms, step)
  s.workedMs += ms
  s.billedMin += billed
  s.feeCent += feeCent(billed, rate)
  s.feeUnroundedCent += feeCent(billedMinutes(ms, 0), rate)
  s.segments++
  sums.set(key, s)
}

/**
 * Section 10.9 in its P1 form (decision 2): the 1.x formulas over `entries`
 * against the same formulas over the new tables, per client and local month.
 * P4 switches the new side to billing_lines.
 */
function selfCheck(db: Database.Database, rows: LegacyRow[], step: number): void {
  const clientRate = new Map(
    (
      db.prepare('SELECT id, rate_cent FROM clients').all() as { id: number; rate_cent: number }[]
    ).map((c) => [c.id, c.rate_cent])
  )
  const projectRate = new Map(
    (
      db.prepare('SELECT id, rate_cent FROM projects').all() as {
        id: number
        rate_cent: number | null
      }[]
    ).map((p) => [p.id, p.rate_cent])
  )
  const oldSums = new Map<string, Sums>()
  for (const r of rows) {
    if (r.deleted_at !== null || r.stopped_at === null) continue
    const rate = effectiveRateCent(
      r.project_id !== null ? projectRate.get(r.project_id) : null,
      clientRate.get(r.client_id) ?? 0
    )
    addTo(
      oldSums,
      `${r.client_id}|${localDate(r.started_at).slice(0, 7)}|${r.billable}`,
      Date.parse(r.stopped_at) - Date.parse(r.started_at),
      step,
      rate
    )
  }

  const profile = db
    .prepare(
      'SELECT interval_min FROM billing_profile WHERE client_id IS NULL AND project_id IS NULL'
    )
    .get() as { interval_min: number }
  const rateRow = db.prepare(
    `SELECT rate_cent FROM rate WHERE client_id IS ? AND project_id IS ? AND valid_from <= ?
     ORDER BY valid_from DESC LIMIT 1`
  )
  const rateOn = (clientId: number, projectId: number | null, date: string): number => {
    if (projectId !== null) {
      const p = rateRow.get(null, projectId, date) as { rate_cent: number | null } | undefined
      if (p && p.rate_cent !== null) return p.rate_cent
    }
    return (rateRow.get(clientId, null, date) as { rate_cent: number } | undefined)?.rate_cent ?? 0
  }
  const newSums = new Map<string, Sums>()
  const segs = db
    .prepare(
      `SELECT v.client_id, v.project_id, v.billable, s.segment_date, s.started_at, s.stopped_at
         FROM entry e
         JOIN entry_version v ON v.id = e.current_version_id
         JOIN entry_segment s ON s.version_id = v.id
        WHERE e.is_deleted = 0 AND s.stopped_at IS NOT NULL`
    )
    .all() as {
    client_id: number
    project_id: number | null
    billable: number
    segment_date: string
    started_at: string
    stopped_at: string
  }[]
  for (const s of segs) {
    addTo(
      newSums,
      `${s.client_id}|${s.segment_date.slice(0, 7)}|${s.billable}`,
      Date.parse(s.stopped_at) - Date.parse(s.started_at),
      profile.interval_min,
      rateOn(s.client_id, s.project_id, s.segment_date)
    )
  }

  const differences: string[] = []
  for (const key of new Set([...oldSums.keys(), ...newSums.keys()])) {
    const a = oldSums.get(key)
    const b = newSums.get(key)
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      differences.push(
        `${key}: 1.x ${JSON.stringify(a ?? null)} vs 2.0 ${JSON.stringify(b ?? null)}`
      )
    }
  }
  // Per row: mapped once, version 1 of its entry carries the row's content,
  // and holds a segment that starts where the row started. The sums alone
  // would miss a row landing on the wrong entry of the same client and month.
  const firstVersion = db.prepare(
    `SELECT v.id, ${CONTENT_FIELDS.map((f) => `v.${f}`).join(', ')}
       FROM entry_legacy_id l
       JOIN entry_version v ON v.entry_id = l.entry_id AND v.version_no = 1
      WHERE l.legacy_id = ?`
  )
  const segmentAt = db.prepare(
    'SELECT 1 FROM entry_segment WHERE version_id = ? AND started_at = ?'
  )
  for (const r of rows) {
    const v = firstVersion.get(r.id) as (Record<string, unknown> & { id: number }) | undefined
    if (!v) {
      differences.push(`legacy id ${r.id}: not mapped`)
      continue
    }
    const differing = CONTENT_FIELDS.filter((f) => v[f] !== r[f])
    if (differing.length > 0) {
      differences.push(`legacy id ${r.id}: content differs in ${differing.join(', ')}`)
    }
    if (!segmentAt.get(v.id, r.started_at)) {
      differences.push(`legacy id ${r.id}: no segment starts at ${r.started_at}`)
    }
  }
  if (differences.length > 0)
    throw new MigrationAbortError('migration.selfCheckFailed', differences)
}
