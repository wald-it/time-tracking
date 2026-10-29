import type { Client, Entry } from '../shared/types'
import type Database from 'better-sqlite3'
import { EXPORT_FOLDERS_SETTING } from './exportFolders'

export interface JsonExportPayload {
  meta: { schemaVersion: number; exportedAt: string; appVersion: string }
  clients: Client[]
  entries: Entry[]
  /**
   * 2.0 P3: the tables behind `entries`, verbatim, so the export holds every
   * version and segment of every entry, not only the current one.
   */
  entry: Array<Record<string, unknown>>
  entry_version: Array<Record<string, unknown>>
  entry_segment: Array<Record<string, unknown>>
  entry_legacy_id: Array<Record<string, unknown>>
  rate: Array<Record<string, unknown>>
  billing_profile: Array<Record<string, unknown>>
  billing_run: Array<Record<string, unknown>>
  billing_run_item: Array<Record<string, unknown>>
  billing_run_document: Array<Record<string, unknown>>
  settings: Array<{ key: string; value: string }>
}

/**
 * Settings rows left out of the export. Two hold a secret: `webhook_targets`
 * goes as a whole — besides the HMAC secret, a webhook URL is often a secret
 * itself (Slack, Discord, Teams, Zapier and n8n put the token in the path or
 * query), and with no importer for this file the targets are of no use in it.
 * One is left out for privacy: `export_folders` (#269) holds the folders of
 * the last exports, local paths that often name clients, and is of no use
 * outside this machine.
 */
const OMITTED_SETTING_KEYS = new Set(['ical_feed_token', 'webhook_targets', EXPORT_FOLDERS_SETTING])

/**
 * Any key that names a secret is left out too, so a secret stored later under
 * a new key (by the main process, or added to the renderer allow-list in
 * settingsWrite.ts) does not leak into the export unnoticed.
 */
const SECRET_KEY = /token|secret|password/i

function exportableSettings(
  rows: Array<{ key: string; value: string }>
): Array<{ key: string; value: string }> {
  return rows.filter((row) => !OMITTED_SETTING_KEYS.has(row.key) && !SECRET_KEY.test(row.key))
}

/**
 * Build the JSON export payload from a live DB handle. Pure function —
 * extracted from ipc.ts so unit tests can call it without booting Electron.
 *
 * Output is a verbatim dump of clients and entries (no field renames, no PII
 * filtering, soft-deleted rows included) so users can verify their data and
 * future CSV/PDF tooling can build on top of the snapshot.
 *
 * Settings are dumped verbatim except for secrets and one private row: the iCal
 * feed token, the webhook targets (URLs and HMAC secrets), every key that
 * matches /token|secret|password/i, and the remembered export folders are left
 * out. The Graph tokens and the MCP/controller tokens
 * live in files, not in the database, so they never reach this export. There
 * is no importer for this file; a full restore goes through the SQLite backup
 * (backup.ts), which keeps everything.
 */
export function buildJsonExportPayload(
  db: Database.Database,
  appVersion: string
): JsonExportPayload {
  const schemaVersion =
    (db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number | null }).v ??
    0
  const clients = db.prepare(`SELECT * FROM clients ORDER BY id ASC`).all() as Client[]
  // 2.0 P2: the view `entries` shows live entries only; the export keeps the
  // soft-deleted ones (its contract above), so it reads the current version
  // of every entry, one row per segment, in today's shape. The tables
  // themselves (versions, segments) follow below.
  const entries = db
    .prepare(
      `SELECT e.id, v.client_id, v.description, s.started_at, s.stopped_at,
              CASE WHEN v.state = 'open' THEN e.heartbeat_at ELSE s.stopped_at END AS heartbeat_at,
              NULL AS rounded_min,
              CASE WHEN e.is_deleted = 1 THEN v.written_at ELSE NULL END AS deleted_at,
              e.created_at, NULL AS link_id, v.tags, v.reference, v.billable, v.private_note,
              v.project_id, e.graph_event_id, s.seq AS segment_seq, v.id AS version_id, v.version_no
         FROM entry e
         JOIN entry_version v ON v.id = e.current_version_id
         JOIN entry_segment s ON s.version_id = v.id
        ORDER BY s.started_at ASC, e.id ASC, s.seq ASC`
    )
    .all() as Entry[]
  const table = (sql: string): Array<Record<string, unknown>> =>
    db.prepare(sql).all() as Array<Record<string, unknown>>
  const settings = db.prepare(`SELECT key, value FROM settings ORDER BY key ASC`).all() as Array<{
    key: string
    value: string
  }>
  return {
    meta: {
      schemaVersion,
      exportedAt: new Date().toISOString(),
      appVersion
    },
    clients,
    entries,
    entry: table(`SELECT * FROM entry ORDER BY id ASC`),
    entry_version: table(`SELECT * FROM entry_version ORDER BY entry_id ASC, version_no ASC`),
    entry_segment: table(`SELECT * FROM entry_segment ORDER BY version_id ASC, seq ASC`),
    entry_legacy_id: table(`SELECT * FROM entry_legacy_id ORDER BY legacy_id ASC`),
    rate: table(`SELECT * FROM rate ORDER BY id ASC`),
    billing_profile: table(`SELECT * FROM billing_profile ORDER BY id ASC`),
    billing_run: table('SELECT * FROM billing_run ORDER BY id'),
    billing_run_item: table('SELECT * FROM billing_run_item ORDER BY run_id, version_id, seq'),
    billing_run_document: table(
      'SELECT run_id, kind, length(bytes) AS byte_length, sha256 FROM billing_run_document ORDER BY run_id, kind'
    ),
    settings: exportableSettings(settings)
  }
}
