import type Database from 'better-sqlite3'
import { migration001 } from './001-initial'
import { migration002 } from './002-v11-settings'
import { migration003 } from './003-v12-data'
import { migration004 } from './004-v13-pdf-template'
import { migration005 } from './005-v13-link-id'
import { migration006 } from './006-v14-mini-widget'
import { migration007 } from './007-v14-tags'
import { migration008 } from './008-v15-onboarding'
import { migration009 } from './009-v18-reference'
import { migration010 } from './010-v18-billable-private-note'
import { migration011 } from './011-v18-theme'
import { migration012 } from './012-v19-projects'
import { migration013 } from './013-v111-stammdaten'
import { migration014 } from './014-v12-housekeeping'
import { migration015 } from './015-v12-project-contact-person'
import { migration016 } from './016-v112-tags'
import { migration017 } from './017-v113-tag-whitespace'
import { migration018 } from './018-v114-mcp-integration'
import { migration019 } from './019-v114-mcp-write-confirm'
import { migration020 } from './020-v115-webhooks'
import { migration021 } from './021-v116-graph-import'
import { migration022 } from './022-v117-domain-project'
import { migration023 } from './023-v117-hardware-keys'
import { migration024 } from './024-v117-presence'
import { migration025 } from './025-v117-ical-feed'
import { migration026 } from './026-v118-week-start'
import { migration027 } from './027-normalise-entry-timestamps'
import { migration028 } from './028-v2-entry-lifecycle'
import { migration029 } from './029-v2-entries-view-segment-count'
import { migration030 } from './030-v2-billing-lines'
import { migration031 } from './031-v2-entries-view-money'
import { migration032 } from './032-v2-billing-runs'
import { migration033 } from './033-rate-editor'

export interface Migration {
  /** Monotonically increasing integer. Never reused, never reordered. */
  version: number
  /** Short human-readable name. Used in logs and backup filenames. */
  name: string
  /** Raw SQL executed inside a transaction. Must be idempotent-safe. */
  up: string
  /**
   * Optional code run after `up`, in the same transaction — for a data rewrite
   * SQL cannot express exactly (027 parses timestamps the way the app's
   * `new Date(…)` did). A throw rolls back like a failing `up`.
   */
  run?: (db: Database.Database) => void
}

/** Apply one migration's body (`up`, then `run`). The caller owns the transaction. */
export function executeMigration(db: Database.Database, m: Migration): void {
  db.exec(m.up)
  m.run?.(db)
}

/**
 * All migrations in order. New migrations must be APPENDED, never inserted
 * in the middle. Once shipped, a migration is immutable.
 */
export const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
  migration017,
  migration018,
  migration019,
  migration020,
  migration021,
  migration022,
  migration023,
  migration024,
  migration025,
  migration026,
  migration027,
  migration028,
  migration029,
  migration030,
  migration031,
  migration032,
  migration033
].sort((a, b) => a.version - b.version)
