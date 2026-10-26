import type { Migration } from './index'
import { ENTRIES_VIEW_SQL } from '../entryLifecycle/schemaV2'

/**
 * 2.0 (P3, #372): the view `entries` gains `segment_count`, the number of
 * segments of the entry's current version, so a renderer can tell that a row
 * is one day of an entry across midnight (the delete message of #323), and
 * `segment_date`, the stored local date of the segment, which the iCal UID of
 * item 3 is built from.
 *
 * Fresh databases already get the column from 028 (it shares the view
 * definition); this migration brings a database that stopped at 028 up to
 * it. Dropping the view drops its three INSTEAD OF triggers, which the
 * shared definition creates again.
 */
export const migration029: Migration = {
  version: 29,
  name: 'v2-entries-view-segment-count',
  up: `DROP VIEW IF EXISTS entries;\n${ENTRIES_VIEW_SQL}`
}
