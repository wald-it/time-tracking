/**
 * Entry mutation core — extracted from the `entries:*` IPC handlers so both
 * the Electron IPC layer (src/main/ipc.ts) and the MCP write bridge
 * (src/main/mcpBridge.ts) can execute the exact same validated logic.
 *
 * Deliberately Electron-free: it takes a better-sqlite3 handle structurally,
 * imports only `crypto`, the shared midnight-split helper, and shared types.
 * That keeps it trivially unit-testable against an in-memory DB and safe to
 * import from a non-Electron context.
 *
 * Behaviour is identical to the previous inline handlers: validate the full
 * un-split range first, then split at local midnight into linked halves
 * (shared `link_id`), insert in one transaction, and return the first row.
 */
import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { splitAtMidnight } from '../shared/midnightSplit'
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

/**
 * Validate a manual entry's full (un-split) range. Returns a German error
 * message string, or null when valid. `excludeId` / `excludeLinkId` let the
 * update path skip the row(s) it's about to replace in the overlap check.
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
  excludeId?: number,
  excludeLinkId?: string
): string | null {
  const start = new Date(input.started_at)
  const stop = new Date(input.stopped_at)
  if (Number.isNaN(start.getTime())) return 'Startzeit ist ungültig'
  if (Number.isNaN(stop.getTime())) return 'Endzeit ist ungültig'
  const now = Date.now()
  if (start.getTime() > now) return 'Startzeit darf nicht in der Zukunft liegen'
  if (stop.getTime() <= start.getTime()) return 'Endzeit muss nach der Startzeit liegen'
  const durationSec = (stop.getTime() - start.getTime()) / 1000
  if (durationSec > MAX_DURATION_SECONDS) return 'Dauer überschreitet 24 Stunden'
  if ((input.description ?? '').length > MAX_DESCRIPTION_LEN) {
    return `Beschreibung überschreitet ${MAX_DESCRIPTION_LEN} Zeichen`
  }
  if ((input.reference ?? '').length > MAX_REFERENCE_LEN) {
    return `Referenz überschreitet ${MAX_REFERENCE_LEN} Zeichen`
  }
  if ((input.private_note ?? '').length > MAX_NOTE_LEN) {
    return `Notiz überschreitet ${MAX_NOTE_LEN} Zeichen`
  }
  const clientRow = db.prepare(`SELECT id FROM clients WHERE id = ?`).get(input.client_id) as
    | { id: number }
    | undefined
  if (!clientRow) return 'Kunde existiert nicht'
  if (input.project_id != null) {
    const pErr = validateProjectForClient(db, input.project_id, input.client_id)
    if (pErr) return pErr
  }
  // Overlap: any non-deleted entry of the same client whose time range
  // intersects [start, stop). Two intervals overlap iff
  //   existing.started_at < stop AND existing.stopped_at > start,
  // and a RUNNING entry (stopped_at NULL) counts as open-ended: it will end
  // after now, so anything after its start overlaps it. (It used to be
  // COALESCE(stopped_at, datetime('now')): SQLite's 'now' has a space where
  // the stored ISO values have a `T`, so the running entry compared as
  // already ended and a same-day backfill inside it went through.)
  const params: Array<string | number> = [input.client_id, input.stopped_at, input.started_at]
  let overlapSql = `SELECT id FROM entries
                     WHERE client_id = ? AND deleted_at IS NULL
                       AND started_at < ?
                       AND (stopped_at IS NULL OR stopped_at > ?)`
  if (excludeId !== undefined) {
    overlapSql += ` AND id != ?`
    params.push(excludeId)
  }
  if (excludeLinkId !== undefined) {
    overlapSql += ` AND (link_id IS NULL OR link_id != ?)`
    params.push(excludeLinkId)
  }
  const overlap = db.prepare(overlapSql).get(...params) as { id: number } | undefined
  if (overlap) return 'Eintrag überlappt mit einem bestehenden Eintrag desselben Kunden'
  return null
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

/**
 * Insert one or more time segments produced by `splitAtMidnight`. Single
 * segment → plain insert (link_id stays NULL). Multiple segments → all rows
 * share a fresh UUID `link_id`. Returns the FIRST inserted row (matching the
 * user's input.started_at). Caller must have validated the full range first.
 *
 * `graph_event_id` (#130c) goes on the FIRST segment only: the column carries a
 * unique index, so a midnight-split pair cannot both hold it — and one segment
 * is enough for the dedupe, which only asks "does any live row carry this id".
 *
 * `created_at` is null for a new entry (the column default applies) and the
 * entry's original value when an edit writes it anew (#299).
 */
export function insertEntrySegments(
  db: Db,
  input: { client_id: number; description: string },
  segments: Array<{ start: Date; stop: Date }>,
  tags = '',
  reference = '',
  billable = 1,
  private_note = '',
  project_id: number | null = null,
  graph_event_id: string | null = null,
  created_at: string | null = null
): Entry {
  const linkId = segments.length > 1 ? randomUUID() : null
  const description = input.description.trim()
  const insertStmt = db.prepare(
    `INSERT INTO entries (client_id, description, started_at, stopped_at, heartbeat_at, rounded_min, link_id, project_id, tags, reference, billable, private_note, graph_event_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
  )
  const tx = db.transaction((): Entry => {
    let firstId = 0
    for (const seg of segments) {
      const startedAt = seg.start.toISOString()
      const stoppedAt = seg.stop.toISOString()
      const info = insertStmt.run(
        input.client_id,
        description,
        startedAt,
        stoppedAt,
        stoppedAt,
        Math.round((seg.stop.getTime() - seg.start.getTime()) / 60000),
        linkId,
        project_id,
        tags,
        reference,
        billable,
        private_note,
        firstId === 0 ? graph_event_id : null,
        created_at
      )
      if (firstId === 0) firstId = Number(info.lastInsertRowid)
    }
    return db.prepare(`SELECT * FROM entries WHERE id = ?`).get(firstId) as Entry
  })
  return tx()
}

/** Create a manual (already-stopped) entry. Mirrors the `entries:create` handler. */
export function createManualEntry(db: Db, input: CreateManualEntryInput): IpcResult<Entry> {
  const err = validateManualEntry(db, input)
  if (err) return fail(err)
  const segments = splitAtMidnight(new Date(input.started_at), new Date(input.stopped_at))
  const row = insertEntrySegments(
    db,
    input,
    segments,
    input.tags ?? '',
    input.reference ?? '',
    input.billable ?? 1,
    input.private_note ?? '',
    input.project_id ?? null
  )
  return ok(row)
}

/** Update an entry (delete-and-reinsert with cross-midnight bookkeeping). Mirrors `entries:update`. */
export function updateManualEntry(db: Db, input: UpdateEntryInput): IpcResult<Entry> {
  const existing = db.prepare(`SELECT link_id FROM entries WHERE id = ?`).get(input.id) as
    | { link_id: string | null }
    | undefined
  if (!existing) return fail('Eintrag existiert nicht')
  const existingLinkId = existing.link_id ?? undefined
  const err = validateManualEntry(db, input, input.id, existingLinkId)
  if (err) return fail(err)
  const segments = splitAtMidnight(new Date(input.started_at), new Date(input.stopped_at))
  const tx = db.transaction((): Entry => {
    // #299: the reinsert gives the entry new rows, so what belongs to the
    // entry rather than to this edit is read first and carried over — the
    // calendar import anchor (otherwise the next preview offers the meeting
    // again) and the time the entry was first written. Of a midnight-split
    // pair, the anchor sits on one half and the earliest created_at counts.
    // One predicate for what is read and what is deleted.
    const [where, key] = existingLinkId ? ['link_id = ?', existingLinkId] : ['id = ?', input.id]
    const carried = db
      .prepare(
        `SELECT MAX(graph_event_id) AS graph_event_id, MIN(created_at) AS created_at
           FROM entries WHERE ${where}`
      )
      .get(key) as { graph_event_id: string | null; created_at: string | null }
    db.prepare(`DELETE FROM entries WHERE ${where}`).run(key)
    return insertEntrySegments(
      db,
      input,
      segments,
      input.tags ?? '',
      input.reference ?? '',
      input.billable ?? 1,
      input.private_note ?? '',
      input.project_id ?? null,
      carried.graph_event_id,
      carried.created_at
    )
  })
  return ok(tx())
}

/**
 * Start a running timer and stop whatever runs — ONE instant for both (B1).
 *
 * The running entry (if any) ends exactly where the new one begins:
 * `stopped_at = heartbeat_at = started_at` of the new entry, so a switch
 * leaves neither a gap nor an overlap. Both writes share one transaction: if
 * the insert fails, the old entry keeps running. `stopped` is the entry that
 * was ended (null when nothing ran), so callers can emit `timer.stopped` and
 * open the quick-note prompt for it.
 *
 * A start before the running entry's own start is refused — stopping there
 * would give the old entry a negative duration. So is a start more than
 * `FUTURE_START_TOLERANCE_MS` ahead: the running entry would end in the
 * future (MCP `start_timer` takes a free `started_at`).
 */
export const FUTURE_START_TOLERANCE_MS = 60_000

export function switchTimer(db: Db, input: CreateEntryInput): IpcResult<SwitchTimerResult> {
  const clientRow = db.prepare(`SELECT id FROM clients WHERE id = ?`).get(input.client_id) as
    | { id: number }
    | undefined
  if (!clientRow) return fail('Kunde existiert nicht')
  // Same rule as manual entries: a project must belong to the client.
  if (input.project_id != null) {
    const pErr = validateProjectForClient(db, input.project_id, input.client_id)
    if (pErr) return fail(pErr)
  }
  // Stored like every other write path: UTC with milliseconds and `Z`. Range
  // queries compare `started_at` as strings against such instants, so a value
  // kept as sent (`…T00:30:00+02:00` from an MCP client) would sort into the
  // wrong day or month.
  const start = new Date(input.started_at)
  if (Number.isNaN(start.getTime())) return fail('Startzeit ist ungültig')
  if (start.getTime() > Date.now() + FUTURE_START_TOLERANCE_MS) {
    return fail('Startzeit liegt in der Zukunft')
  }
  const startedAt = start.toISOString()
  const running = db
    .prepare(`SELECT id, started_at, deleted_at FROM entries WHERE stopped_at IS NULL`)
    .all() as Array<{ id: number; started_at: string; deleted_at: string | null }>
  // Only live entries: a soft-deleted row left running is invisible to the
  // user and must not block a start.
  if (running.some((r) => r.deleted_at === null && Date.parse(r.started_at) > start.getTime())) {
    return fail('Startzeit liegt vor dem Beginn des laufenden Eintrags')
  }
  const tx = db.transaction((): SwitchTimerResult => {
    // Never before a row's own start: a soft-deleted row left running may have
    // started after the new entry (the check above lets that through), and an
    // undelete would bring a negative duration back. Live rows cannot reach
    // the CASE — an earlier start was refused above.
    db.prepare(
      `UPDATE entries
          SET stopped_at = CASE WHEN started_at > ? THEN started_at ELSE ? END,
              heartbeat_at = CASE WHEN started_at > ? THEN started_at ELSE ? END
        WHERE stopped_at IS NULL`
    ).run(startedAt, startedAt, startedAt, startedAt)
    const info = db
      .prepare(
        `INSERT INTO entries (client_id, description, started_at, heartbeat_at, project_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.client_id, input.description, startedAt, startedAt, input.project_id ?? null)
    const entry = db
      .prepare(`SELECT * FROM entries WHERE id = ?`)
      .get(info.lastInsertRowid) as Entry
    // The live (not soft-deleted) one, newest first — the same pick as
    // stopRunningTimer. Normally there is exactly one.
    const live = running
      .filter((r) => r.deleted_at === null)
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0]
    const stopped = live
      ? (db.prepare(`SELECT * FROM entries WHERE id = ?`).get(live.id) as Entry)
      : null
    return { entry, stopped }
  })
  return ok(tx())
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
  emit: (event: 'timer.stopped' | 'timer.started', entry: Entry) => void
): IpcResult<SwitchTimerResult> {
  const res = switchTimer(db, input)
  if (res.ok) {
    if (res.data.stopped) emit('timer.stopped', res.data.stopped)
    emit('timer.started', res.data.entry)
  }
  return res
}

/** Start a running timer (stops any running entry at the same instant). Mirrors `entries:start`. */
export function startTimer(db: Db, input: CreateEntryInput): IpcResult<Entry> {
  const res = switchTimer(db, input)
  return res.ok ? ok(res.data.entry) : res
}

/** Stop a specific entry by id (stamps now). Mirrors `entries:stop`. */
export function stopEntry(db: Db, id: number): IpcResult<Entry> {
  const now = new Date().toISOString()
  db.prepare(`UPDATE entries SET stopped_at = ?, heartbeat_at = ? WHERE id = ?`).run(now, now, id)
  const row = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id) as Entry | undefined
  if (!row) return fail('Eintrag existiert nicht')
  return ok(row)
}

/** Stop the currently running timer, if any. Returns null when nothing runs. */
export function stopRunningTimer(db: Db): IpcResult<Entry | null> {
  const running = db
    .prepare(
      `SELECT id FROM entries WHERE stopped_at IS NULL AND deleted_at IS NULL
       ORDER BY started_at DESC LIMIT 1`
    )
    .get() as { id: number } | undefined
  if (!running) return ok(null)
  const res = stopEntry(db, running.id)
  return res.ok ? ok(res.data) : res
}
