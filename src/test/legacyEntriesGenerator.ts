/**
 * Seeded generator of 1.x databases for the 2.0 migration (P1, design doc
 * section 11.9). It writes raw rows into a database migrated to the current
 * 1.x schema, in every shape section 10 names, including the 1.x defects:
 * unsplit timer rows over midnight, half-deleted pairs, zero-length recovered
 * rows, edited entries with a late `created_at` in SQLite's format, imported
 * entries with the anchor on the first half, and pairs whose halves differ.
 *
 * Alongside the rows it returns what a correct migration must produce. That
 * expectation is built here, from the generator's own intent, never from the
 * migration code, so the tests compare two independent descriptions.
 *
 * Times are computed in the process's local zone (the tests pin
 * Europe/Berlin); stored values are UTC ISO with milliseconds and Z, as
 * migration 027 left them.
 */
import type Database from 'better-sqlite3'
import type { MigrationException, MigrationShape } from '../main/entryLifecycle/migrateV2'

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One 1.x row as the generator wrote it. */
export interface LegacyRow {
  id: number
  client_id: number
  project_id: number | null
  description: string
  started_at: string
  stopped_at: string | null
  heartbeat_at: string | null
  created_at: string
  deleted_at: string | null
  link_id: string | null
  tags: string
  reference: string
  billable: number
  private_note: string
  graph_event_id: string | null
}

/** What the migration must produce for one logical entry. */
export interface ExpectedEntry {
  id: number
  legacyIds: number[]
  shapes: MigrationShape[]
  deleted: boolean
  /** The current content version is open (a live running timer). */
  open: boolean
  graphEventId: string | null
  heartbeatAt: string | null
  /** entry.created_at and version 1's written_at: ISO with Z, or verbatim if unreadable. */
  createdAt: string
  /** written_at of the delete version (the latest delete time), null if live. */
  deletedWrittenAt: string | null
  /** Segments of the current version, in day order. */
  segments: { started_at: string; stopped_at: string | null }[]
  /** Content fields of the version (all rows of the entry share them). */
  content: Pick<
    LegacyRow,
    'client_id' | 'project_id' | 'description' | 'tags' | 'reference' | 'billable' | 'private_note'
  >
}

export interface GeneratedDb {
  rows: LegacyRow[]
  expected: ExpectedEntry[]
  /** The exceptions the report must list, in no particular order. */
  exceptions: MigrationException[]
  clientRates: Map<number, number>
  /** project id → { client id, rate (null inherits) } */
  projects: Map<number, { clientId: number; rate: number | null }>
  step: number
  appLanguage: 'de' | 'en'
  maxLegacyId: number
}

const DESCRIPTIONS = ['Review', 'Workshop', 'Call', 'Doku', 'Bugfix', '']
const TAGS = ['', ',sap,', ',btp,review,', ',intern,']

const pad = (n: number): string => String(n).padStart(2, '0')
const iso = (d: Date): string => d.toISOString()
/** SQLite's datetime('now') format (UTC, no T, no Z), the 1.x default. */
const sqliteDatetime = (d: Date): string =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
  `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
/** The ISO form a stored created_at must become (decision 6), by string shape. */
const createdIso = (stored: string): string =>
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stored)
    ? `${stored.replace(' ', 'T')}.000Z`
    : stored /* already ISO with Z, or unreadable and kept verbatim */

type ShapeKind =
  | 'running'
  | 'single'
  | 'deletedSingle'
  | 'pair'
  | 'halfDeletedPair'
  | 'deletedPair'
  | 'inconsistentPair'
  | 'unsplitTimer'
  | 'zeroLength'
  | 'deletedRunning'
  | 'importedSingle'
  | 'importedPair'
  | 'editedLate'
  | 'sameDayPair'
  | 'createdAtUnreadable'

const KINDS: ShapeKind[] = [
  'sameDayPair',
  'createdAtUnreadable',
  'single',
  'single',
  'single',
  'deletedSingle',
  'pair',
  'pair',
  'halfDeletedPair',
  'deletedPair',
  'inconsistentPair',
  'unsplitTimer',
  'zeroLength',
  'deletedRunning',
  'importedSingle',
  'importedPair',
  'editedLate'
]

/**
 * Fill `db` (migrated to the current 1.x schema, no data) with one seeded
 * data set. Every shape kind appears at least once; the last logical entry is
 * a pair for odd seeds, so the highest ids are a pair (test 11.8).
 */
export function generateLegacyDb(db: Database.Database, seed: number, count = 40): GeneratedDb {
  const rnd = mulberry32(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1))

  // Clients, projects, settings.
  const clientRates = new Map<number, number>([
    [1, pick([0, 9000, 12000])],
    [2, pick([0, 9500])],
    [3, 15000]
  ])
  for (const [id, rate] of clientRates) {
    db.prepare('INSERT INTO clients (id, name, rate_cent) VALUES (?, ?, ?)').run(id, `C${id}`, rate)
  }
  const projects = new Map<number, { clientId: number; rate: number | null }>([
    [10, { clientId: 1, rate: null }],
    [11, { clientId: 1, rate: 0 }],
    [20, { clientId: 2, rate: 11000 }],
    [30, { clientId: 3, rate: null }]
  ])
  for (const [id, p] of projects) {
    db.prepare('INSERT INTO projects (id, client_id, name, rate_cent) VALUES (?, ?, ?, ?)').run(
      id,
      p.clientId,
      `P${id}`,
      p.rate
    )
  }
  // 'abc' is what a hand-edited setting can hold; 1.x readers take it as 0.
  const stepSetting = pick(['0', '0', '15', '6', 'abc'])
  const step = stepSetting === 'abc' ? 0 : Number(stepSetting)
  const appLanguage = rnd() < 0.4 ? 'en' : 'de'
  db.prepare("UPDATE settings SET value = ? WHERE key = 'pdf_round_minutes'").run(stepSetting)
  db.prepare("UPDATE settings SET value = ? WHERE key = 'language'").run(appLanguage)

  const rows: LegacyRow[] = []
  const expected: ExpectedEntry[] = []
  const exceptions: MigrationException[] = []
  let nextId = 1
  let anchor = 0
  let link = 0
  const takeId = (): number => {
    nextId += rnd() < 0.15 ? int(1, 3) : 0 // id gaps
    return nextId++
  }

  const content = (clientId: number): ExpectedEntry['content'] => {
    const projectIds = [...projects].filter(([, p]) => p.clientId === clientId).map(([id]) => id)
    return {
      client_id: clientId,
      project_id: projectIds.length > 0 && rnd() < 0.6 ? pick(projectIds) : null,
      description: pick(DESCRIPTIONS),
      tags: pick(TAGS),
      reference: rnd() < 0.3 ? `REF-${int(1, 99)}` : '',
      billable: rnd() < 0.85 ? 1 : 0,
      private_note: rnd() < 0.2 ? 'note' : ''
    }
  }
  const day = (): Date => new Date(2026, pick([9, 10]), int(1, 27)) // Oct/Nov 2026, local
  const at = (base: Date, h: number, m: number, s = 0): Date =>
    new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, s)
  const row = (r: Omit<LegacyRow, 'id'> & { id?: number }): LegacyRow => {
    const full = { ...r, id: r.id ?? takeId() } as LegacyRow
    rows.push(full)
    return full
  }

  /** A row set split at local midnight, as 1.x insertEntrySegments wrote it. */
  const makePair = (
    c: ExpectedEntry['content'],
    extra: { graph?: string; secondDiffers?: boolean } = {}
  ): [LegacyRow, LegacyRow] => {
    const d = day()
    const start = at(d, int(21, 23), int(0, 59))
    const midnight = at(d, 24, 0)
    const end = at(d, 24 + int(0, 2), int(1, 59))
    const linkId = `link-${++link}`
    const created = sqliteDatetime(end)
    // The anchor sits on either half: 1.x import wrote it on the first, an
    // edit that re-split the entry can leave it on the second.
    const anchorOnSecond = extra.graph !== undefined && rnd() < 0.3
    const a = row({
      ...c,
      started_at: iso(start),
      stopped_at: iso(midnight),
      heartbeat_at: null,
      created_at: created,
      deleted_at: null,
      link_id: linkId,
      graph_event_id: anchorOnSecond ? null : (extra.graph ?? null)
    })
    const c2 = extra.secondDiffers ? { ...c, description: `${c.description} (edited)` } : c
    const b = row({
      ...c2,
      started_at: iso(midnight),
      stopped_at: iso(end),
      heartbeat_at: null,
      created_at: created,
      deleted_at: null,
      link_id: linkId,
      graph_event_id: anchorOnSecond ? extra.graph! : null
    })
    return [a, b]
  }
  const seg = (r: LegacyRow): ExpectedEntry['segments'][number] => ({
    started_at: r.started_at,
    stopped_at: r.stopped_at
  })
  const expect = (
    rs: LegacyRow[],
    shapes: MigrationShape[],
    over: Partial<ExpectedEntry> = {}
  ): void => {
    const deleted = rs.every((r) => r.deleted_at !== null)
    expected.push({
      id: Math.min(...rs.map((r) => r.id)),
      legacyIds: rs.map((r) => r.id),
      shapes,
      deleted,
      open: false,
      graphEventId: rs.find((r) => r.graph_event_id)?.graph_event_id ?? null,
      heartbeatAt: null,
      // All rows of one logical entry share created_at here.
      createdAt: createdIso(rs[0].created_at),
      deletedWrittenAt: deleted ? rs.map((r) => r.deleted_at!).sort()[rs.length - 1] : null,
      segments: rs.map(seg),
      content: {
        client_id: rs[0].client_id,
        project_id: rs[0].project_id,
        description: rs[0].description,
        tags: rs[0].tags,
        reference: rs[0].reference,
        billable: rs[0].billable,
        private_note: rs[0].private_note
      },
      ...over
    })
  }

  const kinds: ShapeKind[] = [...KINDS]
  while (kinds.length < count) kinds.push(pick(KINDS))
  // Shuffle, then force the last one to be a pair for odd seeds.
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[kinds[i], kinds[j]] = [kinds[j], kinds[i]]
  }
  // At most one live running timer, as the app has; then, for odd seeds, a
  // pair last, so the highest ids are a pair.
  if (rnd() < 0.7) kinds.push('running')
  if (seed % 2 === 1) kinds.push('pair')

  for (const kind of kinds) {
    const c = content(pick([1, 2, 3]))
    const d = day()
    switch (kind) {
      case 'running': {
        const start = new Date(2026, 10, 28, 9, int(0, 59))
        const hb = iso(new Date(start.getTime() + int(1, 120) * 60000))
        const r = row({
          ...c,
          started_at: iso(start),
          stopped_at: null,
          heartbeat_at: hb,
          created_at: sqliteDatetime(start),
          deleted_at: null,
          link_id: null,
          graph_event_id: null
        })
        expect([r], ['single', 'running'], { open: true, heartbeatAt: hb })
        break
      }
      case 'single':
      case 'deletedSingle':
      case 'importedSingle':
      case 'editedLate': {
        const start = at(d, int(7, 17), int(0, 59), int(0, 59))
        const end = new Date(start.getTime() + int(1, 300) * 60000 + int(0, 59) * 1000)
        const r = row({
          ...c,
          started_at: iso(start),
          stopped_at: iso(end),
          heartbeat_at: null,
          created_at:
            kind === 'editedLate'
              ? sqliteDatetime(new Date(end.getTime() + 3 * 86400000))
              : rnd() < 0.7
                ? sqliteDatetime(start)
                : iso(start),
          deleted_at: kind === 'deletedSingle' ? iso(new Date(end.getTime() + 3600000)) : null,
          link_id: null,
          graph_event_id: kind === 'importedSingle' ? `graph-${++anchor}` : null
        })
        const shapes: MigrationShape[] = ['single']
        if (kind === 'deletedSingle') shapes.push('deleted')
        if (kind === 'importedSingle') shapes.push('imported')
        expect([r], shapes)
        break
      }
      case 'pair':
      case 'importedPair': {
        const graph = kind === 'importedPair' ? `graph-${++anchor}` : undefined
        const [a, b] = makePair(c, { graph })
        expect([a, b], kind === 'importedPair' ? ['pair', 'imported'] : ['pair'])
        break
      }
      case 'halfDeletedPair': {
        const [a, b] = makePair(c)
        const del = rnd() < 0.5 ? a : b
        del.deleted_at = iso(new Date(Date.parse(b.stopped_at!) + 7200000))
        const live = del === a ? b : a
        expect([live], ['halfDeletedPair'])
        expect([del], ['halfDeletedPair', 'deleted'])
        break
      }
      case 'deletedPair': {
        // 1.x deleted both halves in one statement (equal times); a later
        // edit could leave them apart, which the report lists.
        const [a, b] = makePair(c)
        const apart = rnd() < 0.5
        a.deleted_at = iso(new Date(Date.parse(b.stopped_at!) + 3600000))
        b.deleted_at = apart
          ? iso(new Date(Date.parse(b.stopped_at!) + 3600000 + int(1, 50) * 1000))
          : a.deleted_at
        if (apart) exceptions.push({ code: 'migration.deletedAtDiffers', legacyIds: [a.id, b.id] })
        expect([a, b], ['pair', 'deleted'])
        break
      }
      case 'inconsistentPair': {
        const [a, b] = makePair(c, { secondDiffers: true })
        exceptions.push({ code: 'migration.inconsistentPair', legacyIds: [a.id, b.id] })
        expect([a], ['inconsistentPair'])
        expect([b], ['inconsistentPair'])
        break
      }
      case 'sameDayPair': {
        // Two halves of one link starting on the same local day (a half
        // edited onto the other's day): one version cannot hold both.
        const linkId = `link-${++link}`
        const [a, b] = [int(7, 10), int(13, 17)].map((h) => {
          const start = at(d, h, int(0, 59))
          return row({
            ...c,
            started_at: iso(start),
            stopped_at: iso(new Date(start.getTime() + int(10, 120) * 60000)),
            heartbeat_at: null,
            created_at: sqliteDatetime(start),
            deleted_at: null,
            link_id: linkId,
            graph_event_id: null
          })
        })
        exceptions.push({ code: 'migration.sameDayPair', legacyIds: [a.id, b.id] })
        expect([a], ['inconsistentPair'])
        expect([b], ['inconsistentPair'])
        break
      }
      case 'createdAtUnreadable': {
        const start = at(d, int(8, 16), int(0, 59))
        const r = row({
          ...c,
          started_at: iso(start),
          stopped_at: iso(new Date(start.getTime() + int(5, 90) * 60000)),
          heartbeat_at: null,
          created_at: 'gestern',
          deleted_at: null,
          link_id: null,
          graph_event_id: null
        })
        exceptions.push({ code: 'migration.createdAtUnreadable', legacyIds: [r.id] })
        expect([r], ['single'])
        break
      }
      case 'unsplitTimer': {
        const start = at(d, 23, int(0, 50))
        const end = at(d, 24 + int(0, 2), int(1, 59))
        const r = row({
          ...c,
          started_at: iso(start),
          stopped_at: iso(end),
          heartbeat_at: iso(end),
          created_at: sqliteDatetime(start),
          deleted_at: null,
          link_id: null,
          graph_event_id: null
        })
        expect([r], ['single', 'unsplitOverMidnight'])
        break
      }
      case 'zeroLength': {
        const start = at(d, int(8, 18), int(0, 59))
        const r = row({
          ...c,
          started_at: iso(start),
          stopped_at: iso(start),
          heartbeat_at: null,
          created_at: sqliteDatetime(start),
          deleted_at: null,
          link_id: null,
          graph_event_id: null
        })
        expect([r], ['single', 'zeroLength'])
        break
      }
      case 'deletedRunning': {
        const start = at(d, int(8, 18), int(0, 59))
        const hb = rnd() < 0.5 ? iso(new Date(start.getTime() + int(1, 90) * 60000)) : null
        const r = row({
          ...c,
          started_at: iso(start),
          stopped_at: null,
          heartbeat_at: hb,
          created_at: sqliteDatetime(start),
          deleted_at: iso(new Date(start.getTime() + 4 * 3600000)),
          link_id: null,
          graph_event_id: null
        })
        exceptions.push({ code: 'migration.deletedRunningSealed', legacyIds: [r.id] })
        expect([r], ['single', 'deletedRunning', 'deleted'], {
          segments: [{ started_at: r.started_at, stopped_at: hb ?? r.started_at }]
        })
        break
      }
    }
  }

  const ins = db.prepare(
    `INSERT INTO entries (id, client_id, project_id, description, started_at, stopped_at,
       heartbeat_at, created_at, deleted_at, link_id, tags, reference, billable, private_note,
       graph_event_id)
     VALUES (@id, @client_id, @project_id, @description, @started_at, @stopped_at,
       @heartbeat_at, @created_at, @deleted_at, @link_id, @tags, @reference, @billable,
       @private_note, @graph_event_id)`
  )
  for (const r of rows) ins.run(r)

  return {
    rows,
    expected,
    exceptions,
    clientRates,
    projects,
    step,
    appLanguage,
    maxLegacyId: Math.max(...rows.map((r) => r.id))
  }
}
