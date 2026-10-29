/**
 * React key of a row of the `entries` view. Since 2.0 an entry across midnight
 * has one row per day segment and both rows share the entry `id`, so the id
 * alone is not unique among siblings; `segment_seq` tells the halves apart.
 */
export function entryRowKey(e: { id: number; segment_seq?: number }): string {
  return `${e.id}:${e.segment_seq ?? 0}`
}
