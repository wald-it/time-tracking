/**
 * Validation contract tests for `entries:create` and `entries:update`.
 *
 * We do not boot the full Electron IPC layer here. Instead we exercise the
 * same SQL surface and a local replica of `validateManualEntry` against an
 * in-memory DB seeded with the v1.2 schema. Keeps the test fast and avoids
 * an Electron runtime dependency in unit tests.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { executeMigration, migrations } from './migrations'
import { normaliseBudgetMinutes } from './ipc'
import {
  createMigratedTemplate,
  loadSqlite,
  openMigratedCopy,
  type DatabaseCtor
} from '../test/sqlite'

const MAX_DESCRIPTION_LEN = 500
const MAX_DURATION_SECONDS = 24 * 3600

let DatabaseImpl: DatabaseCtor
// Migrated once per file; every DB-backed test opens its own copy (#233).
let templateDir: string
let templatePath: string

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
  templateDir = mkdtempSync(join(tmpdir(), 'tt-ipc-template-'))
  templatePath = createMigratedTemplate(DatabaseImpl, templateDir)
})

afterAll(() => {
  if (templateDir) rmSync(templateDir, { recursive: true, force: true })
})

/**
 * Close a per-test copy and remove its directory. Callers clear their `db`
 * variable before calling this, so a test whose `beforeEach` threw inside
 * `openMigratedCopy` neither closes the previous handle twice nor leaves its
 * fresh temp directory behind: the directory is removed whether or not a
 * handle was ever opened.
 */
function disposeCopy(db: Database.Database | undefined, dir: string | undefined): void {
  try {
    db?.close()
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

describe('migrated template (#233)', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-template-'))
    db = openMigratedCopy(DatabaseImpl, templatePath, tmpDir)
  })

  afterEach(() => {
    const open = db
    db = undefined as unknown as Database.Database
    disposeCopy(open, tmpDir)
  })

  // Cannot go red today: the template is rebuilt from `migrations` on every
  // run. It guards a future change that caches the template across runs
  // (on disk or in CI), where a new migration would otherwise be missing
  // from every copy without any test noticing.
  it('a copy carries exactly the current migrations, so a stale template cannot pass', () => {
    const applied = db.prepare('SELECT version FROM schema_version ORDER BY version').all() as {
      version: number
    }[]
    expect(applied.map((r) => r.version)).toEqual(migrations.map((m) => m.version))
  })

  it('writes to one copy do not reach the template or the next copy', () => {
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    const otherDir = mkdtempSync(join(tmpdir(), 'tt-template-other-'))
    const other = openMigratedCopy(DatabaseImpl, templatePath, otherDir)
    try {
      const row = other.prepare('SELECT COUNT(*) AS n FROM clients').get() as { n: number }
      expect(row.n).toBe(0)
    } finally {
      other.close()
      rmSync(otherDir, { recursive: true, force: true })
    }
  })
})

interface ManualInput {
  client_id: number
  description: string
  started_at: string
  stopped_at: string
}

function validateManualEntry(
  db: Database.Database,
  input: ManualInput,
  excludeId?: number
): string | null {
  const start = new Date(input.started_at)
  const stop = new Date(input.stopped_at)
  if (Number.isNaN(start.getTime())) return 'Startzeit ist ungültig'
  if (Number.isNaN(stop.getTime())) return 'Endzeit ist ungültig'
  if (start.getTime() > Date.now()) return 'Startzeit darf nicht in der Zukunft liegen'
  if (stop.getTime() <= start.getTime()) return 'Endzeit muss nach der Startzeit liegen'
  const durationSec = (stop.getTime() - start.getTime()) / 1000
  if (durationSec > MAX_DURATION_SECONDS) return 'Dauer überschreitet 24 Stunden'
  if ((input.description ?? '').length > MAX_DESCRIPTION_LEN) {
    return `Beschreibung überschreitet ${MAX_DESCRIPTION_LEN} Zeichen`
  }
  const clientRow = db.prepare(`SELECT id FROM clients WHERE id = ?`).get(input.client_id) as
    | { id: number }
    | undefined
  if (!clientRow) return 'Kunde existiert nicht'
  const params: Array<string | number> = [input.client_id, input.stopped_at, input.started_at]
  let overlapSql = `SELECT id FROM entries
                     WHERE client_id = ? AND deleted_at IS NULL
                       AND started_at < ?
                       AND COALESCE(stopped_at, datetime('now')) > ?`
  if (excludeId !== undefined) {
    overlapSql += ` AND id != ?`
    params.push(excludeId)
  }
  const overlap = db.prepare(overlapSql).get(...params) as { id: number } | undefined
  if (overlap) return 'Eintrag überlappt mit einem bestehenden Eintrag desselben Kunden'
  return null
}

describe('entries:create / entries:update validation contract', () => {
  let tmpDir: string
  let db: Database.Database
  // Anchor "today" to a fixed date so tests don't depend on wall clock.
  // Use yesterday relative to runtime so start times are always "in the past".
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  function todayAt(hh: number, mm: number): string {
    const d = new Date(yesterday)
    d.setHours(hh, mm, 0, 0)
    return d.toISOString()
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-ipc-'))
    db = openMigratedCopy(DatabaseImpl, templatePath, tmpDir)
    db.pragma('foreign_keys = ON')
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    db.prepare(`INSERT INTO clients (id, name) VALUES (2, 'Other')`).run()
  })

  afterEach(() => {
    const open = db
    db = undefined as unknown as Database.Database
    disposeCopy(open, tmpDir)
  })

  it('accepts a valid entry', () => {
    const err = validateManualEntry(db, {
      client_id: 1,
      description: 'work',
      started_at: todayAt(8, 0),
      stopped_at: todayAt(9, 30)
    })
    expect(err).toBeNull()
  })

  it('rejects future start', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000)
    const future2 = new Date(future.getTime() + 30 * 60 * 1000)
    const err = validateManualEntry(db, {
      client_id: 1,
      description: '',
      started_at: future.toISOString(),
      stopped_at: future2.toISOString()
    })
    expect(err).toMatch(/Zukunft/)
  })

  it('rejects stopped_at <= started_at', () => {
    const err = validateManualEntry(db, {
      client_id: 1,
      description: '',
      started_at: todayAt(10, 0),
      stopped_at: todayAt(10, 0)
    })
    expect(err).toMatch(/Endzeit/)
  })

  it('accepts cross-midnight entries (v1.3 PR B — IPC auto-splits before insert)', () => {
    const start = new Date(yesterday)
    start.setHours(23, 30, 0, 0)
    const stop = new Date(yesterday)
    stop.setDate(stop.getDate() + 1)
    stop.setHours(0, 30, 0, 0)
    const err = validateManualEntry(db, {
      client_id: 1,
      description: '',
      started_at: start.toISOString(),
      stopped_at: stop.toISOString()
    })
    expect(err).toBeNull()
  })

  it('rejects unknown client', () => {
    const err = validateManualEntry(db, {
      client_id: 999,
      description: '',
      started_at: todayAt(8, 0),
      stopped_at: todayAt(9, 0)
    })
    expect(err).toMatch(/Kunde/)
  })

  it('rejects description over 500 chars', () => {
    const err = validateManualEntry(db, {
      client_id: 1,
      description: 'x'.repeat(501),
      started_at: todayAt(8, 0),
      stopped_at: todayAt(9, 0)
    })
    expect(err).toMatch(/Beschreibung/)
  })

  it('rejects overlapping entry on same client', () => {
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at)
       VALUES (1, ?, ?)`
    ).run(todayAt(9, 0), todayAt(10, 0))
    const err = validateManualEntry(db, {
      client_id: 1,
      description: '',
      started_at: todayAt(9, 30),
      stopped_at: todayAt(10, 30)
    })
    expect(err).toMatch(/überlappt/)
  })

  it('allows overlap with a different client', () => {
    db.prepare(
      `INSERT INTO entries (client_id, started_at, stopped_at)
       VALUES (1, ?, ?)`
    ).run(todayAt(9, 0), todayAt(10, 0))
    const err = validateManualEntry(db, {
      client_id: 2,
      description: '',
      started_at: todayAt(9, 30),
      stopped_at: todayAt(10, 30)
    })
    expect(err).toBeNull()
  })

  it('ignores soft-deleted entries when checking overlap', () => {
    const info = db
      .prepare(
        `INSERT INTO entries (client_id, started_at, stopped_at, deleted_at)
         VALUES (1, ?, ?, ?)`
      )
      .run(todayAt(9, 0), todayAt(10, 0), new Date().toISOString())
    expect(info.changes).toBe(1)
    const err = validateManualEntry(db, {
      client_id: 1,
      description: '',
      started_at: todayAt(9, 30),
      stopped_at: todayAt(10, 30)
    })
    expect(err).toBeNull()
  })

  it('allows updating an entry without overlapping itself', () => {
    const info = db
      .prepare(
        `INSERT INTO entries (client_id, started_at, stopped_at)
         VALUES (1, ?, ?)`
      )
      .run(todayAt(9, 0), todayAt(10, 0))
    const id = info.lastInsertRowid as number
    const err = validateManualEntry(
      db,
      {
        client_id: 1,
        description: '',
        started_at: todayAt(9, 15),
        stopped_at: todayAt(10, 15)
      },
      id
    )
    expect(err).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// pdf:merge-export / pdf:merge-only — validation contract tests
//
// The full IPC handlers require an Electron runtime and are not exercised here.
// Handler logic is covered in pdfMergeHandlers.test.ts.
// This suite tests the shared validation helpers from pdfMergeValidation.ts.
// ---------------------------------------------------------------------------

import {
  validatePdfPath,
  validateInvoiceSize,
  validateMergeExportRequest,
  validateMergeOnlyRequest
} from './pdfMergeValidation'

describe('pdf:merge-export — path validation', () => {
  it('rejects empty invoicePath', () => {
    expect(validatePdfPath('')).toBe('mainError.merge.noInvoicePath')
  })

  it('rejects non-pdf extension (.txt)', () => {
    expect(validatePdfPath('C:/invoices/rechnung.txt')).toBe('mainError.merge.notPdf')
  })

  it('rejects non-pdf extension (.docx)', () => {
    expect(validatePdfPath('C:/invoices/rechnung.docx')).toBe('mainError.merge.notPdf')
  })

  it('accepts .pdf extension (lowercase)', () => {
    // File does not exist — will fail at existsSync, not at extension check.
    const err = validatePdfPath('C:/does-not-exist/rechnung.pdf')
    expect(err).toBe('mainError.merge.notFound')
  })

  it('accepts .PDF extension (uppercase, Windows drag-from-Explorer)', () => {
    const err = validatePdfPath('C:/does-not-exist/rechnung.PDF')
    expect(err).toBe('mainError.merge.notFound')
  })

  it('rejects path traversal with non-pdf extension', () => {
    expect(validatePdfPath('../../secret.exe')).toBe('mainError.merge.notPdf')
  })
})

describe('pdf:merge-export — size validation', () => {
  it('accepts a buffer below 50 MB', () => {
    expect(validateInvoiceSize(Buffer.alloc(1024))).toBeNull()
  })

  it('rejects a buffer at exactly 50 MB + 1 byte', () => {
    expect(validateInvoiceSize(Buffer.alloc(50 * 1024 * 1024 + 1))).toBe(
      'mainError.merge.invoiceTooBig'
    )
  })

  it('accepts a buffer at exactly 50 MB', () => {
    expect(validateInvoiceSize(Buffer.alloc(50 * 1024 * 1024))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// pdf:merge-export — request field validation
// Mirrors the guard at the top of the IPC handler before any FS access.
// ---------------------------------------------------------------------------

describe('pdf:merge-export — request validation', () => {
  it('rejects null request', () => {
    expect(validateMergeExportRequest(null)).toBe('mainError.merge.badRequest')
  })

  it('rejects request with non-number clientId', () => {
    expect(
      validateMergeExportRequest({ clientId: '1', fromIso: '2026-01-01', toIso: '2026-01-31' })
    ).toBe('mainError.merge.badRequest')
  })

  it('rejects request with missing fromIso', () => {
    expect(validateMergeExportRequest({ clientId: 1, fromIso: '', toIso: '2026-01-31' })).toBe(
      'mainError.merge.badRequest'
    )
  })

  it('rejects request with missing toIso', () => {
    expect(validateMergeExportRequest({ clientId: 1, fromIso: '2026-01-01', toIso: '' })).toBe(
      'mainError.merge.badRequest'
    )
  })

  it('rejects valid request fields but missing invoicePath', () => {
    expect(
      validateMergeExportRequest({
        clientId: 1,
        fromIso: '2026-01-01',
        toIso: '2026-01-31',
        invoicePath: ''
      })
    ).toBe('mainError.merge.noInvoicePath')
  })

  it('accepts a fully valid request object', () => {
    expect(
      validateMergeExportRequest({
        clientId: 1,
        fromIso: '2026-01-01',
        toIso: '2026-01-31',
        invoicePath: 'C:/invoices/rechnung.pdf'
      })
    ).toBeNull()
  })
})

describe('pdf:merge-only — request validation', () => {
  it('rejects null request', () => {
    expect(validateMergeOnlyRequest(null)).toBe('mainError.merge.bothRequired')
  })

  it('rejects empty object', () => {
    expect(validateMergeOnlyRequest({})).toBe('mainError.merge.bothRequired')
  })

  it('rejects request with only stundennachweisPath', () => {
    expect(validateMergeOnlyRequest({ stundennachweisPath: 'a.pdf' })).toBe(
      'mainError.merge.bothRequired'
    )
  })

  it('rejects request with only invoicePath', () => {
    expect(validateMergeOnlyRequest({ invoicePath: 'b.pdf' })).toBe('mainError.merge.bothRequired')
  })

  it('rejects request with empty string paths', () => {
    expect(validateMergeOnlyRequest({ stundennachweisPath: '', invoicePath: '' })).toBe(
      'mainError.merge.bothRequired'
    )
  })

  it('accepts a fully valid request with both paths', () => {
    expect(
      validateMergeOnlyRequest({ stundennachweisPath: 'a.pdf', invoicePath: 'b.pdf' })
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Round-trip tests: reference field stored and retrieved via insertEntrySegments
// ---------------------------------------------------------------------------
describe('reference field — insertEntrySegments round-trip', () => {
  let tmpDir: string
  let db: Database.Database

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  function todayAt(hh: number, mm: number): string {
    const d = new Date(yesterday)
    d.setHours(hh, mm, 0, 0)
    return d.toISOString()
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-ref-'))
    db = openMigratedCopy(DatabaseImpl, templatePath, tmpDir)
    db.pragma('foreign_keys = ON')
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
  })

  afterEach(() => {
    const open = db
    db = undefined as unknown as Database.Database
    disposeCopy(open, tmpDir)
  })

  it('persists non-empty reference and returns it on the inserted row', () => {
    const linkId: string | null = null
    const insertStmt = db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, heartbeat_at, rounded_min, link_id, tags, reference)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const start = todayAt(8, 0)
    const stop = todayAt(9, 30)
    const info = insertStmt.run(1, 'work', start, stop, stop, 90, linkId, '', 'JIRA-123')
    const row = db
      .prepare('SELECT reference FROM entries WHERE id = ?')
      .get(info.lastInsertRowid) as { reference: string }
    expect(row.reference).toBe('JIRA-123')
  })

  it('persists empty reference (default) and returns empty string', () => {
    const insertStmt = db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, heartbeat_at, rounded_min, link_id, tags, reference)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const start = todayAt(10, 0)
    const stop = todayAt(11, 0)
    const info = insertStmt.run(1, 'work', start, stop, stop, 60, null, '', '')
    const row = db
      .prepare('SELECT reference FROM entries WHERE id = ?')
      .get(info.lastInsertRowid) as { reference: string }
    expect(row.reference).toBe('')
  })

  it('reference column is included in SELECT * FROM entries', () => {
    const insertStmt = db.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, heartbeat_at, rounded_min, link_id, tags, reference)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const start = todayAt(14, 0)
    const stop = todayAt(15, 30)
    insertStmt.run(1, 'review', start, stop, stop, 90, null, '', 'GH-42')
    const row = db.prepare('SELECT * FROM entries').get() as Record<string, unknown>
    expect('reference' in row).toBe(true)
    expect(row.reference).toBe('GH-42')
  })
})

// ---------------------------------------------------------------------------
// Round-trip tests: billable flag + private_note stored and retrieved (#71/#72)
// ---------------------------------------------------------------------------
describe('billable + private_note — DB round-trip', () => {
  let tmpDir: string
  let db: Database.Database

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  function todayAt(hh: number, mm: number): string {
    const d = new Date(yesterday)
    d.setHours(hh, mm, 0, 0)
    return d.toISOString()
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-billable-'))
    db = openMigratedCopy(DatabaseImpl, templatePath, tmpDir)
    db.pragma('foreign_keys = ON')
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
  })

  afterEach(() => {
    const open = db
    db = undefined as unknown as Database.Database
    disposeCopy(open, tmpDir)
  })

  function insertEntry(overrides: { billable?: number; private_note?: string } = {}): number {
    const start = todayAt(8, 0)
    const stop = todayAt(9, 0)
    const info = db
      .prepare(
        `INSERT INTO entries (client_id, description, started_at, stopped_at, heartbeat_at,
        rounded_min, link_id, tags, reference, billable, private_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        1,
        'work',
        start,
        stop,
        stop,
        60,
        null,
        '',
        '',
        overrides.billable ?? 1,
        overrides.private_note ?? ''
      )
    return Number(info.lastInsertRowid)
  }

  it('billable defaults to 1', () => {
    const id = insertEntry()
    const row = db.prepare('SELECT billable FROM entries WHERE id = ?').get(id) as {
      billable: number
    }
    expect(row.billable).toBe(1)
  })

  it('persists billable = 0 (non-billable)', () => {
    const id = insertEntry({ billable: 0 })
    const row = db.prepare('SELECT billable FROM entries WHERE id = ?').get(id) as {
      billable: number
    }
    expect(row.billable).toBe(0)
  })

  it('private_note defaults to empty string', () => {
    const id = insertEntry()
    const row = db.prepare('SELECT private_note FROM entries WHERE id = ?').get(id) as {
      private_note: string
    }
    expect(row.private_note).toBe('')
  })

  it('persists non-empty private_note', () => {
    const id = insertEntry({ private_note: 'Interner Hinweis' })
    const row = db.prepare('SELECT private_note FROM entries WHERE id = ?').get(id) as {
      private_note: string
    }
    expect(row.private_note).toBe('Interner Hinweis')
  })

  it('billable and private_note columns are present in SELECT *', () => {
    const id = insertEntry({ billable: 0, private_note: 'Test' })
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Record<string, unknown>
    expect('billable' in row).toBe(true)
    expect('private_note' in row).toBe(true)
    expect(row.billable).toBe(0)
    expect(row.private_note).toBe('Test')
  })
})

// ---------------------------------------------------------------------------
// projects — validateProject + projects:* IPC SQL contract tests
// ---------------------------------------------------------------------------

/**
 * Local replica of validateProject from ipc.ts so we can test it without
 * booting the Electron runtime.
 */
function validateProject(
  input: { client_id: number | null; name: string; color: string; rate_cent?: number | null },
  db?: Database.Database
): string | null {
  const name = input.name?.trim() ?? ''
  if (name.length === 0) return 'Name darf nicht leer sein'
  if (name.length > 100) return 'Name darf höchstens 100 Zeichen lang sein'
  if (['allgemein', 'general'].includes(name.toLowerCase())) {
    return `"${input.name}" ist ein reservierter Name`
  }
  if (input.rate_cent !== undefined && input.rate_cent !== null) {
    const rate = Number(input.rate_cent)
    if (!Number.isFinite(rate) || rate < 0) return 'Stundensatz darf nicht negativ sein'
  }
  if (db && input.client_id !== null && input.client_id !== undefined) {
    const clientRow = db.prepare('SELECT id FROM clients WHERE id = ?').get(input.client_id) as
      | { id: number }
      | undefined
    if (!clientRow) return 'Kunde existiert nicht'
  }
  return null
}

describe('projects — validateProject', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-projects-'))
    db = openMigratedCopy(DatabaseImpl, templatePath, tmpDir)
    db.pragma('foreign_keys = ON')
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    db.prepare(`INSERT INTO clients (id, name) VALUES (2, 'Other')`).run()
  })

  afterEach(() => {
    const open = db
    db = undefined as unknown as Database.Database
    disposeCopy(open, tmpDir)
  })

  it('accepts valid project input', () => {
    const err = validateProject({ client_id: 1, name: 'App', color: '#abc', rate_cent: null }, db)
    expect(err).toBeNull()
  })

  it('rejects empty name', () => {
    const err = validateProject({ client_id: 1, name: '  ', color: '' }, db)
    expect(err).toMatch(/Name darf nicht leer/)
  })

  it('rejects name over 100 chars', () => {
    const err = validateProject({ client_id: 1, name: 'x'.repeat(101), color: '' }, db)
    expect(err).toMatch(/100 Zeichen/)
  })

  it('rejects reserved name "Allgemein"', () => {
    const err = validateProject({ client_id: 1, name: 'Allgemein', color: '' }, db)
    expect(err).toMatch(/reservierter Name/)
  })

  it('rejects reserved name "allgemein" (case-insensitive)', () => {
    const err = validateProject({ client_id: 1, name: 'allgemein', color: '' }, db)
    expect(err).toMatch(/reservierter Name/)
  })

  it('rejects negative rate_cent', () => {
    const err = validateProject({ client_id: 1, name: 'App', color: '', rate_cent: -100 }, db)
    expect(err).toMatch(/negativ/)
  })

  it('rejects unknown client_id', () => {
    const err = validateProject({ client_id: 999, name: 'App', color: '' }, db)
    expect(err).toMatch(/Kunde existiert nicht/)
  })

  it('allows null client_id (E4 orphan escape hatch)', () => {
    const err = validateProject({ client_id: null, name: 'App', color: '' }, db)
    expect(err).toBeNull()
  })
})

describe('projects — SQL contract tests', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-projects-sql-'))
    db = openMigratedCopy(DatabaseImpl, templatePath, tmpDir)
    db.pragma('foreign_keys = ON')
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme')`).run()
    db.prepare(`INSERT INTO clients (id, name) VALUES (2, 'Other')`).run()
  })

  afterEach(() => {
    const open = db
    db = undefined as unknown as Database.Database
    disposeCopy(open, tmpDir)
  })

  // Helper: insert a project and return its id
  function createProject(clientId: number | null, name: string, active = 1): number {
    const row = db
      .prepare(
        `INSERT INTO projects (client_id, name, color, rate_cent, active) VALUES (?, ?, '', NULL, ?) RETURNING id`
      )
      .get(clientId, name, active) as { id: number }
    return row.id
  }

  // Helper: insert an entry for a project
  function createEntry(
    clientId: number,
    projectId: number | null,
    deletedAt: string | null = null
  ): number {
    const start = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
    const stop = new Date(Date.now() - 1 * 3600 * 1000).toISOString()
    const info = db
      .prepare(
        `INSERT INTO entries (client_id, started_at, stopped_at, project_id, deleted_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(clientId, start, stop, projectId, deletedAt)
    return info.lastInsertRowid as number
  }

  it('projects:update — blocks client_id change when entries exist', () => {
    const pid = createProject(1, 'App')
    createEntry(1, pid)
    // Simulate the IPC guard: count entries
    const { n } = db
      .prepare(`SELECT COUNT(*) AS n FROM entries WHERE project_id = ? AND deleted_at IS NULL`)
      .get(pid) as { n: number }
    expect(n).toBeGreaterThan(0)
    // The handler would return fail() here — validate the guard
    const current = db.prepare('SELECT client_id FROM projects WHERE id = ?').get(pid) as {
      client_id: number | null
    }
    expect(current.client_id).toBe(1)
    // Moving to client 2 should be blocked
    const wouldBlock = current.client_id !== 2 && n > 0
    expect(wouldBlock).toBe(true)
  })

  it('projects:update — allows client_id change when no entries exist', () => {
    const pid = createProject(1, 'App')
    const { n } = db
      .prepare(`SELECT COUNT(*) AS n FROM entries WHERE project_id = ? AND deleted_at IS NULL`)
      .get(pid) as { n: number }
    expect(n).toBe(0)
    db.prepare(`UPDATE projects SET client_id = 2 WHERE id = ?`).run(pid)
    const updated = db.prepare('SELECT client_id FROM projects WHERE id = ?').get(pid) as {
      client_id: number
    }
    expect(updated.client_id).toBe(2)
  })

  it('projects:delete — blocked when active entries exist', () => {
    const pid = createProject(1, 'App')
    createEntry(1, pid)
    const { n } = db
      .prepare(`SELECT COUNT(*) AS n FROM entries WHERE project_id = ? AND deleted_at IS NULL`)
      .get(pid) as { n: number }
    expect(n).toBe(1)
    // Should throw inside the transaction
    expect(() => {
      const tx = db.transaction(() => {
        const countRow = db
          .prepare(`SELECT COUNT(*) AS n FROM entries WHERE project_id = ? AND deleted_at IS NULL`)
          .get(pid) as { n: number }
        if (countRow.n > 0) throw new Error('Projekt hat noch aktive Einträge')
        db.prepare('DELETE FROM projects WHERE id = ?').run(pid)
      })
      tx()
    }).toThrow(/aktive Einträge/)
    // Project must still exist
    const still = db.prepare('SELECT id FROM projects WHERE id = ?').get(pid)
    expect(still).toBeDefined()
  })

  it('projects:delete — succeeds when only soft-deleted entries exist', () => {
    const pid = createProject(1, 'App')
    createEntry(1, pid, new Date().toISOString()) // soft-deleted
    const { n } = db
      .prepare(`SELECT COUNT(*) AS n FROM entries WHERE project_id = ? AND deleted_at IS NULL`)
      .get(pid) as { n: number }
    expect(n).toBe(0)
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid)
    const gone = db.prepare('SELECT id FROM projects WHERE id = ?').get(pid)
    expect(gone).toBeUndefined()
  })

  it('projects:getAll — entry_count excludes soft-deleted entries', () => {
    const pid = createProject(1, 'App')
    createEntry(1, pid) // active
    createEntry(1, pid, new Date().toISOString()) // soft-deleted
    const row = db
      .prepare(
        `SELECT p.*, COALESCE(ec.cnt, 0) AS entry_count FROM projects p
         LEFT JOIN (SELECT project_id, COUNT(*) AS cnt FROM entries WHERE deleted_at IS NULL GROUP BY project_id) ec
           ON ec.project_id = p.id
         WHERE p.id = ?`
      )
      .get(pid) as { entry_count: number }
    expect(row.entry_count).toBe(1)
  })

  it('entries — project_id is stored and retrieved correctly', () => {
    const pid = createProject(1, 'App')
    const eid = createEntry(1, pid)
    const row = db.prepare('SELECT project_id FROM entries WHERE id = ?').get(eid) as {
      project_id: number | null
    }
    expect(row.project_id).toBe(pid)
  })

  // v1.12 #105 — projects.contact_person persists correctly
  it('projects:update — persists contact_person', () => {
    const pid = createProject(1, 'App')
    db.prepare(`UPDATE projects SET contact_person = 'Max Mustermann' WHERE id = ?`).run(pid)
    const row = db.prepare('SELECT contact_person FROM projects WHERE id = ?').get(pid) as {
      contact_person: string | null
    }
    expect(row.contact_person).toBe('Max Mustermann')
  })

  it('projects:update — contact_person defaults to NULL', () => {
    const pid = createProject(1, 'App')
    const row = db.prepare('SELECT contact_person FROM projects WHERE id = ?').get(pid) as {
      contact_person: string | null
    }
    expect(row.contact_person).toBeNull()
  })
})
//
// Root cause of the bug: julianday() arithmetic in SQLite uses IEEE-754
// floating point and can return 3599.9999... for a 3600-second interval.
// Math.floor(3599.999) = 3599 → "00:59" instead of "01:00".
// Fix: use strftime('%s', ...) which returns Unix epoch integers → exact.
// ---------------------------------------------------------------------------
describe('dashboard:summary — duration precision', () => {
  let db: Database.Database | null = null
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-duration-'))
    db = new DatabaseImpl(join(tmpDir, 'test.sqlite'))
    for (const m of migrations) {
      executeMigration(db, m)
    }
  })

  afterEach(() => {
    if (!db) return
    db.prepare('DELETE FROM entries').run()
  })

  it('returns exactly 3600 seconds for a 1-hour entry (not 3599)', () => {
    const d = db!
    const clientId = (
      d
        .prepare(`INSERT INTO clients (name, color, rate_cent, active) VALUES (?,?,?,1)`)
        .run('Test', '#fff', 0) as { lastInsertRowid: number | bigint }
    ).lastInsertRowid

    // Insert an entry that is exactly 1 hour (3600 s)
    const start = '2026-01-01T10:00:00.000Z'
    const stop = '2026-01-01T11:00:00.000Z'
    d.prepare(
      `INSERT INTO entries (client_id, description, started_at, stopped_at, heartbeat_at, rounded_min, link_id, tags)
         VALUES (?, '', ?, ?, ?, 60, NULL, '')`
    ).run(clientId, start, stop, stop)

    const row = d
      .prepare(
        `SELECT COALESCE(SUM(
             CASE
               WHEN stopped_at IS NULL
                 THEN CAST(strftime('%s', 'now') AS INTEGER) - CAST(strftime('%s', started_at) AS INTEGER)
               ELSE CAST(strftime('%s', stopped_at) AS INTEGER) - CAST(strftime('%s', started_at) AS INTEGER)
             END
           ), 0) AS seconds
           FROM entries
           WHERE deleted_at IS NULL`
      )
      .get() as { seconds: number }

    expect(row.seconds).toBe(3600)
  })
})

// ── normaliseBudgetMinutes (v1.11 #94) ──────────────────────────────────────

describe('normaliseBudgetMinutes', () => {
  it('returns null for undefined', () => {
    expect(normaliseBudgetMinutes(undefined)).toBeNull()
  })

  it('returns null for null', () => {
    expect(normaliseBudgetMinutes(null)).toBeNull()
  })

  it('returns null for zero', () => {
    expect(normaliseBudgetMinutes(0)).toBeNull()
  })

  it('returns null for negative values', () => {
    expect(normaliseBudgetMinutes(-60)).toBeNull()
  })

  it('returns null for NaN/Infinity', () => {
    expect(normaliseBudgetMinutes(NaN)).toBeNull()
    expect(normaliseBudgetMinutes(Infinity)).toBeNull()
  })

  it('returns rounded positive integer', () => {
    expect(normaliseBudgetMinutes(120)).toBe(120)
    expect(normaliseBudgetMinutes(90.6)).toBe(91)
    expect(normaliseBudgetMinutes('60')).toBe(60)
  })
})

// ── projects status/active sync (v1.11 #94) — direct SQL surface ────────────

describe('projects status/active sync', () => {
  let tmpDir2: string
  let db2: Database.Database

  beforeEach(() => {
    tmpDir2 = mkdtempSync(join(tmpdir(), 'tt-status-'))
    db2 = openMigratedCopy(DatabaseImpl, templatePath, tmpDir2)
    db2.pragma('foreign_keys = ON')
    db2.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Test')`).run()
    db2
      .prepare(`INSERT INTO projects (id, client_id, name, status) VALUES (1, 1, 'App', 'active')`)
      .run()
  })

  afterEach(() => {
    const open = db2
    db2 = undefined as unknown as Database.Database
    disposeCopy(open, tmpDir2)
  })

  it('projects:archive — sets status=archived and active=0', () => {
    // Replicate ipc.ts projects:archive SQL exactly
    db2.prepare('UPDATE projects SET active = 0, status = ? WHERE id = ?').run('archived', 1)
    const row = db2.prepare('SELECT active, status FROM projects WHERE id = 1').get() as {
      active: number
      status: string
    }
    expect(row.active).toBe(0)
    expect(row.status).toBe('archived')
  })

  it('projects:update — status=paused keeps active=0', () => {
    const status: string = 'paused'
    const activeFlag = status === 'active' ? 1 : 0
    db2
      .prepare('UPDATE projects SET active = ?, status = ? WHERE id = ?')
      .run(activeFlag, status, 1)
    const row = db2.prepare('SELECT active, status FROM projects WHERE id = 1').get() as {
      active: number
      status: string
    }
    expect(row.active).toBe(0)
    expect(row.status).toBe('paused')
  })

  it('projects:update — status=active sets active=1', () => {
    // First archive it
    db2.prepare('UPDATE projects SET active = 0, status = ? WHERE id = ?').run('archived', 1)
    // Then reactivate
    const status = 'active'
    const activeFlag = status === 'active' ? 1 : 0
    db2
      .prepare('UPDATE projects SET active = ?, status = ? WHERE id = ?')
      .run(activeFlag, status, 1)
    const row = db2.prepare('SELECT active, status FROM projects WHERE id = 1').get() as {
      active: number
      status: string
    }
    expect(row.active).toBe(1)
    expect(row.status).toBe('active')
  })

  it('clients:create — new billing/contact columns are stored and nullable', () => {
    db2
      .prepare(
        `INSERT INTO clients
             (name, color, rate_cent,
              billing_address_line1, billing_address_line2,
              billing_address_line3, billing_address_line4,
              vat_id, contact_person, contact_email)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'Neuer Kunde',
        '#abc',
        0,
        'Musterstraße 1',
        null,
        null,
        null,
        'DE123456789',
        'Max Muster',
        'max@example.com'
      )
    const row = db2.prepare(`SELECT * FROM clients WHERE name = 'Neuer Kunde'`).get() as Record<
      string,
      unknown
    >
    expect(row.billing_address_line1).toBe('Musterstraße 1')
    expect(row.billing_address_line2).toBeNull()
    expect(row.vat_id).toBe('DE123456789')
    expect(row.contact_email).toBe('max@example.com')
  })
})
