import type { Client, Entry } from '../shared/types'
import type Database from 'better-sqlite3'

export interface JsonExportPayload {
  meta: { schemaVersion: number; exportedAt: string; appVersion: string }
  clients: Client[]
  entries: Entry[]
  settings: Array<{ key: string; value: string }>
}

/**
 * Settings rows left out of the export: they hold a secret. `webhook_targets`
 * goes as a whole — besides the HMAC secret, a webhook URL is often a secret
 * itself (Slack, Discord, Teams, Zapier and n8n put the token in the path or
 * query), and with no importer for this file the targets are of no use in it.
 * `export_folders` (#269) holds the folders of the last exports — local paths
 * that often name clients — and is of no use outside this machine.
 */
const OMITTED_SETTING_KEYS = new Set(['ical_feed_token', 'webhook_targets', 'export_folders'])

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
 * Settings are dumped verbatim except for secrets: the iCal feed token, the
 * webhook targets (URLs and HMAC secrets) and every key that matches
 * /token|secret|password/i are left out. The Graph tokens and the MCP/controller tokens
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
  const entries = db
    .prepare(`SELECT * FROM entries ORDER BY started_at ASC, id ASC`)
    .all() as Entry[]
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
    settings: exportableSettings(settings)
  }
}
