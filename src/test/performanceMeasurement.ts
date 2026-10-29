/** Shared sampling contract for the P7 probe and its temporary 1.x runner. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { cpus, hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type Database from 'better-sqlite3'
import type { DatabaseCtor } from './sqlite'

export const PERF = {
  seed: 20261028,
  entries: 50_000,
  now: '2026-10-28T12:00:00.000Z',
  warmup: 10,
  runs: 30
} as const

/**
 * Absolute bounds on the median at 50,000 entries (owner decision 2026-10-29,
 * "Regel absolut, Ursache als Issue"; the scaling question is #397). The ratio
 * against v1.23.2 is printed for information and does not decide PASS or FAIL.
 */
export const BOUNDS_MS = { monthEntries: 50, buildAnalyticsSummary: 200 } as const

export interface Verdict {
  name: keyof typeof BOUNDS_MS
  before: number
  after: number
  ratio: number
  pass: boolean
  line: string
}

/** Judge a current report against the absolute bounds; the baseline only feeds the ratio. */
export function judgePerformance(
  baseline: PerformanceReport,
  current: PerformanceReport
): Verdict[] {
  return (Object.keys(BOUNDS_MS) as (keyof typeof BOUNDS_MS)[]).map((name) => {
    const before = baseline.medians[name]
    const after = current.medians[name]
    const ratio = after / before
    const pass = after < BOUNDS_MS[name]
    const line = `${name}: v1.23.2=${before.toFixed(3)} ms; 2.0=${after.toFixed(3)} ms; ratio=${ratio.toFixed(3)}; bound < ${BOUNDS_MS[name]} ms; ${pass ? 'PASS' : 'FAIL'}`
    return { name, before, after, ratio, pass, line }
  })
}

interface Target {
  Ctor: DatabaseCtor
  migrate: (db: Database.Database, path: string) => unknown
  month: (db: Database.Database, year: number, month: number) => unknown[]
  analytics: (db: Database.Database, query: { year: number; month: number }, now: Date) => unknown
}

export interface PerformanceReport {
  contract: typeof PERF & {
    sha256: string
    year: number
    month: number
    monthRows: number
    timezone: string
    host: string
    cpu: string
    platform: string
    arch: string
    node: string
    electron: string
    sqlite: { v: string }
  }
  schema: number
  measuredAt: string
  medians: { monthEntries: number; buildAnalyticsSummary: number }
  samples: { monthEntries: number[]; buildAnalyticsSummary: number[] }
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function measurePerformance(source: string, target: Target): PerformanceReport {
  const dir = mkdtempSync(join(tmpdir(), 'tt-perf-measure-'))
  const path = join(dir, 'copy.sqlite')
  // The seed is closed in DELETE journal mode. Only copies are ever opened.
  const sha256 = createHash('sha256').update(readFileSync(source)).digest('hex')
  copyFileSync(source, path)
  const db = new target.Ctor(path)
  try {
    const count = db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }
    assert.equal(count.n, PERF.entries)
    const busy = db
      .prepare(
        `
      SELECT strftime('%Y-%m', started_at, 'localtime') AS month, COUNT(*) AS n FROM entries
      WHERE deleted_at IS NULL GROUP BY 1 ORDER BY n DESC, month ASC LIMIT 1
    `
      )
      .get() as { month: string; n: number }
    assert(busy.n > 900, 'The selected month must be busy')
    const [year, month] = busy.month.split('-').map(Number)
    const contract = {
      ...PERF,
      sha256,
      year,
      month,
      monthRows: busy.n,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      host: hostname(),
      cpu: cpus()[0].model,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron,
      sqlite: db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
    }
    // Match getDb(): WAL and foreign keys, then the complete startup runner.
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    target.migrate(db, path)
    const schema = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }
    const now = new Date(PERF.now)
    const operations = {
      monthEntries: () => target.month(db, year, month),
      buildAnalyticsSummary: () => target.analytics(db, { year, month }, now)
    }
    const check = (name: keyof typeof operations, result: unknown): void => {
      if (name === 'monthEntries') {
        assert(Array.isArray(result) && result.length >= busy.n, 'Month query returned no fixture')
      } else {
        const summary = result as { ok: boolean; data?: { month: { hasData: boolean } } }
        assert.equal(summary.ok, true, 'Analytics must succeed, not time a caught error')
        assert.equal(summary.data?.month.hasData, true)
      }
    }
    const samples = { monthEntries: [] as number[], buildAnalyticsSummary: [] as number[] }
    const names = Object.keys(operations) as (keyof typeof operations)[]
    // Alternate order to spread GC/cache effects; validation is outside the timer.
    for (let i = 0; i < PERF.warmup + PERF.runs; i++) {
      for (const name of i % 2 ? [...names].reverse() : names) {
        const start = performance.now()
        const result = operations[name]()
        const elapsed = performance.now() - start
        check(name, result)
        if (i >= PERF.warmup) samples[name].push(elapsed)
      }
    }
    return {
      contract,
      schema: schema.v,
      measuredAt: new Date().toISOString(),
      medians: {
        monthEntries: median(samples.monthEntries),
        buildAnalyticsSummary: median(samples.buildAnalyticsSummary)
      },
      samples
    }
  } finally {
    if (db.open) db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
