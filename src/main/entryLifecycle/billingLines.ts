import { billedMinutesRuleSql, rawMinutesSql } from '../../shared/currency'

/**
 * 2.0 P4 (docs/design/2.0-entry-lifecycle.md section 7): money in one place.
 *
 * `BILLING_LINES_SELECT` is the one definition of the billing rule applied to
 * data: one row per current segment of every live entry, with the profile
 * resolved field by field (project, then client, then the default row) and
 * the rate valid on the segment's local date. Migration 030 creates the view
 * `billing_lines` from it; the self-check of `migrateEntriesToV2` runs the
 * same text as a CTE, because a fresh 1.x database runs 028 before 030.
 *
 * - `billed_minutes`: the rule of `currency.ts` (`billedMinutesRuleSql`).
 *   A running segment is provisional: counted up to now, never stored.
 * - `rate_cent`, `fee_cent`: NULL for a running segment.
 * - A project's latest rate row on or before the date wins; if that rate is
 *   NULL the client's rate applies, and an older project row never does.
 * - `rate_is_project`: 1 when the rate came from a project row (a deliberate
 *   project rate of 0 is then a goodwill rate, which the PDF still prints).
 * - `billed_run_id`, `billed_version_id`: NULL until billing runs (P5).
 */
const NOW_ISO = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
const PROFILE = (col: string): string => `COALESCE(pp.${col}, pc.${col}, pd.${col})`

export const BILLING_LINES_SELECT = `
SELECT l.*,
       CASE WHEN l.stopped_at IS NULL THEN NULL
            WHEN l.rate_cent <= 0 OR l.billed_minutes <= 0 THEN 0
            ELSE ROUND(l.rate_cent * l.billed_minutes / 60.0) END AS fee_cent
  FROM (
    SELECT d.entry_id, d.version_id, d.segment_seq, d.segment_date, d.client_id, d.project_id,
           d.billable, d.started_at, d.stopped_at, d.raw_min, d.interval_min, d.min_unit_min,
           d.alignment,
           ${billedMinutesRuleSql('d.raw_min', 'd.interval_min', 'd.min_unit_min')} AS billed_minutes,
           CASE WHEN d.stopped_at IS NULL THEN NULL ELSE d.rate_eff END AS rate_cent,
           CASE WHEN d.project_rate IS NOT NULL THEN 1 ELSE 0 END AS rate_is_project,
           NULL AS billed_run_id,
           NULL AS billed_version_id
      FROM (
        SELECT e.id AS entry_id, v.id AS version_id, s.seq AS segment_seq, s.segment_date,
               v.client_id, v.project_id, v.billable, s.started_at, s.stopped_at,
               ${rawMinutesSql('s.started_at', `COALESCE(s.stopped_at, ${NOW_ISO})`)} AS raw_min,
               COALESCE(${PROFILE('interval_min')}, 0) AS interval_min,
               COALESCE(${PROFILE('min_unit_min')}, 0) AS min_unit_min,
               COALESCE(${PROFILE('alignment')}, 'none') AS alignment,
               (SELECT r.rate_cent FROM rate r
                 WHERE r.project_id = v.project_id AND r.valid_from <= s.segment_date
                 ORDER BY r.valid_from DESC LIMIT 1) AS project_rate,
               COALESCE(
                 (SELECT r.rate_cent FROM rate r
                   WHERE r.project_id = v.project_id AND r.valid_from <= s.segment_date
                   ORDER BY r.valid_from DESC LIMIT 1),
                 (SELECT r.rate_cent FROM rate r
                   WHERE r.client_id = v.client_id AND r.valid_from <= s.segment_date
                   ORDER BY r.valid_from DESC LIMIT 1),
                 0) AS rate_eff
          FROM entry e
          JOIN entry_version v ON v.id = e.current_version_id
          JOIN entry_segment s ON s.version_id = v.id
          LEFT JOIN billing_profile pp ON pp.project_id = v.project_id
          LEFT JOIN billing_profile pc ON pc.client_id = v.client_id
          LEFT JOIN billing_profile pd ON pd.client_id IS NULL AND pd.project_id IS NULL
         WHERE e.is_deleted = 0
      ) d
  ) l`

export const BILLING_LINES_VIEW_SQL = `CREATE VIEW billing_lines AS${BILLING_LINES_SELECT}`
