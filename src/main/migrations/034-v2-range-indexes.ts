import type { Migration } from './index'

export const migration034: Migration = {
  version: 34,
  name: 'v2-range-indexes',
  // A segment range must be able to find its current entry directly. Adding
  // started_at alone makes SQLite build an automatic is_deleted index and
  // search all live entries for every segment in the month.
  up: `
CREATE INDEX IF NOT EXISTS idx_entry_current_version ON entry (current_version_id);
CREATE INDEX IF NOT EXISTS idx_entry_segment_started_at ON entry_segment (started_at);
CREATE INDEX IF NOT EXISTS idx_entry_segment_date ON entry_segment (segment_date);
`
}
