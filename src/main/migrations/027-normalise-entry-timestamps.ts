import type { Migration } from './index'

/**
 * Entry timestamps in one form: UTC with milliseconds and `Z`
 * (`2026-09-30T22:30:00.000Z`), as every write path stores them.
 *
 * Day and month ranges compare `started_at` as text against such instants
 * (local month bounds). `startTimer` used to store the start as sent, so an
 * MCP `start_timer` could leave `2026-10-01T00:30:00+02:00` or a value without
 * any zone. The app read both with `new Date(…)`: an offset or `Z` as given,
 * a value without a zone as LOCAL time. The rewrite keeps exactly that:
 *  - with `Z` or `±HH:MM`: SQLite reads the zone itself;
 *  - without a zone: read as local time and converted (`'utc'` modifier, which
 *    uses the same system time zone as the app process).
 * Rows already in canonical form are skipped; a value SQLite cannot read
 * stays untouched.
 */
const CANONICAL =
  "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'"
const FORMAT = "'%Y-%m-%dT%H:%M:%fZ'"

function hasZone(column: string): string {
  return `(${column} LIKE '%Z' OR ${column} GLOB '*[+-][0-9][0-9]:[0-9][0-9]')`
}

function normalise(column: string): string {
  return `
    UPDATE entries
       SET ${column} = strftime(${FORMAT}, ${column})
     WHERE ${column} IS NOT NULL
       AND ${column} NOT GLOB ${CANONICAL}
       AND ${hasZone(column)}
       AND strftime(${FORMAT}, ${column}) IS NOT NULL;
    UPDATE entries
       SET ${column} = strftime(${FORMAT}, ${column}, 'utc')
     WHERE ${column} IS NOT NULL
       AND ${column} NOT GLOB ${CANONICAL}
       AND NOT ${hasZone(column)}
       AND strftime(${FORMAT}, ${column}, 'utc') IS NOT NULL;`
}

export const migration027: Migration = {
  version: 27,
  name: 'normalise-entry-timestamps',
  up: [normalise('started_at'), normalise('stopped_at'), normalise('heartbeat_at')].join('\n')
}
