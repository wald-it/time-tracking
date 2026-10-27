import type { Migration } from './index'
import {
  BILLING_LINES_RUN_VIEW_SQL,
  BILLING_CHANGES_VIEW_SQL,
  ENTRIES_VIEW_MONEY_SQL
} from '../entryLifecycle/billingLines'

/** Design 4.6: immutable runs, versioned segment locks and an in-database archive. */
export const migration032: Migration = {
  version: 32,
  name: 'v2-billing-runs',
  up: `
ALTER TABLE clients ADD COLUMN short_code TEXT
  CHECK (short_code IS NULL OR (length(short_code) BETWEEN 1 AND 8 AND short_code NOT GLOB '*[^A-Z0-9]*'));
CREATE UNIQUE INDEX idx_clients_short_code ON clients(short_code) WHERE short_code IS NOT NULL;

CREATE TABLE billing_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  project_id INTEGER REFERENCES projects(id),
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released')),
  released_at TEXT,
  release_reason TEXT,
  replaces_run_id INTEGER REFERENCES billing_run(id),
  invoice_ref TEXT NOT NULL DEFAULT '',
  rule_snapshot TEXT NOT NULL,
  html_sha256 TEXT NOT NULL,
  pdf_sha256 TEXT NOT NULL,
  CHECK (
    (status = 'active' AND released_at IS NULL AND release_reason IS NULL)
    OR (status = 'released' AND released_at IS NOT NULL AND length(trim(release_reason)) > 0)
  )
);
CREATE TABLE billing_run_item (
  run_id INTEGER NOT NULL REFERENCES billing_run(id),
  entry_id INTEGER NOT NULL REFERENCES entry(id),
  version_id INTEGER NOT NULL REFERENCES entry_version(id),
  seq INTEGER NOT NULL,
  segment_date TEXT NOT NULL,
  billed_minutes INTEGER NOT NULL,
  rate_cent INTEGER NOT NULL,
  fee_cent INTEGER NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  PRIMARY KEY (run_id, version_id, seq),
  FOREIGN KEY (version_id, seq) REFERENCES entry_segment(version_id, seq)
);
CREATE UNIQUE INDEX idx_billing_run_item_active ON billing_run_item(entry_id, segment_date) WHERE active = 1;
CREATE TABLE billing_run_document (
  run_id INTEGER NOT NULL REFERENCES billing_run(id),
  kind TEXT NOT NULL CHECK (kind = 'pdf'),
  bytes BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (run_id, kind)
);
CREATE TRIGGER trg_billing_run_update BEFORE UPDATE ON billing_run
WHEN NEW.id IS NOT OLD.id OR NEW.number IS NOT OLD.number
  OR NEW.client_id IS NOT OLD.client_id OR NEW.project_id IS NOT OLD.project_id
  OR NEW.period_from IS NOT OLD.period_from OR NEW.period_to IS NOT OLD.period_to
  OR NEW.created_at IS NOT OLD.created_at OR NEW.replaces_run_id IS NOT OLD.replaces_run_id
  OR NEW.rule_snapshot IS NOT OLD.rule_snapshot OR NEW.html_sha256 IS NOT OLD.html_sha256
  OR NEW.pdf_sha256 IS NOT OLD.pdf_sha256
BEGIN SELECT RAISE(ABORT, 'billing_run immutable'); END;
CREATE TRIGGER trg_billing_run_item_update BEFORE UPDATE ON billing_run_item
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.entry_id IS NOT OLD.entry_id
  OR NEW.version_id IS NOT OLD.version_id OR NEW.seq IS NOT OLD.seq
  OR NEW.segment_date IS NOT OLD.segment_date OR NEW.billed_minutes IS NOT OLD.billed_minutes
  OR NEW.rate_cent IS NOT OLD.rate_cent OR NEW.fee_cent IS NOT OLD.fee_cent
BEGIN SELECT RAISE(ABORT, 'billing_run_item immutable'); END;
CREATE TRIGGER trg_billing_run_insert BEFORE INSERT ON billing_run
WHEN NEW.status IS NOT 'active'
BEGIN SELECT RAISE(ABORT, 'billing_run must start active'); END;
CREATE TRIGGER trg_billing_run_release_oneway BEFORE UPDATE ON billing_run
WHEN OLD.status = 'released'
  AND (NEW.status IS NOT OLD.status OR NEW.released_at IS NOT OLD.released_at
    OR NEW.release_reason IS NOT OLD.release_reason)
BEGIN SELECT RAISE(ABORT, 'billing_run release is one-way'); END;
CREATE TRIGGER trg_billing_run_item_insert BEFORE INSERT ON billing_run_item
WHEN NEW.active IS NOT 1
  OR (SELECT status FROM billing_run WHERE id = NEW.run_id) IS NOT 'active'
BEGIN SELECT RAISE(ABORT, 'billing_run_item must start active in an active run'); END;
CREATE TRIGGER trg_billing_run_item_active_oneway BEFORE UPDATE OF active ON billing_run_item
WHEN NEW.active IS NOT OLD.active
  AND (OLD.active = 0 OR (SELECT status FROM billing_run WHERE id = NEW.run_id) IS NOT 'released')
BEGIN SELECT RAISE(ABORT, 'billing_run_item active is one-way and follows the release'); END;
CREATE TRIGGER trg_billing_run_document_update BEFORE UPDATE ON billing_run_document
BEGIN SELECT RAISE(ABORT, 'billing_run_document immutable'); END;
CREATE TRIGGER trg_billing_run_delete BEFORE DELETE ON billing_run
BEGIN SELECT RAISE(ABORT, 'billing_run immutable'); END;
CREATE TRIGGER trg_billing_run_item_delete BEFORE DELETE ON billing_run_item
BEGIN SELECT RAISE(ABORT, 'billing_run_item immutable'); END;
CREATE TRIGGER trg_billing_run_document_delete BEFORE DELETE ON billing_run_document
BEGIN SELECT RAISE(ABORT, 'billing_run_document immutable'); END;

DROP VIEW entries;
DROP VIEW billing_lines;
${BILLING_LINES_RUN_VIEW_SQL};
${BILLING_CHANGES_VIEW_SQL};
${ENTRIES_VIEW_MONEY_SQL}
`
}
