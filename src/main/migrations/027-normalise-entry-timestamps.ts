import type { Migration } from './index'

/**
 * Entry timestamps in one form: UTC with milliseconds and `Z`
 * (`2026-09-30T22:30:00.000Z`), as every write path stores them.
 *
 * Day and month ranges compare `started_at` as text against such instants
 * (local month bounds). `startTimer` used to store the start as sent, so an
 * MCP `start_timer` with an offset (`2026-10-01T00:30:00+02:00`) left a row
 * that sorts into the wrong day. SQLite reads offsets and `Z` itself;
 * `strftime('%Y-%m-%dT%H:%M:%fZ', …)` writes the canonical form. Rows already
 * in that form are skipped; a value SQLite cannot read stays untouched.
 */
const CANONICAL =
  "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'"

function normalise(column: string): string {
  return `
    UPDATE entries
       SET ${column} = strftime('%Y-%m-%dT%H:%M:%fZ', ${column})
     WHERE ${column} IS NOT NULL
       AND ${column} NOT GLOB ${CANONICAL}
       AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NOT NULL;`
}

export const migration027: Migration = {
  version: 27,
  name: 'normalise-entry-timestamps',
  up: [normalise('started_at'), normalise('stopped_at'), normalise('heartbeat_at')].join('\n')
}
