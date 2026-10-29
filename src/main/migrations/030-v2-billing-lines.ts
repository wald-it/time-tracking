import type { Migration } from './index'
import { BILLING_LINES_VIEW_SQL } from '../entryLifecycle/billingLines'

/**
 * 2.0 (P4, design section 7): the view `billing_lines`, money in one place.
 * The definition lives in `billingLines.ts`, shared with the migration
 * self-check.
 *
 * `rate` and the default `billing_profile` row were written once by 028 from
 * `clients.rate_cent`, `projects.rate_cent` and `pdf_round_minutes`. Until now
 * nothing kept them in step, so a database that ran 028 may have drifted:
 * the statements below bring `rate` and the default profile back to what the
 * 1.x columns and the setting say today, once.
 */
export const migration030: Migration = {
  version: 30,
  name: 'v2-billing-lines',
  up: `
-- Clients without a rate row, or whose open-ended row differs from the column.
INSERT OR IGNORE INTO rate (client_id, rate_cent, valid_from)
  SELECT id, rate_cent, '0001-01-01' FROM clients;
UPDATE rate SET rate_cent = (SELECT c.rate_cent FROM clients c WHERE c.id = rate.client_id)
  WHERE client_id IS NOT NULL AND valid_from = '0001-01-01';
-- Projects: a rate gives a row, no rate means no row (inherit).
INSERT OR IGNORE INTO rate (project_id, rate_cent, valid_from)
  SELECT id, rate_cent, '0001-01-01' FROM projects WHERE rate_cent IS NOT NULL;
UPDATE rate SET rate_cent = (SELECT p.rate_cent FROM projects p WHERE p.id = rate.project_id)
  WHERE project_id IS NOT NULL AND valid_from = '0001-01-01'
    AND (SELECT p.rate_cent FROM projects p WHERE p.id = rate.project_id) IS NOT NULL;
DELETE FROM rate WHERE project_id IS NOT NULL AND valid_from = '0001-01-01'
  AND (SELECT p.rate_cent FROM projects p WHERE p.id = rate.project_id) IS NULL;
-- The default profile follows the setting, interval and alignment together.
UPDATE billing_profile
   SET interval_min = MIN(60, MAX(0, CAST(COALESCE((SELECT value FROM settings WHERE key = 'pdf_round_minutes'), '0') AS INTEGER))),
       alignment = CASE WHEN CAST(COALESCE((SELECT value FROM settings WHERE key = 'pdf_round_minutes'), '0') AS INTEGER) > 0 THEN 'grid' ELSE 'none' END
 WHERE client_id IS NULL AND project_id IS NULL;
${BILLING_LINES_VIEW_SQL};

-- Until the rate table has an editor (P6) the 1.x columns stay the place a
-- rate is edited. Triggers keep the open-ended row (valid_from 0001-01-01) in
-- step, so no writer (IPC, import, seed) can leave billing_lines on a stale rate.
CREATE TRIGGER trg_rate_sync_client_insert AFTER INSERT ON clients
BEGIN
  INSERT INTO rate (client_id, rate_cent, valid_from) VALUES (NEW.id, NEW.rate_cent, '0001-01-01');
END;
CREATE TRIGGER trg_rate_sync_client_update AFTER UPDATE OF rate_cent ON clients
  WHEN OLD.rate_cent IS NOT NEW.rate_cent
BEGIN
  -- A change applies from today (owner decision 2026-10-26): past months keep their rate.
  INSERT INTO rate (client_id, rate_cent, valid_from)
    VALUES (NEW.id, NEW.rate_cent, date('now', 'localtime'))
    ON CONFLICT (client_id, valid_from) WHERE client_id IS NOT NULL
    DO UPDATE SET rate_cent = excluded.rate_cent;
END;
CREATE TRIGGER trg_rate_sync_project_insert AFTER INSERT ON projects WHEN NEW.rate_cent IS NOT NULL
BEGIN
  INSERT INTO rate (project_id, rate_cent, valid_from) VALUES (NEW.id, NEW.rate_cent, '0001-01-01');
END;
CREATE TRIGGER trg_rate_sync_project_update AFTER UPDATE OF rate_cent ON projects
  WHEN OLD.rate_cent IS NOT NEW.rate_cent
BEGIN
  -- From today; a NULL row hands the project back to the client rate (the
  -- view reads the newest project row and falls through when it is NULL).
  INSERT INTO rate (project_id, rate_cent, valid_from)
    SELECT NEW.id, NEW.rate_cent, date('now', 'localtime')
     WHERE NEW.rate_cent IS NOT NULL OR EXISTS (SELECT 1 FROM rate WHERE project_id = NEW.id)
    ON CONFLICT (project_id, valid_from) WHERE project_id IS NOT NULL
    DO UPDATE SET rate_cent = excluded.rate_cent;
END;

-- A client or project that goes takes its rate rows along (rate has no cascade).
CREATE TRIGGER trg_rate_delete_client BEFORE DELETE ON clients
BEGIN DELETE FROM rate WHERE client_id = OLD.id; END;
CREATE TRIGGER trg_rate_delete_project BEFORE DELETE ON projects
BEGIN DELETE FROM rate WHERE project_id = OLD.id; END;

-- The setting pdf_round_minutes is the editor of the default profile (D8)
-- until P6: interval and alignment move together, or PDFs would change.
CREATE TRIGGER trg_profile_sync_round_insert AFTER INSERT ON settings WHEN NEW.key = 'pdf_round_minutes'
BEGIN
  UPDATE billing_profile
     SET interval_min = MIN(60, MAX(0, CAST(NEW.value AS INTEGER))),
         alignment = CASE WHEN CAST(NEW.value AS INTEGER) > 0 THEN 'grid' ELSE 'none' END
   WHERE client_id IS NULL AND project_id IS NULL;
END;
CREATE TRIGGER trg_profile_sync_round_update AFTER UPDATE OF value ON settings WHEN NEW.key = 'pdf_round_minutes'
BEGIN
  UPDATE billing_profile
     SET interval_min = MIN(60, MAX(0, CAST(NEW.value AS INTEGER))),
         alignment = CASE WHEN CAST(NEW.value AS INTEGER) > 0 THEN 'grid' ELSE 'none' END
   WHERE client_id IS NULL AND project_id IS NULL;
END;
`
}
