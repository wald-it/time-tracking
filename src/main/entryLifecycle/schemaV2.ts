/**
 * 2.0 entry lifecycle, P1 (docs/design/2.0-entry-lifecycle.md, sections 4
 * and 10): the tables a 1.x database is migrated into. Created by
 * `migrateEntriesToV2`; NOT registered in the migration runner yet, so the
 * app still runs on `entries` (P2 registers it, renames `entries` to
 * `entries_v1` and adds the view and the trigger on sealed versions).
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
