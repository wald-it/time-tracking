/**
 * Data integrity of migration 027 on a database as 1.21.0 left it (schema 26):
 * every timestamp ends up canonical, soft-deleted rows included, the stored
 * instants do not move, a second run writes nothing — and the calendar month
 * and the PDF time sheet give the same answer for rows that were canonical
 * already, and the answer the parsed instants call for on rewritten rows.
 *
 * The oracle below parses the original strings itself, by the rules 027
 * documents (offset or `Z` as given, no zone = local time and the earlier of
 * the doubled hour, bare date = UTC midnight). It deliberately does not call
 * `canonicalTimestamp`, or the test would compare 027 with itself.
 *
 * Pinned to Europe/Berlin, in a file of its own (#248/#250): `delete
 * process.env.TZ` does not reset Node's zone. Only JS-side local time is used
 * here (`localMonthRange`, `localDayRange`, the PDF's Intl formatting);
 * SQLite's 'localtime' would not follow the pin on Windows, which is why the
 * "Heute" totals live in migration027Totals.test.ts without a pin.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { executeMigration, migrations } from './index'
import { loadSqlite, type DatabaseCtor } from '../../test/sqlite'
import { monthEntries } from '../entryRanges'
import { billedMinutes } from '../../shared/currency'
import { localDayRange, localMonthRange } from '../../shared/dateRanges'

let DatabaseImpl: DatabaseCtor
const previousTz = process.env.TZ
// Imported after the zone is set: pdf.ts builds its Intl formatters on load.
let buildPdfPayload: typeof import('../pdf').buildPdfPayload

beforeAll(async () => {
  process.env.TZ = 'Europe/Berlin'
  DatabaseImpl = await loadSqlite()
  ;({ buildPdfPayload } = await import('../pdf'))
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const COLUMNS = ['started_at', 'stopped_at', 'heartbeat_at'] as const
type Column = (typeof COLUMNS)[number]

/** Epoch ms of a stored string, by the rules 027 documents — independently. */
function oracleMs(value: string): number {
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (bare) return Date.UTC(+bare[1], +bare[2] - 1, +bare[3])
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(
      value
    )
  if (!m) throw new Error(`oracle cannot read ${value}`)
  const [y, mo, d, h, mi, s, ms] = [
    +m[1],
    +m[2] - 1,
    +m[3],
    +m[4],
    +m[5],
    +(m[6] ?? 0),
    +(m[7] ?? 0)
  ]
  const zone = m[8]
  // No zone: local wall clock. ECMAScript resolves the doubled hour to the
  // earlier instant; the expected values below spell that out once more.
  if (zone === undefined) return new Date(y, mo, d, h, mi, s, ms).getTime()
  const utc = Date.UTC(y, mo, d, h, mi, s, ms)
  if (zone === 'Z') return utc
  const sign = zone[0] === '-' ? -1 : 1
  const offsetMin = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)))
  return utc - offsetMin * 60_000
}

interface Seed {
  id: number
  client_id: number
  started_at: string
  stopped_at: string | null
  heartbeat_at: string | null
  deleted_at: string | null
}

/**
 * Client 1 holds only rows that are canonical already; client 2 only rows a
 * 1.21.0 database could hold in another form. That split lets the PDF (one
 * client per sheet) check both halves of the contract separately.
 */
const SEEDS: Seed[] = [
  // ── already canonical (client 1) ──────────────────────────────────────
  {
    id: 1,
    client_id: 1,
    started_at: '2026-10-02T08:00:00.000Z',
    stopped_at: '2026-10-02T10:00:00.000Z',
    heartbeat_at: '2026-10-02T10:00:00.000Z',
    deleted_at: null
  },
  // 00:30 local on the 1st: belongs to October although the UTC date is 30.09.
  {
    id: 2,
    client_id: 1,
    started_at: '2026-09-30T22:30:00.000Z',
    stopped_at: '2026-09-30T23:30:00.000Z',
    heartbeat_at: null,
    deleted_at: null
  },
  // Across the doubled hour of 2026-10-25 (02:30 CEST → 02:30 CET).
  {
    id: 3,
    client_id: 1,
    started_at: '2026-10-25T00:30:00.000Z',
    stopped_at: '2026-10-25T01:30:00.000Z',
    heartbeat_at: '2026-10-25T01:30:00.000Z',
    deleted_at: null
  },
  // 23:30 local on the 31st (CET): last day of October.
  {
    id: 4,
    client_id: 1,
    started_at: '2026-10-31T22:30:00.000Z',
    stopped_at: '2026-10-31T22:45:00.000Z',
    heartbeat_at: null,
    deleted_at: null
  },
  // Canonical and soft-deleted.
  {
    id: 5,
    client_id: 1,
    started_at: '2026-10-03T08:00:00.000Z',
    stopped_at: '2026-10-03T09:00:00.000Z',
    heartbeat_at: null,
    deleted_at: '2026-10-04T08:00:00.000Z'
  },
  // ── forms 027 rewrites (client 2) ─────────────────────────────────────
  // Offset, as the old startTimer stored an MCP start_timer.
  {
    id: 11,
    client_id: 2,
    started_at: '2026-10-01T00:30:00+02:00',
    stopped_at: '2026-10-01T01:30:00+02:00',
    heartbeat_at: '2026-10-01T01:30:00+02:00',
    deleted_at: null
  },
  // No zone: local time.
  {
    id: 12,
    client_id: 2,
    started_at: '2026-10-05T09:00:00',
    stopped_at: '2026-10-05T10:15:00',
    heartbeat_at: '2026-10-05T10:15:00',
    deleted_at: null
  },
  // Bare date: UTC midnight (02:00 local), ended canonically.
  {
    id: 13,
    client_id: 2,
    started_at: '2026-10-06',
    stopped_at: '2026-10-06T03:00:00.000Z',
    heartbeat_at: null,
    deleted_at: null
  },
  // `Z` without milliseconds.
  {
    id: 14,
    client_id: 2,
    started_at: '2026-10-07T08:00:00Z',
    stopped_at: '2026-10-07T09:00:00Z',
    heartbeat_at: '2026-10-07T09:00:00Z',
    deleted_at: null
  },
  // The doubled hour of 2026-10-25, first pass (+02:00) …
  {
    id: 15,
    client_id: 2,
    started_at: '2026-10-25T02:05:00+02:00',
    stopped_at: '2026-10-25T02:20:00+02:00',
    heartbeat_at: null,
    deleted_at: null
  },
  // … and second pass (+01:00): an hour later in real time.
  {
    id: 16,
    client_id: 2,
    started_at: '2026-10-25T02:05:00+01:00',
    stopped_at: '2026-10-25T02:20:00+01:00',
    heartbeat_at: null,
    deleted_at: null
  },
  // Ends in the doubled hour, end without a zone: the earlier 02:40.
  {
    id: 17,
    client_id: 2,
    started_at: '2026-10-25T01:30:00+02:00',
    stopped_at: '2026-10-25T02:40:00',
    heartbeat_at: '2026-10-25T02:40:00',
    deleted_at: null
  },
  // Ends in the doubled hour, second pass given explicitly.
  {
    id: 18,
    client_id: 2,
    started_at: '2026-10-25T02:30:00+01:00',
    stopped_at: '2026-10-25T02:50:00+01:00',
    heartbeat_at: null,
    deleted_at: null
  },
  // Soft-deleted, offset form.
  {
    id: 19,
    client_id: 2,
    started_at: '2026-10-08T10:00:00+02:00',
    stopped_at: '2026-10-08T11:00:00+02:00',
    heartbeat_at: '2026-10-08T11:00:00+02:00',
    deleted_at: '2026-10-09T10:00:00.000Z'
  },
  // Soft-deleted and left running, no zone.
  {
    id: 20,
    client_id: 2,
    started_at: '2026-10-10T07:00:00',
    stopped_at: null,
    heartbeat_at: '2026-10-10T07:30:00',
    deleted_at: '2026-10-10T08:00:00.000Z'
  }
]

/** Anchors for the oracle on the cases where the rule matters most. */
const EXPECTED_ISO: Record<number, Partial<Record<Column, string>>> = {
  11: { started_at: '2026-09-30T22:30:00.000Z' },
  12: { started_at: '2026-10-05T07:00:00.000Z' },
  13: { started_at: '2026-10-06T00:00:00.000Z' },
  15: { started_at: '2026-10-25T00:05:00.000Z' },
  16: { started_at: '2026-10-25T01:05:00.000Z' },
  17: { stopped_at: '2026-10-25T00:40:00.000Z' },
  18: { started_at: '2026-10-25T01:30:00.000Z', stopped_at: '2026-10-25T01:50:00.000Z' }
}

type Row = Seed & Record<string, unknown>

describe('migration 027 on a 1.21.0 database (schema 26)', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tt-m027-integrity-'))
    db = new DatabaseImpl(join(tmpDir, 'test.sqlite'))
    db.pragma('foreign_keys = ON')
    db.exec(
      `CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    )
    for (const m of migrations.filter((mm) => mm.version <= 26)) {
      db.transaction(() => {
        executeMigration(db, m)
        db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(
          m.version,
          m.name
        )
      })()
    }
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Acme'), (2, 'Beta')`).run()
    const ins = db.prepare(
      `INSERT INTO entries (id, client_id, description, started_at, stopped_at, heartbeat_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    for (const s of SEEDS) {
      ins.run(
        s.id,
        s.client_id,
        `row ${s.id}`,
        s.started_at,
        s.stopped_at,
        s.heartbeat_at,
        s.deleted_at
      )
    }
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const migration27 = migrations.find((m) => m.version === 27)!
  const apply27 = (): void => db.transaction(() => executeMigration(db, migration27))()
  const allRows = (): Row[] => db.prepare('SELECT * FROM entries ORDER BY id').all() as Row[]
  const totalChanges = (): number =>
    (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n

  it('the oracle agrees with the documented anchors', () => {
    for (const [id, cols] of Object.entries(EXPECTED_ISO)) {
      const seed = SEEDS.find((s) => s.id === Number(id))!
      for (const [col, iso] of Object.entries(cols)) {
        expect(new Date(oracleMs(seed[col as Column]!)).toISOString(), `#${id} ${col}`).toBe(iso)
      }
    }
  })

  it('every row is canonical afterwards and no instant moved, soft-deleted rows included', () => {
    apply27()
    const rows = allRows()
    expect(rows.map((r) => r.id)).toEqual(SEEDS.map((s) => s.id))
    for (const seed of SEEDS) {
      const row = rows.find((r) => r.id === seed.id)!
      for (const col of COLUMNS) {
        const before = seed[col]
        const after = row[col] as string | null
        if (before === null) {
          expect(after, `#${seed.id} ${col}`).toBeNull()
          continue
        }
        expect(after, `#${seed.id} ${col}`).toMatch(CANONICAL)
        expect(Date.parse(after!), `#${seed.id} ${col}`).toBe(oracleMs(before))
      }
      // Soft-deleted stays soft-deleted, with the same stamp.
      expect(row.deleted_at, `#${seed.id} deleted_at`).toBe(seed.deleted_at)
      expect(row.client_id).toBe(seed.client_id)
    }
  })

  it('leaves rows that were canonical already byte for byte', () => {
    const before = allRows().filter((r) => r.client_id === 1)
    apply27()
    expect(allRows().filter((r) => r.client_id === 1)).toEqual(before)
  })

  it('a second run changes nothing', () => {
    apply27()
    const once = allRows()
    const changes = totalChanges()
    apply27()
    expect(allRows()).toEqual(once)
    expect(totalChanges()).toBe(changes)
  })

  describe('same answers before and after', () => {
    const live = SEEDS.filter((s) => s.deleted_at === null)

    /** Rows whose parsed start falls into [start, end), by the oracle. */
    function oracleIdsIn(range: { start: string; end: string }, clientId?: number): number[] {
      const lo = Date.parse(range.start)
      const hi = Date.parse(range.end)
      return live
        .filter((s) => clientId === undefined || s.client_id === clientId)
        .filter((s) => oracleMs(s.started_at) >= lo && oracleMs(s.started_at) < hi)
        .sort((a, b) => oracleMs(a.started_at) - oracleMs(b.started_at) || a.id - b.id)
        .map((s) => s.id)
    }

    it('calendar month (entries:getByMonth): canonical rows unchanged, rewritten rows where their instant says', () => {
      const months: Array<[number, number]> = [
        [2026, 9],
        [2026, 10],
        [2026, 11]
      ]
      const canonicalBefore = months.map(([y, m]) =>
        monthEntries(db, y, m).filter((e) => e.client_id === 1)
      )
      apply27()
      months.forEach(([y, m], i) => {
        const after = monthEntries(db, y, m)
        expect(
          after.filter((e) => e.client_id === 1),
          `${y}-${m} canonical`
        ).toEqual(canonicalBefore[i])
        expect(
          after.map((e) => e.id),
          `${y}-${m} all rows`
        ).toEqual(oracleIdsIn(localMonthRange(y, m)))
      })
    })

    it('PDF time sheet: canonical client unchanged, rewritten client totals by the parsed instants', () => {
      const req = (clientId: number): Parameters<typeof buildPdfPayload>[1] => ({
        clientId,
        fromIso: '2026-09-01',
        toIso: '2026-11-30'
      })
      const generated = '2026-11-01T00:00:00.000Z'
      const canonicalBefore = buildPdfPayload(db, req(1), '', generated)
      apply27()
      expect(buildPdfPayload(db, req(1), '', generated)).toEqual(canonicalBefore)

      const after = buildPdfPayload(db, req(2), '', generated)
      const expectedIds = oracleIdsIn(localDayRange('2026-09-01', '2026-11-30'), 2).filter(
        (id) => SEEDS.find((s) => s.id === id)!.stopped_at !== null
      )
      const expectedMinutes = expectedIds.map((id) => {
        const s = SEEDS.find((x) => x.id === id)!
        return billedMinutes(oracleMs(s.stopped_at!) - oracleMs(s.started_at), 0)
      })
      expect(after.rows.map((r) => r.description)).toEqual(expectedIds.map((id) => `row ${id}`))
      expect(after.rows.map((r) => r.minutes)).toEqual(expectedMinutes)
      expect(after.totals.minutes).toBe(expectedMinutes.reduce((a, b) => a + b, 0))
    })
  })
})
