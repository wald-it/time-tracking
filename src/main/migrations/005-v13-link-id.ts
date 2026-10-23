import type { Migration } from './index'

/**
 * v1.3 — `entries.link_id` ties together the two halves produced by the
 * cross-midnight auto-split (see `splitAtMidnight` + ipc handlers). NULL
 * for normal single-day entries; both halves of a split share the same
 * UUID, so a delete or an undo can treat them as one entry (#323).
 *
 * Partial index: only rows that *are* part of a split need lookup; we'd
 * rather not pay the index cost on every plain entry insert.
 */
export const migration005: Migration = {
  version: 5,
  name: 'v1.3-link-id',
  up: `
    ALTER TABLE entries ADD COLUMN link_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_entries_link_id
      ON entries(link_id) WHERE link_id IS NOT NULL;
  `
}
