import type { Client, Entry } from '../shared/types'
import type Database from 'better-sqlite3'

export interface JsonExportPayload {
  meta: { schemaVersion: number; exportedAt: string; appVersion: string }
  clients: Client[]
  entries: Entry[]
  settings: Array<{ key: string; value: string }>
}

/** Settings rows left out of the export entirely: they hold a secret. */
const OMITTED_SETTING_KEYS = new Set(['ical_feed_token'])

/**
 * Drop the HMAC `secret` of every webhook target but keep the targets
 * themselves (url, events, enabled flag). A blob that is not valid JSON is
 * left out as a whole — it cannot be cleaned field by field, and it may still
 * contain a secret.
 */
function withoutWebhookSecrets(raw: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const cleaned = parsed.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) return item
    const target = { ...(item as Record<string, unknown>) }
    delete target.secret
    return target
  })
  return JSON.stringify(cleaned)
}

/**
 * Remove secrets from the settings rows: `ical_feed_token` is omitted, the
 * webhook targets lose their `secret` field. All other rows pass unchanged.
 */
function exportableSettings(
  rows: Array<{ key: string; value: string }>
): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = []
  for (const row of rows) {
    if (OMITTED_SETTING_KEYS.has(row.key)) continue
    if (row.key === 'webhook_targets') {
      const value = withoutWebhookSecrets(row.value)
      if (value !== null) out.push({ key: row.key, value })
      continue
    }
    out.push(row)
  }
  return out
}

/**
 * Build the JSON export payload from a live DB handle. Pure function —
 * extracted from ipc.ts so unit tests can call it without booting Electron.
 *
 * Output is a verbatim dump of clients and entries (no field renames, no PII
 * filtering, soft-deleted rows included) so users can verify their data and
 * future CSV/PDF tooling can build on top of the snapshot.
 *
 * Settings are dumped verbatim except for secrets: the iCal feed token
 * (`ical_feed_token`) is left out and every webhook target is exported
 * without its HMAC `secret`. The Graph tokens and the MCP/controller tokens
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
