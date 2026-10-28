import type Database from 'better-sqlite3'

/** Entry-wide soft lock, including runs that refer to an older version or another day. */
export function entryBilledSql(db: Database.Database): string {
  // Migration comparison probes also use these readers on pre-P5 databases.
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'billing_run_item'")
      .get()
  )
    return '0'
  return `EXISTS (
    SELECT 1 FROM billing_run_item i WHERE i.entry_id = entries.id AND i.active = 1
  )`
}
