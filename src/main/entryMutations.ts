/**
 * The one write path of the entry lifecycle (2.0, docs/design/2.0-entry-lifecycle.md
 * section 5): `writeEntry(db, op, ctx)` is the only code that writes the
 * tables `entry`, `entry_version` and `entry_segment` (plus `heartbeat`, which
 * touches `entry.heartbeat_at` and writes no version, 4.1/D4). The guard
 * `entryWriteGuard.test.ts` keeps it that way; the view `entries` cannot be
 * written at all (D5).
 *
 * Operations (one transaction each):
 * - `create`: a finished entry (manual entry, calendar import, MCP).
 * - `start`: a running timer; whatever runs is sealed at the same instant.
 * - `seal`: stop (app, idle prompt, crash recovery). Splits at midnight (OQ2).
 * - `amend`: change fields of the open version in place.
 * - `patch`: a new version of a sealed entry. Patch semantics (D3): fields
 *   not in the patch are copied from the current version, never defaulted.
 * - `delete` / `undelete`: a version with `deleted = 1` that carries the
 *   previous content, and one that brings it back.
 *
 * Deliberately Electron-free: a better-sqlite3 handle, the shared midnight
 * split and shared types, so the IPC layer (ipc.ts), the MCP write bridge
 * (mcpBridgeCore.ts), the tag handlers, the calendar import and crash
 * recovery (db.ts) all run the same validated logic.
 *
 * The functions below `writeEntry` are the 1.x entry points kept for the
 * callers whose contracts P3 changes (IPC returns an `Entry`-shaped object,
 * the bridge sends the full field set). They are thin wrappers.
 */
import type Database from 'better-sqlite3'
import { splitAtMidnight } from '../shared/midnightSplit'
import { localDateKey } from '../shared/dateRanges'
import type {
  Entry,
  CreateEntryInput,
  CreateManualEntryInput,
  UpdateEntryInput,
  IpcResult,
  SwitchTimerResult
} from '../shared/types'

// Server-side limits (were module-private constants in ipc.ts).
export const MAX_DESCRIPTION_LEN = 500
export const MAX_REFERENCE_LEN = 200
export const MAX_NOTE_LEN = 1000
export const MAX_DURATION_SECONDS = 24 * 3600

type Db = Database.Database

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function fail(error: string): IpcResult<never> {
  return { ok: false, error }
}

// ── types ───────────────────────────────────────────────────────────────────

/** `entry_version.source` (4.2); `migration` is written by the migration only. */
export type WriteSource =
  | 'app'
  | 'quicknote'
  | 'idle'
  | 'import'
  | 'mcp'
  | 'controller'
  | 'tag-rename'
  | 'recovery'

export interface WriteCtx {
  source: WriteSource
  /** Required when the entry is billed (D9, OQ3; enforced from P5 on). */
  reason?: string
  /** The instant of the write, ISO; defaults to the clock. */
  now?: string
}

/** The content a version carries (4.2). */
export interface EntryContent {
  client_id: number
  project_id: number | null
  description: string
  started_at: string
  /** NULL only while the version is open. */
  stopped_at: string | null
  tags: string
  reference: string
  billable: number
  private_note: string
}

export interface EntrySegmentView {
  seq: number
  segment_date: string
  started_at: string
  stopped_at: string | null
}

/** What `writeEntry` returns (5, step 5): the entry, never a row. */
export interface EntryView extends EntryContent {
  id: number
  version_id: number
  version_no: number
  state: 'open' | 'sealed'
  deleted: boolean
  created_at: string
  created_source: string
  graph_event_id: string | null
  heartbeat_at: string | null
  written_at: string
  source: string
  reason: string | null
  segments: EntrySegmentView[]
  /** Any segment in an active billing run (P5); always false until then. */
  billed: boolean
}

/** The fields a caller may send; what it leaves out is copied (D3). */
export type EntryPatch = Partial<{
  client_id: number
  project_id: number | null
  description: string
  started_at: string
  stopped_at: string
  tags: string
  reference: string
  billable: number
  private_note: string
}>

/** `amend` changes fields of a running timer, never its times. */
export type AmendPatch = Omit<EntryPatch, 'started_at' | 'stopped_at'>

export interface CreateFields {
  client_id: number
  description: string
  started_at: string
  stopped_at: string
  tags?: string
  reference?: string
  billable?: number
  private_note?: string
  project_id?: number | null
}

export type WriteOp =
  | {
      op: 'create'
      fields: CreateFields
      /** Calendar import anchor; belongs to the entry (4.1). */
      graph_event_id?: string | null
    }
  | { op: 'start'; fields: CreateEntryInput }
  | { op: 'seal'; id: number; stopped_at: string }
  | {
      op: 'amend'
      id: number
      patch: AmendPatch
      /** The version the caller read; the write fails if the entry moved on. */
      expected_version?: number
    }
  | {
      op: 'patch'
      id: number
      patch: EntryPatch
      expected_version?: number
      /**
       * #335 case 4: the edit form and the quick note send minute-precision
       * times. With this flag a time that equals the current one when both
       * are cut to the minute counts as unchanged, so a form that sends back
       * the displayed time cannot shorten the entry. Only those callers set it.
       */
      from_form?: boolean
    }
  | { op: 'delete'; id: number; expected_version?: number }
  | { op: 'undelete'; id: number; expected_version?: number }

export interface StartResult extends EntryView {
  /** The entry that ran and was sealed at the new start, or null. */
  stopped: EntryView | null
}

// ── messages ────────────────────────────────────────────────────────────────

/** An MCP edit whose entry changed while the owner was being asked (#311, #335). */
export const STALE_EDIT_ERROR =
  'Der Eintrag hat sich während der Rückfrage geändert. Bitte die Änderung erneut anfragen.'

/**
 * Message when an edit of one half of a split entry moves the time at the
 * midnight cut — that edge belongs to the entry, not to the half (#311).
 */
export const SPLIT_EDGE_ERROR =
  'Dieser Eintrag ist um Mitternacht geteilt, und die Grenze um 0:00 lässt sich an einer Hälfte nicht verschieben. ' +
  'Den Beginn bitte an der ersten Hälfte ändern, das Ende an der zweiten.'

export const RUNNING_EDIT_ERROR =
  'Laufende Einträge können nicht bearbeitet werden — erst den Timer stoppen'

export const NOT_RUNNING_ERROR = 'Eintrag läuft nicht'

export const OVERLAP_ERROR = 'Eintrag überlappt mit einem bestehenden Eintrag desselben Kunden'

/** An undelete whose calendar anchor a later import has reused (4.1). */
export const ANCHOR_REUSED_ERROR =
  'Der Termin dieses Eintrags wurde inzwischen erneut übernommen; der Eintrag lässt sich nicht wiederherstellen'

export const FUTURE_START_TOLERANCE_MS = 60_000

// ── reading ─────────────────────────────────────────────────────────────────

interface EntryRow {
  id: number
  created_at: string
  created_source: string
  graph_event_id: string | null
  heartbeat_at: string | null
  is_deleted: number
  version_id: number
  version_no: number
  state: 'open' | 'sealed'
  deleted: number
  client_id: number
  project_id: number | null
  description: string
  started_at: string
  stopped_at: string | null
  tags: string
  reference: string
  billable: number
  private_note: string
  written_at: string
  source: string
  reason: string | null
}

/** The entry with its current version and segments, deleted ones included. */
export function readEntry(db: Db, id: number): EntryView | null {
  const row = db
    .prepare(
      `SELECT e.id, e.created_at, e.created_source, e.graph_event_id, e.heartbeat_at, e.is_deleted,
              v.id AS version_id, v.version_no, v.state, v.deleted, v.client_id, v.project_id,
              v.description, v.started_at, v.stopped_at, v.tags, v.reference, v.billable,
              v.private_note, v.written_at, v.source, v.reason
         FROM entry e JOIN entry_version v ON v.id = e.current_version_id
        WHERE e.id = ?`
    )
    .get(id) as EntryRow | undefined
  if (!row) return null
  const segments = db
    .prepare(
      `SELECT seq, segment_date, started_at, stopped_at FROM entry_segment
        WHERE version_id = ? ORDER BY seq`
    )
    .all(row.version_id) as EntrySegmentView[]
  const { is_deleted, deleted, ...rest } = row
  return {
    ...rest,
    deleted: is_deleted === 1 || deleted === 1,
    heartbeat_at: row.state === 'open' ? row.heartbeat_at : null,
    segments,
    billed: false
  }
}

/**
 * The entry in the shape the 1.x IPC and webhook contracts expect (P3
 * replaces it): today's columns with the entry's whole range, `link_id` and
 * `deleted_at` NULL, plus the 2.0 fields. `heartbeat_at` equals `stopped_at`
 * once sealed, as 1.x wrote at every stop.
 */
export type LegacyEntry = Entry & {
  graph_event_id: string | null
  segment_seq: number
  version_id: number
  version_no: number
  segment_count: number
  segments: EntrySegmentView[]
}

export function toLegacyEntry(v: EntryView): LegacyEntry {
  return {
    id: v.id,
    client_id: v.client_id,
    description: v.description,
    started_at: v.started_at,
    stopped_at: v.stopped_at,
    heartbeat_at: v.state === 'open' ? v.heartbeat_at : v.stopped_at,
    rounded_min: null,
    deleted_at: v.deleted ? v.written_at : null,
    created_at: v.created_at,
    link_id: null,
    tags: v.tags,
    reference: v.reference,
    billable: v.billable,
    private_note: v.private_note,
    project_id: v.project_id,
    graph_event_id: v.graph_event_id,
    segment_seq: 0,
    version_id: v.version_id,
    version_no: v.version_no,
    segment_count: v.segments.length,
    segments: v.segments
  }
}

// ── validation pieces ───────────────────────────────────────────────────────

const toIso = (v: string): string | null => {
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}
const minuteOf = (iso: string): number => Math.floor(Date.parse(iso) / 60_000)

function checkFieldLimits(c: {
  description: string
  reference: string
  private_note: string
}): string | null {
  if ((c.description ?? '').length > MAX_DESCRIPTION_LEN) {
    return `Beschreibung überschreitet ${MAX_DESCRIPTION_LEN} Zeichen`
  }
  if ((c.reference ?? '').length > MAX_REFERENCE_LEN) {
    return `Referenz überschreitet ${MAX_REFERENCE_LEN} Zeichen`
  }
  if ((c.private_note ?? '').length > MAX_NOTE_LEN) {
    return `Notiz überschreitet ${MAX_NOTE_LEN} Zeichen`
  }
  return null
}

function checkClientAndProject(
  db: Db,
  client_id: number,
  project_id: number | null
): string | null {
  const clientRow = db.prepare(`SELECT id FROM clients WHERE id = ?`).get(client_id) as
    | { id: number }
    | undefined
  if (!clientRow) return 'Kunde existiert nicht'
  if (project_id != null) return validateProjectForClient(db, project_id, client_id)
  return null
}

/** The manual-entry range rules (5, step 2): parse, not in the future, 24 h cap. */
function checkRange(started_at: string, stopped_at: string): string | null {
  const start = new Date(started_at)
  const stop = new Date(stopped_at)
  if (Number.isNaN(start.getTime())) return 'Startzeit ist ungültig'
  if (Number.isNaN(stop.getTime())) return 'Endzeit ist ungültig'
  if (start.getTime() > Date.now()) return 'Startzeit darf nicht in der Zukunft liegen'
  if (stop.getTime() <= start.getTime()) return 'Endzeit muss nach der Startzeit liegen'
  if ((stop.getTime() - start.getTime()) / 1000 > MAX_DURATION_SECONDS) {
    return 'Dauer überschreitet 24 Stunden'
  }
  return null
}

/**
 * Overlap: any current segment of a live entry of the same client that
 * intersects [start, stop). A RUNNING entry (stopped_at NULL) counts as
 * open-ended: it will end after now, so anything after its start overlaps it.
 * `excludeId` leaves the entry being written out of the check.
 */
function checkOverlap(
  db: Db,
  client_id: number,
  started_at: string,
  stopped_at: string,
  excludeId: number | null
): string | null {
  const overlap = db
    .prepare(
      `SELECT id FROM entries
        WHERE client_id = ? AND started_at < ? AND (stopped_at IS NULL OR stopped_at > ?)
          AND id != ? LIMIT 1`
    )
    .get(client_id, stopped_at, started_at, excludeId ?? -1)
  return overlap ? OVERLAP_ERROR : null
}

/**
 * Validate a manual entry's full range: the rules `create` applies, also used
 * by the MCP bridge for its preview. Returns a German error message string, or
 * null when valid. `excludeId` lets an edit skip the entry it changes.
 */
export function validateManualEntry(
  db: Db,
  input: {
    client_id: number
    description: string
    started_at: string
    stopped_at: string
    reference?: string
    private_note?: string
    project_id?: number | null
  },
  excludeId?: number
): string | null {
  const rangeErr = checkRange(input.started_at, input.stopped_at)
  if (rangeErr) return rangeErr
  const limitErr = checkFieldLimits({
    description: input.description ?? '',
    reference: input.reference ?? '',
    private_note: input.private_note ?? ''
  })
  if (limitErr) return limitErr
  const cpErr = checkClientAndProject(db, input.client_id, input.project_id ?? null)
  if (cpErr) return cpErr
  return checkOverlap(
    db,
    input.client_id,
    toIso(input.started_at)!,
    toIso(input.stopped_at)!,
    excludeId ?? null
  )
}

/**
 * A project may only be attached to an entry of the client it belongs to
 * (#133; same rule as clientDomains.learnDomain). Orphaned projects
 * (client_id NULL) fail this on purpose. Returns a German error message
 * string, or null when valid.
 */
export function validateProjectForClient(
  db: Db,
  project_id: number,
  client_id: number
): string | null {
  const row = db
    .prepare(`SELECT id FROM projects WHERE id = ? AND client_id = ?`)
    .get(project_id, client_id) as { id: number } | undefined
  return row ? null : 'Projekt gehört nicht zu diesem Kunden'
}

// ── writing ─────────────────────────────────────────────────────────────────

type SegmentBounds = {
  started_at: string
  stopped_at: string | null
  /** Set on a segment copied from a stored version; a new cut has none. */
  segment_date?: string
}

/**
 * The day segments of a sealed range, from `splitAtMidnight` as today. A
 * zero-length range (crash recovery without a heartbeat) is one segment.
 */
function rangeSegments(startIso: string, stopIso: string): SegmentBounds[] {
  if (Date.parse(stopIso) <= Date.parse(startIso)) {
    return [{ started_at: startIso, stopped_at: stopIso }]
  }
  return splitAtMidnight(new Date(startIso), new Date(stopIso)).map((s) => ({
    started_at: s.start.toISOString(),
    stopped_at: s.stop.toISOString()
  }))
}

const CONTENT_KEYS = [
  'client_id',
  'project_id',
  'description',
  'started_at',
  'stopped_at',
  'tags',
  'reference',
  'billable',
  'private_note'
] as const

function contentOf(v: EntryContent): EntryContent {
  return Object.fromEntries(CONTENT_KEYS.map((k) => [k, v[k]])) as unknown as EntryContent
}

function sameContent(a: EntryContent, b: EntryContent): boolean {
  return CONTENT_KEYS.every((k) => a[k] === b[k])
}

/** `created_source` of a new entry from who writes it (4.1). */
function createdSourceOf(source: WriteSource): string {
  switch (source) {
    case 'import':
    case 'mcp':
    case 'controller':
      return source
    default:
      return 'app'
  }
}

/** The one write function (section 5). Each operation runs in one transaction. */
export function writeEntry(
  db: Db,
  op: Extract<WriteOp, { op: 'start' }>,
  ctx: WriteCtx
): IpcResult<StartResult>
export function writeEntry(db: Db, op: WriteOp, ctx: WriteCtx): IpcResult<EntryView>
export function writeEntry(db: Db, op: WriteOp, ctx: WriteCtx): IpcResult<EntryView> {
  const now = ctx.now ?? new Date().toISOString()
  switch (op.op) {
    case 'create':
      return createEntry(db, op.fields, op.graph_event_id ?? null, ctx, now)
    case 'start':
      return startEntry(db, op.fields, ctx, now)
    case 'seal':
      return sealEntry(db, op.id, op.stopped_at, ctx, now)
    case 'amend':
      return amendEntry(db, op, ctx, now)
    case 'patch':
      return patchEntry(db, op, ctx, now)
    case 'delete':
      return deleteVersion(db, op.id, op.expected_version, ctx, now)
    case 'undelete':
      return undeleteVersion(db, op.id, op.expected_version, ctx, now)
  }
}

const insertVersionSql = `
  INSERT INTO entry_version (entry_id, version_no, state, deleted, client_id, project_id, description,
    started_at, stopped_at, tags, reference, billable, private_note, written_at, source, reason)
  VALUES (@entry_id, @version_no, @state, @deleted, @client_id, @project_id, @description,
    @started_at, @stopped_at, @tags, @reference, @billable, @private_note, @written_at, @source, @reason)`
const insertSegmentSql = `
  INSERT INTO entry_segment (version_id, seq, segment_date, started_at, stopped_at) VALUES (?, ?, ?, ?, ?)`

/**
 * A segment cut anew gets its local date from this zone; a segment copied
 * from the current version keeps the date it was stored with (4.3: the copy
 * takes the segments "as they are"). Recomputing it after a zone change
 * could give two segments of one version the same date and fail on
 * UNIQUE(version_id, segment_date) for a description change or a delete.
 */
function writeSegments(db: Db, versionId: number, segments: SegmentBounds[]): void {
  const ins = db.prepare(insertSegmentSql)
  segments.forEach((s, seq) =>
    ins.run(
      versionId,
      seq,
      s.segment_date ?? localDateKey(new Date(s.started_at)),
      s.started_at,
      s.stopped_at
    )
  )
}

/** The current version's segments, to be copied unchanged into the next version. */
function copiedSegments(cur: EntryView): SegmentBounds[] {
  return cur.segments.map((s) => ({
    started_at: s.started_at,
    stopped_at: s.stopped_at,
    segment_date: s.segment_date
  }))
}

/**
 * The overlap check of an entry whose segments stay as they are (a client
 * change without a time change, an undelete): segment by segment, so an
 * entry with a gap between its segments (a migrated three-parter whose
 * middle part was deleted in 1.x) is not refused for an entry in that gap.
 */
function checkOverlapOfSegments(
  db: Db,
  client_id: number,
  segments: ReadonlyArray<SegmentBounds>,
  excludeId: number
): string | null {
  for (const s of segments) {
    const err = checkOverlap(db, client_id, s.started_at, s.stopped_at ?? '', excludeId)
    if (err) return err
  }
  return null
}

/** Append a version to an existing entry and make it current. Caller holds the transaction. */
function appendVersion(
  db: Db,
  cur: EntryView,
  content: EntryContent,
  opts: { deleted: boolean; segments: SegmentBounds[]; source: string; reason: string | null },
  now: string
): void {
  const versionId = Number(
    db.prepare(insertVersionSql).run({
      ...content,
      entry_id: cur.id,
      version_no: cur.version_no + 1,
      state: 'sealed',
      deleted: opts.deleted ? 1 : 0,
      written_at: now,
      source: opts.source,
      reason: opts.reason
    }).lastInsertRowid
  )
  writeSegments(db, versionId, opts.segments)
  db.prepare(
    `UPDATE entry SET current_version_id = ?, is_deleted = ?, heartbeat_at = NULL WHERE id = ?`
  ).run(versionId, opts.deleted ? 1 : 0, cur.id)
}

function checkExpectedVersion(cur: EntryView, expected: number | undefined): string | null {
  return expected !== undefined && expected !== cur.version_no ? STALE_EDIT_ERROR : null
}

function createEntry(
  db: Db,
  f: CreateFields,
  graphEventId: string | null,
  ctx: WriteCtx,
  now: string
): IpcResult<EntryView> {
  const err = validateManualEntry(db, f)
  if (err) return fail(err)
  const content: EntryContent = {
    client_id: f.client_id,
    project_id: f.project_id ?? null,
    description: f.description.trim(),
    started_at: toIso(f.started_at)!,
    stopped_at: toIso(f.stopped_at)!,
    tags: f.tags ?? '',
    reference: f.reference ?? '',
    billable: f.billable ?? 1,
    private_note: f.private_note ?? ''
  }
  const tx = db.transaction((): EntryView => {
    const entryId = Number(
      db
        .prepare(
          `INSERT INTO entry (created_at, created_source, current_version_id, is_deleted, heartbeat_at, graph_event_id)
           VALUES (?, ?, 0, 0, NULL, ?)`
        )
        .run(now, createdSourceOf(ctx.source), graphEventId).lastInsertRowid
    )
    const versionId = Number(
      db.prepare(insertVersionSql).run({
        ...content,
        entry_id: entryId,
        version_no: 1,
        state: 'sealed',
        deleted: 0,
        written_at: now,
        source: ctx.source,
        reason: ctx.reason ?? null
      }).lastInsertRowid
    )
    writeSegments(db, versionId, rangeSegments(content.started_at, content.stopped_at!))
    db.prepare(`UPDATE entry SET current_version_id = ? WHERE id = ?`).run(versionId, entryId)
    return readEntry(db, entryId)!
  })
  return ok(tx())
}

/** Live entries whose current version is open, newest first. */
function liveRunning(db: Db): Array<{ id: number; started_at: string }> {
  return db
    .prepare(
      `SELECT e.id, v.started_at FROM entry e JOIN entry_version v ON v.id = e.current_version_id
        WHERE e.is_deleted = 0 AND v.state = 'open' ORDER BY v.started_at DESC`
    )
    .all() as Array<{ id: number; started_at: string }>
}

/**
 * Start a running timer and seal whatever runs — ONE instant for both (B1):
 * the running entry ends exactly where the new one begins, no gap, no overlap.
 * Both writes share one transaction: if the insert fails, the old entry keeps
 * running. A start before the running entry's own start is refused (the old
 * entry would get a negative duration), so is a start more than
 * `FUTURE_START_TOLERANCE_MS` ahead (MCP `start_timer` takes a free start).
 */
function startEntry(
  db: Db,
  f: CreateEntryInput,
  ctx: WriteCtx,
  now: string
): IpcResult<StartResult> {
  const cpErr = checkClientAndProject(db, f.client_id, f.project_id ?? null)
  if (cpErr) return fail(cpErr)
  // Stored like every other write path: UTC with milliseconds and `Z`. Range
  // queries compare `started_at` as strings against such instants, so a value
  // kept as sent (`…T00:30:00+02:00` from an MCP client) would sort into the
  // wrong day or month.
  const start = new Date(f.started_at)
  if (Number.isNaN(start.getTime())) return fail('Startzeit ist ungültig')
  if (start.getTime() > Date.now() + FUTURE_START_TOLERANCE_MS) {
    return fail('Startzeit liegt in der Zukunft')
  }
  const startedAt = start.toISOString()
  const running = liveRunning(db)
  if (running.some((r) => Date.parse(r.started_at) > start.getTime())) {
    return fail('Startzeit liegt vor dem Beginn des laufenden Eintrags')
  }
  const tx = db.transaction((): StartResult => {
    let stopped: EntryView | null = null
    for (const r of running) {
      const sealed = sealEntry(db, r.id, startedAt, ctx, now)
      if (!sealed.ok) throw new Error(sealed.error)
      // The newest live one, the same pick as stopRunningTimer. Normally
      // there is exactly one.
      if (!stopped) stopped = sealed.data
    }
    const entryId = Number(
      db
        .prepare(
          `INSERT INTO entry (created_at, created_source, current_version_id, is_deleted, heartbeat_at, graph_event_id)
           VALUES (?, 'timer', 0, 0, ?, NULL)`
        )
        .run(now, startedAt).lastInsertRowid
    )
    const versionId = Number(
      db.prepare(insertVersionSql).run({
        entry_id: entryId,
        version_no: 1,
        state: 'open',
        deleted: 0,
        client_id: f.client_id,
        project_id: f.project_id ?? null,
        description: f.description,
        started_at: startedAt,
        stopped_at: null,
        tags: '',
        reference: '',
        billable: 1,
        private_note: '',
        written_at: now,
        source: ctx.source,
        reason: ctx.reason ?? null
      }).lastInsertRowid
    )
    writeSegments(db, versionId, [{ started_at: startedAt, stopped_at: null }])
    db.prepare(`UPDATE entry SET current_version_id = ? WHERE id = ?`).run(versionId, entryId)
    return { ...readEntry(db, entryId)!, stopped }
  })
  return ok(tx())
}

/**
 * Seal the open version (D4): only `stopped_at >= started_at`, no 24 h cap and
 * no overlap check, as `stopEntry` did; zero length is allowed because crash
 * recovery without a heartbeat seals at the start. The segments are rewritten
 * from the midnight split (OQ2) while the version is still open, then the
 * version is sealed, which the trigger on sealed versions allows exactly once.
 */
function sealEntry(
  db: Db,
  id: number,
  stoppedAt: string,
  ctx: WriteCtx,
  now: string
): IpcResult<EntryView> {
  const cur = readEntry(db, id)
  if (!cur || cur.deleted) return fail('Eintrag existiert nicht')
  if (cur.state !== 'open') return fail(NOT_RUNNING_ERROR)
  const stop = toIso(stoppedAt)
  if (stop === null) return fail('Endzeit ist ungültig')
  if (Date.parse(stop) < Date.parse(cur.started_at)) return fail('Endzeit liegt vor der Startzeit')
  const tx = db.transaction((): EntryView => {
    db.prepare(`DELETE FROM entry_segment WHERE version_id = ?`).run(cur.version_id)
    writeSegments(db, cur.version_id, rangeSegments(cur.started_at, stop))
    db.prepare(
      `UPDATE entry_version SET state = 'sealed', stopped_at = ?, written_at = ?, source = ?, reason = ?
        WHERE id = ?`
    ).run(stop, now, ctx.source, ctx.reason ?? null, cur.version_id)
    db.prepare(`UPDATE entry SET heartbeat_at = NULL WHERE id = ?`).run(id)
    return readEntry(db, id)!
  })
  return ok(tx())
}

function definedPatch(patch: EntryPatch): EntryPatch {
  const out: Record<string, unknown> = {}
  for (const k of CONTENT_KEYS) {
    const v = (patch as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  return out as EntryPatch
}

/** Amend the open version in place: the field limits and the project rule (5, step 2). */
function amendEntry(
  db: Db,
  op: Extract<WriteOp, { op: 'amend' }>,
  ctx: WriteCtx,
  now: string
): IpcResult<EntryView> {
  const cur = readEntry(db, op.id)
  if (!cur || cur.deleted) return fail('Eintrag existiert nicht')
  if (cur.state !== 'open') return fail(NOT_RUNNING_ERROR)
  const stale = checkExpectedVersion(cur, op.expected_version)
  if (stale) return fail(stale)
  const { started_at: _s, stopped_at: _e, ...fields } = definedPatch(op.patch)
  void _s
  void _e
  const merged: EntryContent = { ...contentOf(cur), ...fields }
  merged.description = merged.description.trim()
  const err =
    checkFieldLimits(merged) ?? checkClientAndProject(db, merged.client_id, merged.project_id)
  if (err) return fail(err)
  if (sameContent(merged, contentOf(cur))) return ok(cur)
  db.prepare(
    `UPDATE entry_version
        SET client_id = @client_id, project_id = @project_id, description = @description,
            tags = @tags, reference = @reference, billable = @billable, private_note = @private_note,
            written_at = @written_at, source = @source, reason = @reason
      WHERE id = @id`
  ).run({
    ...merged,
    id: cur.version_id,
    written_at: now,
    source: ctx.source,
    reason: ctx.reason ?? null
  })
  return ok(readEntry(db, op.id)!)
}

/**
 * A new version of a sealed entry (D3). Validation with the rules of the
 * operation (5, step 2): a changed range gets the manual-entry rules and the
 * overlap check against the other live entries of the client; otherwise the
 * field limits and the project rule only, plus the overlap check against the
 * new client's entries when the patch moves the entry to another client. The
 * range itself then stays as it is, even for a sealed timer over 24 hours or
 * a zero-length recovered entry.
 */
function patchEntry(
  db: Db,
  op: Extract<WriteOp, { op: 'patch' }>,
  ctx: WriteCtx,
  now: string
): IpcResult<EntryView> {
  const cur = readEntry(db, op.id)
  if (!cur || cur.deleted) return fail('Eintrag existiert nicht')
  if (cur.state !== 'sealed') return fail(RUNNING_EDIT_ERROR)
  const stale = checkExpectedVersion(cur, op.expected_version)
  if (stale) return fail(stale)
  const fields = definedPatch(op.patch)
  if (fields.started_at !== undefined) {
    const iso = toIso(fields.started_at)
    if (iso === null) return fail('Startzeit ist ungültig')
    fields.started_at = iso
  }
  if (fields.stopped_at !== undefined && fields.stopped_at !== null) {
    const iso = toIso(fields.stopped_at)
    if (iso === null) return fail('Endzeit ist ungültig')
    fields.stopped_at = iso
  }
  if (op.from_form) {
    // #335 case 4: the displayed (minute) time sent back is not a change.
    if (
      fields.started_at !== undefined &&
      minuteOf(fields.started_at) === minuteOf(cur.started_at)
    ) {
      delete fields.started_at
    }
    if (
      fields.stopped_at !== undefined &&
      fields.stopped_at !== null &&
      minuteOf(fields.stopped_at) === minuteOf(cur.stopped_at!)
    ) {
      delete fields.stopped_at
    }
  }
  const merged: EntryContent = { ...contentOf(cur), ...fields }
  merged.description = merged.description.trim()
  const timesChanged = merged.started_at !== cur.started_at || merged.stopped_at !== cur.stopped_at
  if (timesChanged) {
    const err = validateManualEntry(
      db,
      { ...merged, stopped_at: merged.stopped_at!, project_id: merged.project_id },
      cur.id
    )
    if (err) return fail(err)
  } else {
    const err =
      checkFieldLimits(merged) ??
      checkClientAndProject(db, merged.client_id, merged.project_id) ??
      (merged.client_id !== cur.client_id
        ? checkOverlapOfSegments(db, merged.client_id, cur.segments, cur.id)
        : null)
    if (err) return fail(err)
  }
  if (sameContent(merged, contentOf(cur))) return ok(cur)
  const segments: SegmentBounds[] = timesChanged
    ? rangeSegments(merged.started_at, merged.stopped_at!)
    : copiedSegments(cur)
  const tx = db.transaction((): EntryView => {
    appendVersion(
      db,
      cur,
      merged,
      { deleted: false, segments, source: ctx.source, reason: ctx.reason ?? null },
      now
    )
    return readEntry(db, cur.id)!
  })
  return ok(tx())
}

/** A refused write inside a transaction: thrown to roll it back, caught at its edge. */
class RefusedWrite extends Error {}

/**
 * A delete is a version with `deleted = 1` that carries the previous content
 * (4.2). A running entry is sealed at the instant of the delete first, in the
 * same transaction, so that no version of an entry in the trash is ever
 * open: the open version itself gets sealed (4.2: "a version is open or
 * sealed, and only the open one changes"), then the delete version is
 * appended with the same content. Crash recovery and the migration (L5)
 * treat the shape the same way.
 */
function deleteVersion(
  db: Db,
  id: number,
  expected: number | undefined,
  ctx: WriteCtx,
  now: string
): IpcResult<EntryView> {
  const open = readEntry(db, id)
  // An entry already in the trash (a view that has not refreshed) is not
  // deleted again. The answer is the same as MCP gives for a trashed entry.
  if (!open || open.deleted) return fail('Eintrag existiert nicht')
  const stale = checkExpectedVersion(open, expected)
  if (stale) return fail(stale)
  const tx = db.transaction((): EntryView => {
    let cur = open
    if (cur.state === 'open') {
      const stop = Date.parse(now) < Date.parse(cur.started_at) ? cur.started_at : now
      const sealed = sealEntry(db, id, stop, ctx, now)
      if (!sealed.ok) throw new RefusedWrite(sealed.error)
      cur = sealed.data
    }
    appendVersion(
      db,
      cur,
      contentOf(cur),
      {
        deleted: true,
        segments: copiedSegments(cur),
        source: ctx.source,
        reason: ctx.reason ?? null
      },
      now
    )
    return readEntry(db, id)!
  })
  try {
    return ok(tx())
  } catch (e) {
    if (e instanceof RefusedWrite) return fail(e.message)
    throw e
  }
}

/**
 * Restore: a version with `deleted = 0` and the trashed content. Runs the
 * overlap check against the current segments of the client's other live
 * entries, as `create` does (#335 case 2), and refuses an entry whose
 * calendar anchor a later import has reused (4.1).
 */
function undeleteVersion(
  db: Db,
  id: number,
  expected: number | undefined,
  ctx: WriteCtx,
  now: string
): IpcResult<EntryView> {
  const cur = readEntry(db, id)
  if (!cur) return fail('Eintrag existiert nicht')
  if (!cur.deleted) return ok(cur)
  const stale = checkExpectedVersion(cur, expected)
  if (stale) return fail(stale)
  const overlap = checkOverlapOfSegments(db, cur.client_id, cur.segments, cur.id)
  if (overlap) return fail(overlap)
  if (cur.graph_event_id !== null) {
    const taken = db
      .prepare(`SELECT id FROM entry WHERE graph_event_id = ? AND is_deleted = 0 AND id != ?`)
      .get(cur.graph_event_id, cur.id)
    if (taken) return fail(ANCHOR_REUSED_ERROR)
  }
  const segments = copiedSegments(cur)
  const tx = db.transaction((): EntryView => {
    appendVersion(
      db,
      cur,
      contentOf(cur),
      { deleted: false, segments, source: ctx.source, reason: ctx.reason ?? null },
      now
    )
    return readEntry(db, id)!
  })
  return ok(tx())
}

/**
 * The running timer's heartbeat lives on the entry, not in a version (D4):
 * no version noise every few seconds. Only an open entry takes it.
 */
export function heartbeat(db: Db, id: number, now = new Date().toISOString()): void {
  db.prepare(
    `UPDATE entry SET heartbeat_at = ?
      WHERE id = ? AND is_deleted = 0
        AND current_version_id IN (SELECT id FROM entry_version WHERE state = 'open')`
  ).run(now, id)
}

// ── 1.x entry points, as wrappers ───────────────────────────────────────────

/** Create a manual (already-stopped) entry. Mirrors the `entries:create` handler. */
export function createManualEntry(
  db: Db,
  input: CreateManualEntryInput,
  ctx?: Partial<WriteCtx>
): IpcResult<Entry> {
  const res = writeEntry(
    db,
    { op: 'create', fields: input },
    { source: ctx?.source ?? input.source ?? 'app', reason: ctx?.reason, now: ctx?.now }
  )
  return res.ok ? ok(toLegacyEntry(res.data)) : res
}

type Range = { started_at: string; stopped_at: string }

/**
 * What an edit of entry `given.id` really changes (#311): the input mapped
 * onto the whole entry, and the entry's range before the edit. The calendar
 * drawer opens one segment of a midnight-split entry and sends that segment's
 * times, naming the segment in `segment_seq`; an edge at a midnight cut sent
 * back unchanged is no change, a moved one is refused (SPLIT_EDGE_ERROR),
 * only the entry's outer edges move. Without `segment_seq` (MCP, which fills
 * unchanged times from the entry's range) the times apply to the entry as
 * given. MCP calls this before its preview, so the owner confirms the change
 * that is applied.
 *
 * An unusable range (invalid, or not ending after it starts) is passed on
 * unchanged, so validation reports it in its own words.
 */
export function resolveEditRange(
  db: Db,
  given: UpdateEntryInput
): { input: UpdateEntryInput; before: Range; entry: EntryView } | { error: string } {
  const cur = readEntry(db, given.id)
  if (!cur || cur.deleted) return { error: 'Eintrag existiert nicht' }
  const before = { started_at: cur.started_at, stopped_at: cur.stopped_at ?? '' }
  const seq = given.segment_seq
  if (seq === undefined || cur.segments.length < 2 || cur.state === 'open') {
    return { input: given, before, entry: cur }
  }
  const half = cur.segments[seq]
  if (!half) return { error: 'Eintrag existiert nicht' }
  const start = given.started_at === undefined ? NaN : Date.parse(given.started_at)
  const stop = given.stopped_at === undefined ? NaN : Date.parse(given.stopped_at)
  if (
    given.started_at !== undefined &&
    given.stopped_at !== undefined &&
    (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start)
  ) {
    return { input: given, before, entry: cur }
  }
  const same = (a: string, b: string): boolean =>
    given.from_form ? minuteOf(a) === minuteOf(b) : Date.parse(a) === Date.parse(b)
  const atStart = seq === 0
  const atStop = seq === cur.segments.length - 1
  if (!atStart && given.started_at !== undefined && !same(given.started_at, half.started_at)) {
    return { error: SPLIT_EDGE_ERROR }
  }
  if (!atStop && given.stopped_at !== undefined && !same(given.stopped_at, half.stopped_at!)) {
    return { error: SPLIT_EDGE_ERROR }
  }
  return {
    input: {
      ...given,
      started_at: atStart ? given.started_at : undefined,
      stopped_at: atStop ? given.stopped_at : undefined
    },
    before,
    entry: cur
  }
}

/**
 * Update an entry. Mirrors `entries:update`: the edit form (full field set,
 * `from_form`), the quick note (description only), the idle prompt (a stop
 * time for the running entry) and the MCP bridge all come through here.
 * A sealed entry gets a `patch`; a running one is amended and, when the
 * input carries a stop time, sealed at it (the idle prompt, #313: no field
 * can be lost, because none has to be sent).
 */
export function updateManualEntry(
  db: Db,
  given: UpdateEntryInput,
  ctx?: Partial<WriteCtx>
): IpcResult<Entry> {
  const resolved = resolveEditRange(db, given)
  if ('error' in resolved) return fail(resolved.error)
  const { input, entry: cur } = resolved
  const patch: EntryPatch = definedPatch({
    client_id: input.client_id,
    project_id: input.project_id,
    description: input.description,
    started_at: input.started_at,
    stopped_at: input.stopped_at,
    tags: input.tags,
    reference: input.reference,
    billable: input.billable,
    private_note: input.private_note
  })
  const wctx: WriteCtx = {
    source: ctx?.source ?? given.source ?? 'app',
    reason: ctx?.reason ?? given.reason,
    now: ctx?.now
  }
  if (cur.state === 'open') {
    const { started_at, stopped_at, ...fields } = patch
    if (started_at !== undefined && toIso(started_at) !== cur.started_at) {
      return fail(RUNNING_EDIT_ERROR)
    }
    // Amend and seal are one write: a refused stop time rolls the amend back
    // (the transaction rolls back on a throw), so nothing is written on a
    // refusal (Codex counter-check on P2).
    const tx = db.transaction((): EntryView => {
      let view: EntryView = cur
      if (Object.keys(fields).length > 0) {
        const amended = writeEntry(
          db,
          { op: 'amend', id: cur.id, patch: fields, expected_version: given.expected_version },
          wctx
        )
        if (!amended.ok) throw new RefusedWrite(amended.error)
        view = amended.data
      }
      if (stopped_at !== undefined) {
        const sealed = writeEntry(db, { op: 'seal', id: cur.id, stopped_at }, wctx)
        if (!sealed.ok) throw new RefusedWrite(sealed.error)
        view = sealed.data
      }
      return view
    })
    try {
      return ok(toLegacyEntry(tx()))
    } catch (e) {
      if (e instanceof RefusedWrite) return fail(e.message)
      throw e
    }
  }
  const res = writeEntry(
    db,
    {
      op: 'patch',
      id: cur.id,
      patch,
      expected_version: given.expected_version,
      from_form: given.from_form
    },
    wctx
  )
  return res.ok ? ok(toLegacyEntry(res.data)) : res
}

/** Start a timer and seal whatever runs at the same instant (B1). Mirrors `entries:switch`. */
export function switchTimer(
  db: Db,
  input: CreateEntryInput,
  ctx?: Partial<WriteCtx>
): IpcResult<SwitchTimerResult> {
  const res = writeEntry(db, { op: 'start', fields: input }, { source: ctx?.source ?? 'app' })
  if (!res.ok) return res
  return ok({
    entry: toLegacyEntry(res.data),
    stopped: res.data.stopped ? toLegacyEntry(res.data.stopped) : null
  })
}

/**
 * switchTimer plus its notifications, in the order a receiver needs them:
 * `timer.stopped` for the ended entry BEFORE `timer.started` for the new one.
 * `emit` is fire-and-forget (the IPC layer passes `emitWebhooks`); it only
 * runs after the transaction committed.
 */
export function switchTimerAndNotify(
  db: Db,
  input: CreateEntryInput,
  emit: (event: 'timer.stopped' | 'timer.started', entry: Entry) => void,
  ctx?: Partial<WriteCtx>
): IpcResult<SwitchTimerResult> {
  const res = switchTimer(db, input, ctx)
  if (res.ok) {
    if (res.data.stopped) emit('timer.stopped', res.data.stopped)
    emit('timer.started', res.data.entry)
  }
  return res
}

/** Start a running timer (stops any running entry at the same instant). Mirrors `entries:start`. */
export function startTimer(
  db: Db,
  input: CreateEntryInput,
  ctx?: Partial<WriteCtx>
): IpcResult<Entry> {
  const res = switchTimer(db, input, ctx)
  return res.ok ? ok(res.data.entry) : res
}

/** Stop a specific entry by id (stamps now). Mirrors `entries:stop`. */
export function stopEntry(db: Db, id: number, ctx?: Partial<WriteCtx>): IpcResult<Entry> {
  const now = ctx?.now ?? new Date().toISOString()
  const res = writeEntry(
    db,
    { op: 'seal', id, stopped_at: now },
    { source: ctx?.source ?? 'app', reason: ctx?.reason, now }
  )
  return res.ok ? ok(toLegacyEntry(res.data)) : res
}

/** Stop the currently running timer, if any. Returns null when nothing runs. */
export function stopRunningTimer(db: Db, ctx?: Partial<WriteCtx>): IpcResult<Entry | null> {
  const running = liveRunning(db)[0]
  if (!running) return ok(null)
  const res = stopEntry(db, running.id, ctx)
  return res.ok ? ok(res.data) : res
}

/** Soft-delete an entry, all its segments with it. Mirrors `entries:delete`. */
export function deleteEntry(db: Db, id: number, ctx?: Partial<WriteCtx>): IpcResult<void> {
  const res = writeEntry(db, { op: 'delete', id }, { ...ctx, source: ctx?.source ?? 'app' })
  return res.ok ? ok(undefined) : res
}

/** Restore a soft-deleted entry. Mirrors `entries:undelete` (the toast's undo). */
export function undeleteEntry(db: Db, id: number, ctx?: Partial<WriteCtx>): IpcResult<Entry> {
  const res = writeEntry(db, { op: 'undelete', id }, { ...ctx, source: ctx?.source ?? 'app' })
  return res.ok ? ok(toLegacyEntry(res.data)) : res
}
