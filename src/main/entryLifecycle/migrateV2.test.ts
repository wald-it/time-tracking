/**
 * 2.0 entry lifecycle, P1: the migration from 1.x (design doc sections 10
 * and 11.8/11.9, with the conductor's P1 decisions).
 *
 * Every database comes from the seeded generator (src/test/legacyEntriesGenerator),
 * never from real data. The expected result is the generator's own description
 * of what it wrote, and the money oracle below recomputes worked time, billed
 * minutes and revenue straight from the raw 1.x rows: neither uses the
 * migration's code.
 *
 * Pinned to Europe/Berlin for the whole file (a segment's date is local), in a
 * file of its own because a TZ pin leaks into later tests of the same file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import type Database from 'better-sqlite3'
import {
  createMigratedTemplate,
  loadSqlite,
  openMigratedCopy,
  type DatabaseCtor
} from '../../test/sqlite'
import {
  generateLegacyDb,
  type GeneratedDb,
  type LegacyRow
} from '../../test/legacyEntriesGenerator'
import {
  MIGRATION_SHAPES,
  MigrationAbortError,
  migrateEntriesToV2,
  type MigrationException
} from './migrateV2'

let DatabaseImpl: DatabaseCtor
let templateDir: string
let template: string
const previousTz = process.env.TZ

beforeAll(async () => {
  process.env.TZ = 'Europe/Berlin'
  DatabaseImpl = await loadSqlite()
  templateDir = mkdtempSync(join(tmpdir(), 'tt-v2-template-'))
  template = createMigratedTemplate(DatabaseImpl, templateDir)
})
afterAll(() => {
  rmSync(templateDir, { recursive: true, force: true })
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

let dir: string
let db: Database.Database
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-v2-'))
  db = openMigratedCopy(DatabaseImpl, template, dir)
  db.pragma('foreign_keys = ON')
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const migrate = (
  opts?: Parameters<typeof migrateEntriesToV2>[1]
): ReturnType<typeof migrateEntriesToV2> => db.transaction(() => migrateEntriesToV2(db, opts))()

// ── independent oracle ──────────────────────────────────────────────────────
const localDate = (isoString: string): string => {
  const d = new Date(isoString)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** The 1.x billing rule, written out again here on purpose. */
const billed = (ms: number, step: number): number => {
  const raw = ms > 0 ? Math.ceil(ms / 60000) : 0
  return step > 0 && raw > 0 ? Math.ceil(raw / step) * step : raw
}
const fee = (minutes: number, rate: number): number =>
  rate > 0 && minutes > 0 ? Math.round((minutes * rate) / 60) : 0

interface Totals {
  workedMs: number
  billedMin: number
  feeCent: number
  feeUnroundedCent: number
}
type Sums = Map<string, Totals>
const add = (sums: Sums, key: string, ms: number, step: number, rate: number): void => {
  const t = sums.get(key) ?? { workedMs: 0, billedMin: 0, feeCent: 0, feeUnroundedCent: 0 }
  const b = billed(ms, step)
  t.workedMs += ms
  t.billedMin += b
  t.feeCent += fee(b, rate)
  t.feeUnroundedCent += fee(billed(ms, 0), rate)
  sums.set(key, t)
}

/** Per client × local month × billable, from the raw 1.x rows. */
function oracleSums(g: GeneratedDb): Sums {
  const sums: Sums = new Map()
  for (const r of g.rows) {
    if (r.deleted_at !== null || r.stopped_at === null) continue
    const p = r.project_id !== null ? g.projects.get(r.project_id) : undefined
    const rate = p && p.rate !== null ? p.rate : g.clientRates.get(r.client_id)!
    const ms = Date.parse(r.stopped_at) - Date.parse(r.started_at)
    const key = `${r.client_id}|${localDate(r.started_at).slice(0, 7)}|${r.billable}`
    add(sums, key, ms, g.step, rate)
  }
  return sums
}

/** The same sums read from the new tables (current segments of live entries). */
function newTableSums(): Sums {
  const profile = db
    .prepare(
      'SELECT interval_min FROM billing_profile WHERE client_id IS NULL AND project_id IS NULL'
    )
    .get() as { interval_min: number }
  const rateOf = (clientId: number, projectId: number | null): number => {
    if (projectId !== null) {
      const p = db
        .prepare('SELECT rate_cent FROM rate WHERE project_id = ? ORDER BY valid_from DESC LIMIT 1')
        .get(projectId) as { rate_cent: number | null } | undefined
      if (p && p.rate_cent !== null) return p.rate_cent
    }
    const c = db
      .prepare('SELECT rate_cent FROM rate WHERE client_id = ? ORDER BY valid_from DESC LIMIT 1')
      .get(clientId) as { rate_cent: number } | undefined
    return c?.rate_cent ?? 0
  }
  const segs = db
    .prepare(
      `SELECT v.client_id, v.project_id, v.billable, s.started_at, s.stopped_at
         FROM entry e
         JOIN entry_version v ON v.id = e.current_version_id
         JOIN entry_segment s ON s.version_id = v.id
        WHERE e.is_deleted = 0 AND s.stopped_at IS NOT NULL`
    )
    .all() as {
    client_id: number
    project_id: number | null
    billable: number
    started_at: string
    stopped_at: string
  }[]
  const sums: Sums = new Map()
  for (const s of segs) {
    const ms = Date.parse(s.stopped_at) - Date.parse(s.started_at)
    add(
      sums,
      `${s.client_id}|${localDate(s.started_at).slice(0, 7)}|${s.billable}`,
      ms,
      profile.interval_min,
      rateOf(s.client_id, s.project_id)
    )
  }
  return sums
}

const sorted = (m: Sums): [string, Totals][] => [...m].sort(([a], [b]) => a.localeCompare(b))

// ── T1 + T2: every shape, every invariant, over many seeds ──────────────────
// Not every seed holds every shape (some have no running entry); the shapes
// are checked across all seeds, and 20 seeds keep all migration mutants red.
const seenShapes = Object.fromEntries(MIGRATION_SHAPES.map((s) => [s, 0])) as Record<
  (typeof MIGRATION_SHAPES)[number],
  number
>
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1)

describe('migrateEntriesToV2 over generated 1.x databases (#P1, test 11.9)', () => {
  it.each(SEEDS)(
    'seed %i: ids, versions, segments, money and report match the generator',
    (seed) => {
      const g = generateLegacyDb(db, seed)
      const before = db.prepare('SELECT * FROM entries ORDER BY id').all()

      const report = migrate()

      // entries is left untouched (P1 decision 1).
      expect(db.prepare('SELECT * FROM entries ORDER BY id').all()).toEqual(before)

      // Report: counts per shape equal the generator's.
      const shapeCounts = Object.fromEntries(MIGRATION_SHAPES.map((s) => [s, 0]))
      for (const e of g.expected) for (const s of e.shapes) shapeCounts[s]++
      expect(report.shapes).toEqual(shapeCounts)
      for (const s of MIGRATION_SHAPES) seenShapes[s] += report.shapes[s]
      expect(report.legacyRows).toBe(g.rows.length)
      expect(report.entries).toBe(g.expected.length)
      const byKey = (xs: MigrationException[]): string[] =>
        xs.map((x) => `${x.code}:${[...x.legacyIds].sort((a, b) => a - b).join(',')}`).sort()
      expect(byKey(report.exceptions)).toEqual(byKey(g.exceptions))

      // Every legacy id resolves to its entry; entry id = smallest row id.
      const legacy = new Map(
        (
          db.prepare('SELECT legacy_id, entry_id FROM entry_legacy_id').all() as {
            legacy_id: number
            entry_id: number
          }[]
        ).map((r) => [r.legacy_id, r.entry_id])
      )
      expect(legacy.size).toBe(g.rows.length)
      for (const e of g.expected) for (const id of e.legacyIds) expect(legacy.get(id)).toBe(e.id)

      // New entries start above every 1.x id (test 11.8).
      const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'entry'").get() as {
        seq: number
      }
      expect(seq.seq).toBe(g.maxLegacyId)

      for (const e of g.expected) {
        const entry = db.prepare('SELECT * FROM entry WHERE id = ?').get(e.id) as Record<
          string,
          unknown
        >
        expect(entry, `entry ${e.id}`).toBeDefined()
        expect(entry.is_deleted).toBe(e.deleted ? 1 : 0)
        expect(entry.graph_event_id).toBe(e.graphEventId)
        expect(entry.created_source).toBe('migration')
        expect(entry.heartbeat_at).toBe(e.open ? e.heartbeatAt : null)
        expect(entry.created_at).toBe(e.createdAt)
        const versions = db
          .prepare(
            'SELECT version_no, written_at FROM entry_version WHERE entry_id = ? ORDER BY version_no'
          )
          .all(e.id)
        expect(versions).toEqual([
          { version_no: 1, written_at: e.createdAt },
          ...(e.deleted ? [{ version_no: 2, written_at: e.deletedWrittenAt }] : [])
        ])
        const v = db
          .prepare('SELECT * FROM entry_version WHERE id = ?')
          .get(entry.current_version_id) as Record<string, unknown>
        expect(v.entry_id).toBe(e.id)
        expect(v.deleted).toBe(e.deleted ? 1 : 0)
        expect(v.state).toBe(e.open ? 'open' : 'sealed')
        expect(v.version_no).toBe(e.deleted ? 2 : 1)
        for (const [k, val] of Object.entries(e.content)) expect(v[k], `${e.id}.${k}`).toBe(val)
        const segs = db
          .prepare(
            'SELECT seq, segment_date, started_at, stopped_at FROM entry_segment WHERE version_id = ? ORDER BY seq'
          )
          .all(v.id) as {
          seq: number
          segment_date: string
          started_at: string
          stopped_at: string | null
        }[]
        expect(segs.map(({ started_at, stopped_at }) => ({ started_at, stopped_at }))).toEqual(
          e.segments
        )
        for (const s of segs) expect(s.segment_date).toBe(localDate(s.started_at))
      }

      // Money: the new tables give the oracle's numbers per client and month.
      expect(sorted(newTableSums())).toEqual(sorted(oracleSums(g)))
    }
  )

  it('every shape of section 10 appears in the reports (equal counts alone would pass at 0 = 0)', () => {
    for (const s of MIGRATION_SHAPES) expect(seenShapes[s], `shape ${s}`).toBeGreaterThan(0)
  })

  it("rates and the default profile carry today's values; the profile is German whatever the app language (decision 8)", () => {
    let seenEn = false
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      db.close()
      rmSync(dir, { recursive: true, force: true })
      dir = mkdtempSync(join(tmpdir(), 'tt-v2-'))
      db = openMigratedCopy(DatabaseImpl, template, dir)
      const g = generateLegacyDb(db, seed)
      if (g.appLanguage === 'en') seenEn = true
      migrate()
      const profile = db
        .prepare('SELECT * FROM billing_profile WHERE client_id IS NULL AND project_id IS NULL')
        .get() as Record<string, unknown>
      expect(profile).toMatchObject({
        interval_min: g.step,
        min_unit_min: 0,
        alignment: g.step > 0 ? 'grid' : 'none',
        columns: 'times',
        language: 'de',
        fee_column: 'auto',
        group_by: 'none'
      })
      for (const [id, rate] of g.clientRates) {
        expect(
          db.prepare('SELECT rate_cent, valid_from FROM rate WHERE client_id = ?').all(id)
        ).toEqual([{ rate_cent: rate, valid_from: '0001-01-01' }])
      }
      for (const [id, p] of g.projects) {
        const rows = db
          .prepare('SELECT rate_cent, valid_from FROM rate WHERE project_id = ?')
          .all(id)
        expect(rows).toEqual(
          p.rate === null ? [] : [{ rate_cent: p.rate, valid_from: '0001-01-01' }]
        )
      }
    }
    expect(seenEn, 'the seeds include an English app language').toBe(true)
  })
})

// ── T3: the self-check and the abort paths ──────────────────────────────────
describe('migrateEntriesToV2 aborts and rolls back', () => {
  /** Which of the 1.x table and the six P1 tables exist. */
  const tables = (): string[] =>
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
           ('entries', 'entry', 'entry_version', 'entry_segment', 'entry_legacy_id', 'rate', 'billing_profile')
         ORDER BY name`
        )
        .all() as { name: string }[]
    ).map((r) => r.name)

  it('a segment changed after the write fails the self-check; nothing stays behind', () => {
    generateLegacyDb(db, 7)
    const before = db.prepare('SELECT * FROM entries ORDER BY id').all()
    expect(() =>
      migrate({
        afterWrite: (d) => {
          d.prepare(
            `UPDATE entry_segment SET stopped_at = strftime('%Y-%m-%dT%H:%M:%fZ', stopped_at, '+1 hour')
              WHERE rowid = (SELECT MIN(rowid) FROM entry_segment WHERE stopped_at IS NOT NULL)`
          ).run()
        }
      })
    ).toThrow(expect.objectContaining({ code: 'migration.selfCheckFailed' }))
    expect(tables()).toEqual(['entries'])
    expect(db.prepare('SELECT * FROM entries ORDER BY id').all()).toEqual(before)
  })

  it('content changed after the write fails the per-row check, which the sums cannot see', () => {
    const g = generateLegacyDb(db, 7)
    const victim = g.rows.find((r) => r.deleted_at === null && r.stopped_at !== null)!
    expect(() =>
      migrate({
        afterWrite: (d) => {
          d.prepare(
            `UPDATE entry_version SET description = description || ' (moved)'
              WHERE version_no = 1
                AND entry_id = (SELECT entry_id FROM entry_legacy_id WHERE legacy_id = ?)`
          ).run(victim.id)
        }
      })
    ).toThrow(expect.objectContaining({ code: 'migration.selfCheckFailed' }))
    expect(tables()).toEqual(['entries'])
  })

  it('an unreadable timestamp aborts and names the row id (decision 7)', () => {
    const g = generateLegacyDb(db, 8)
    const victim = g.rows.find((r: LegacyRow) => r.stopped_at !== null)!
    db.prepare("UPDATE entries SET started_at = 'yesterday-ish' WHERE id = ?").run(victim.id)
    let error: unknown
    try {
      migrate()
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(MigrationAbortError)
    expect(error).toMatchObject({ code: 'migration.timestampUnreadable' })
    expect((error as MigrationAbortError).details.join(' ')).toContain(String(victim.id))
    expect(tables()).toEqual(['entries'])
  })

  it('an unreadable heartbeat of a deleted running row aborts too: it would be the seal', () => {
    const g = generateLegacyDb(db, 8)
    const victim = g.rows.find((r) => r.deleted_at !== null && r.stopped_at === null)!
    db.prepare("UPDATE entries SET heartbeat_at = 'soon' WHERE id = ?").run(victim.id)
    expect(() => migrate()).toThrow(
      expect.objectContaining({ code: 'migration.timestampUnreadable' })
    )
    expect(tables()).toEqual(['entries'])
  })

  it('a rounding step above 60 minutes aborts: a billing profile holds 1 to 60', () => {
    generateLegacyDb(db, 8)
    db.prepare("UPDATE settings SET value = '90' WHERE key = 'pdf_round_minutes'").run()
    expect(() => migrate()).toThrow(
      expect.objectContaining({ code: 'migration.roundingUnsupported' })
    )
    expect(tables()).toEqual(['entries'])
  })

  it('a row the new tables cannot hold aborts naming its legacy id', () => {
    const g = generateLegacyDb(db, 8)
    const victim = g.rows.find((r) => r.link_id === null)!
    // A client gone without its rows: 1.x cascades, but a database written
    // with foreign keys off can still hold one.
    db.pragma('foreign_keys = OFF')
    db.prepare('UPDATE entries SET client_id = 999 WHERE id = ?').run(victim.id)
    db.pragma('foreign_keys = ON')
    let error: unknown
    try {
      migrate()
    } catch (e) {
      error = e
    }
    expect(error).toMatchObject({ code: 'migration.writeFailed' })
    expect((error as MigrationAbortError).details.join(' ')).toContain(`legacy ids ${victim.id}:`)
    expect(tables()).toEqual(['entries'])
  })
})

// ── T4: ids above 1.x (test 11.8) ────────────────────────────────────────────
describe('ids after the migration', () => {
  it('with the highest 1.x ids being a pair, a new entry gets a fresh id and the second half still resolves', () => {
    const g = generateLegacyDb(db, 9) // odd seed: the last entry is a pair
    const last = g.expected.find((e) => e.legacyIds.includes(g.maxLegacyId))!
    expect(last.legacyIds).toHaveLength(2)
    migrate()
    const id = db
      .prepare(
        "INSERT INTO entry (created_at, created_source, current_version_id) VALUES ('2026-12-01T00:00:00.000Z', 'app', 0)"
      )
      .run().lastInsertRowid
    expect(Number(id)).toBe(g.maxLegacyId + 1)
    expect(
      (
        db
          .prepare('SELECT entry_id FROM entry_legacy_id WHERE legacy_id = ?')
          .get(g.maxLegacyId) as {
          entry_id: number
        }
      ).entry_id
    ).toBe(Math.min(...last.legacyIds))
  })
})

// ── T6: not registered ─────────────────────────────────────────────────────
describe('P1 stays out of the running app', () => {
  it('nothing outside entryLifecycle and the tests imports it, the migration runner included', () => {
    const root = join(__dirname, '..', '..')
    const offenders: string[] = []
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        if (statSync(p).isDirectory()) {
          if (name !== 'entryLifecycle' && name !== 'node_modules') walk(p)
          continue
        }
        if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue
        if (relative(root, p).replace(/\\/g, '/').startsWith('test/')) continue
        if (/entryLifecycle/.test(readFileSync(p, 'utf8'))) offenders.push(relative(root, p))
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
