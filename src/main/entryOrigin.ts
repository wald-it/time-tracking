import type Database from 'better-sqlite3'

/** Current version source for a row of the entries view. */
export function entrySourceSql(db: Database.Database): string {
  // Migration comparison probes also read databases from before versioning.
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entry_version'").get()
  )
    return 'NULL'
  return '(SELECT source FROM entry_version WHERE id = entries.version_id)'
}
