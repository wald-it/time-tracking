/**
 * 2.0 entry lifecycle (docs/design/2.0-entry-lifecycle.md, sections 4, 5, 6
 * and 10): the tables a 1.x database is migrated into (P1, created by
 * `migrateEntriesToV2`) and, since P2, the view `entries` over them plus the
 * triggers that make the rules hold without discipline. Migration 028 runs
 * the P1 function, renames `entries` to `entries_v1` and then executes
 * VIEW_V2_SQL.
 *
 * Times are UTC ISO with milliseconds and `Z`, as in `entries`. A segment's
 * `segment_date` is the local date (YYYY-MM-DD) of its start in the zone the
 * process runs in.
 */
export const SCHEMA_V2_SQL = `
CREATE TABLE entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  created_source TEXT NOT NULL
    CHECK (created_source IN ('app', 'timer', 'import', 'mcp', 'controller', 'migration')),
  current_version_id INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  heartbeat_at TEXT,
  graph_event_id TEXT
);
CREATE UNIQUE INDEX idx_entry_graph_event_id
  ON entry (graph_event_id) WHERE graph_event_id IS NOT NULL AND is_deleted = 0;

CREATE TABLE entry_version (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entry (id),
  version_no INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'sealed')),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  client_id INTEGER NOT NULL REFERENCES clients (id),
  project_id INTEGER REFERENCES projects (id),
  description TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  tags TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  billable INTEGER NOT NULL DEFAULT 1,
  private_note TEXT NOT NULL DEFAULT '',
  written_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN
    ('app', 'quicknote', 'idle', 'import', 'mcp', 'controller', 'tag-rename', 'migration', 'recovery')),
  reason TEXT,
  UNIQUE (entry_id, version_no),
  CHECK (state = 'open' OR stopped_at IS NOT NULL)
);
CREATE INDEX idx_entry_version_entry ON entry_version (entry_id);

CREATE TABLE entry_segment (
  version_id INTEGER NOT NULL REFERENCES entry_version (id),
  seq INTEGER NOT NULL,
  segment_date TEXT NOT NULL,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  PRIMARY KEY (version_id, seq),
  UNIQUE (version_id, segment_date)
);

CREATE TABLE entry_legacy_id (
  legacy_id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entry (id)
);
CREATE INDEX idx_entry_legacy_id_entry ON entry_legacy_id (entry_id);

CREATE TABLE rate (
  id INTEGER PRIMARY KEY,
  client_id INTEGER REFERENCES clients (id),
  project_id INTEGER REFERENCES projects (id),
  rate_cent INTEGER,
  valid_from TEXT NOT NULL,
  CHECK ((client_id IS NULL) <> (project_id IS NULL)),
  CHECK (client_id IS NULL OR rate_cent IS NOT NULL)
);
CREATE UNIQUE INDEX idx_rate_client ON rate (client_id, valid_from) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX idx_rate_project ON rate (project_id, valid_from) WHERE project_id IS NOT NULL;

CREATE TABLE billing_profile (
  id INTEGER PRIMARY KEY,
  client_id INTEGER REFERENCES clients (id),
  project_id INTEGER REFERENCES projects (id),
  interval_min INTEGER CHECK (interval_min IS NULL OR interval_min BETWEEN 0 AND 60),
  min_unit_min INTEGER CHECK (min_unit_min IS NULL OR min_unit_min >= 0),
  alignment TEXT CHECK (alignment IS NULL OR alignment IN ('none', 'grid')),
  columns TEXT CHECK (columns IS NULL OR columns IN ('times', 'no_times')),
  language TEXT CHECK (language IS NULL OR language IN ('de', 'en')),
  fee_column TEXT CHECK (fee_column IS NULL OR fee_column IN ('auto', 'on', 'off')),
  group_by TEXT CHECK (group_by IS NULL OR group_by IN ('none', 'tag', 'project', 'reference')),
  CHECK (client_id IS NULL OR project_id IS NULL)
);
CREATE UNIQUE INDEX idx_billing_profile_default
  ON billing_profile ((1)) WHERE client_id IS NULL AND project_id IS NULL;
CREATE UNIQUE INDEX idx_billing_profile_client
  ON billing_profile (client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX idx_billing_profile_project
  ON billing_profile (project_id) WHERE project_id IS NOT NULL;
`

/** The message a write against the view `entries` fails with (D5). */
export const ENTRIES_VIEW_READ_ONLY = 'entries is a read-only view: write through writeEntry'

/** The column list of the view `entries` (shared by 028/029 and by the money view of 031). */
export const ENTRIES_VIEW_SELECT = `SELECT e.id AS id,
         v.client_id,
         v.description,
         s.started_at,
         s.stopped_at,
         CASE WHEN v.state = 'open' THEN e.heartbeat_at ELSE s.stopped_at END AS heartbeat_at,
         NULL AS rounded_min,
         e.created_at,
         NULL AS deleted_at,
         NULL AS link_id,
         v.tags,
         v.reference,
         v.billable,
         v.private_note,
         v.project_id,
         e.graph_event_id,
         s.seq AS segment_seq,
         s.segment_date AS segment_date,
         v.id AS version_id,
         v.version_no,
         (SELECT COUNT(*) FROM entry_segment n WHERE n.version_id = v.id) AS segment_count`

/**
 * P2 (sections 4.2, 5, 6, 10.8): run after `entries` was renamed to
 * `entries_v1`.
 *
 * - The view `entries` shows one row per current segment of every live
 *   entry with today's column names: `id` is the entry id, `link_id` and
 *   `deleted_at` are always NULL, `rounded_min` (no reader since #285) is
 *   NULL, `created_at` comes from the entry, `heartbeat_at` from the entry
 *   while the version is open and equals `stopped_at` once sealed (what
 *   1.x wrote at every stop); plus `segment_seq`, `version_id`, `version_no`
 *   and (P3, migration 029) `segment_count`, the number of segments of the
 *   current version, which tells a renderer that a row is one day of several,
 *   and `segment_date`, the stored local date of the segment (iCal UIDs).
 *   The money columns follow with migration 031 (`ENTRIES_VIEW_MONEY_SQL`).
 * - INSTEAD OF triggers refuse every write to the view with a message, so a
 *   forgotten direct writer fails in tests instead of bypassing the history.
 * - A sealed version is immutable: UPDATE on it and UPDATE/DELETE of its
 *   segments are refused; versions are never deleted.
 * - An entry never loses `id`, `created_at`, `created_source` or
 *   `graph_event_id` (4.1: the anchor belongs to the entry, #299), and is
 *   never hard-deleted.
 * - `entries_v1` stays read-only for the 2.x line (10.8).
 */
export const ENTRIES_VIEW_SQL = `
CREATE VIEW entries AS
  ${ENTRIES_VIEW_SELECT}
    FROM entry e
    JOIN entry_version v ON v.id = e.current_version_id
    JOIN entry_segment s ON s.version_id = v.id
   WHERE e.is_deleted = 0;

CREATE TRIGGER trg_entries_view_insert INSTEAD OF INSERT ON entries
BEGIN SELECT RAISE(ABORT, '${ENTRIES_VIEW_READ_ONLY}'); END;
CREATE TRIGGER trg_entries_view_update INSTEAD OF UPDATE ON entries
BEGIN SELECT RAISE(ABORT, '${ENTRIES_VIEW_READ_ONLY}'); END;
CREATE TRIGGER trg_entries_view_delete INSTEAD OF DELETE ON entries
BEGIN SELECT RAISE(ABORT, '${ENTRIES_VIEW_READ_ONLY}'); END;
`

export const VIEW_V2_SQL = `${ENTRIES_VIEW_SQL}

CREATE TRIGGER trg_entry_version_sealed BEFORE UPDATE ON entry_version
  WHEN OLD.state = 'sealed'
BEGIN SELECT RAISE(ABORT, 'entry_version: a sealed version is immutable'); END;
CREATE TRIGGER trg_entry_version_no_delete BEFORE DELETE ON entry_version
BEGIN SELECT RAISE(ABORT, 'entry_version is append-only'); END;

CREATE TRIGGER trg_entry_segment_sealed_update BEFORE UPDATE ON entry_segment
  WHEN (SELECT state FROM entry_version WHERE id = OLD.version_id) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'entry_segment: the segments of a sealed version are immutable'); END;
CREATE TRIGGER trg_entry_segment_sealed_delete BEFORE DELETE ON entry_segment
  WHEN (SELECT state FROM entry_version WHERE id = OLD.version_id) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'entry_segment: the segments of a sealed version are immutable'); END;

CREATE TRIGGER trg_entry_fixed_columns BEFORE UPDATE OF id, created_at, created_source, graph_event_id ON entry
BEGIN SELECT RAISE(ABORT, 'entry: id, created_at, created_source and graph_event_id never change'); END;
CREATE TRIGGER trg_entry_no_delete BEFORE DELETE ON entry
BEGIN SELECT RAISE(ABORT, 'entry is never hard-deleted'); END;

CREATE TRIGGER trg_entries_v1_insert BEFORE INSERT ON entries_v1
BEGIN SELECT RAISE(ABORT, 'entries_v1 is read-only'); END;
CREATE TRIGGER trg_entries_v1_update BEFORE UPDATE ON entries_v1
BEGIN SELECT RAISE(ABORT, 'entries_v1 is read-only'); END;
CREATE TRIGGER trg_entries_v1_delete BEFORE DELETE ON entries_v1
BEGIN SELECT RAISE(ABORT, 'entries_v1 is read-only'); END;
`
