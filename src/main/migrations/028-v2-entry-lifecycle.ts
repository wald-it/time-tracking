import type { Migration } from './index'
import { migrateEntriesToV2 } from '../entryLifecycle/migrateV2'
import { VIEW_V2_SQL } from '../entryLifecycle/schemaV2'

/**
 * 2.0 (P2, docs/design/2.0-entry-lifecycle.md section 10 and 13): the switch
 * from the 1.x table `entries` to the entry lifecycle.
 *
 * Everything is in `run`, because the migration function reads the table
 * `entries` first and the view of the same name can only be created once the
 * table is renamed: the runner executes `up` before `run`, so `up` carries no
 * statement of its own.
 *
 * 1. `migrateEntriesToV2` writes entry / entry_version / entry_segment /
 *    entry_legacy_id / rate / billing_profile from `entries`, checks its own
 *    result (section 10.9) and throws on any difference, which rolls the
 *    runner's transaction back and restores the pre-migration backup.
 * 2. `entries` becomes `entries_v1` (10.8). Nothing else references the table
 *    by name (no FK, view or trigger), so a rename is all it takes; the
 *    foreign keys of `entries_v1` itself (clients, projects) travel with it.
 * 3. The view `entries` with today's columns replaces the table for the
 *    readers (section 6), and the triggers of VIEW_V2_SQL make the view and
 *    `entries_v1` read-only and sealed versions immutable (4.2, D5).
 *
 * The report (counts per shape, exceptions by id) goes to the log, as 10.9
 * asks; it is not stored in the database.
 */
export const migration028: Migration = {
  version: 28,
  name: 'v2-entry-lifecycle',
  up: `-- 028: see run(): the migration reads the table "entries" before the view of that name can exist.`,
  run: (db) => {
    const report = migrateEntriesToV2(db)
    db.exec('ALTER TABLE entries RENAME TO entries_v1')
    db.exec(VIEW_V2_SQL)
    const shapes = Object.entries(report.shapes)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
    console.log(
      `[migrations] 028: ${report.legacyRows} legacy rows -> ${report.entries} entries; shapes: ${shapes}; ` +
        `exceptions: ${report.exceptions.length}`
    )
    for (const e of report.exceptions) {
      console.log(`[migrations] 028 exception ${e.code}: legacy ids ${e.legacyIds.join(', ')}`)
    }
  }
}
