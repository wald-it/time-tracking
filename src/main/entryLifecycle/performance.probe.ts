/**
 * P7 release gate: 50,000 seeded 1.x entries, measured on copies with each
 * release's complete startup migration runner. Not part of `pnpm test`.
 * Run on an otherwise idle machine, baseline first, then 2.0:
 *
 *   $env:PERF_MODE = 'seed'
 *   $env:PERF_BASE_ROOT = '<worktree at v1.23.2>'
 *   pnpm test --config vitest.probe.config.ts performance.probe.ts
 *
 * Seed mode prints the remaining PowerShell commands. The temporary baseline
 * harness runs through that worktree's own pnpm test, but lives under temp so
 * the baseline tree stays untouched. It imports only 1.x production code.
 * PERF_DB is the closed seed file; PERF_BASELINE_JSON is its measured report.
 * Baselines are machine-specific; never commit them or generated databases.
 * A baseline seeded before the absolute bounds below no longer matches the
 * contract (it still carries `limit`); seed it again.
 *
 * Bounds (owner decision 2026-10-29, "Regel absolut, Ursache als Issue"): the
 * median of Auswertung (buildAnalyticsSummary) under 200 ms and of the month
 * view (monthEntries) under 50 ms, both absolute at 50,000 entries (BOUNDS_MS
 * in src/test/performanceMeasurement.ts). The ratio against v1.23.2 is printed
 * for information only. It replaces the owner's 2026-10-28 bound of "at most
 * 20% over v1.23.2" for the Auswertung. The scaling question is #397.
 */
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { applyMigrations, LAST_V1_VERSION, loadSqlite } from '../../test/sqlite'
import { generatePerformanceLegacyDb } from '../../test/legacyEntriesGenerator'
import {
  BOUNDS_MS,
  judgePerformance,
  measurePerformance,
  PERF,
  type PerformanceReport
} from '../../test/performanceMeasurement'
import { runMigrations } from '../migrations/runner'
import { migrations } from '../migrations'
import { monthEntries } from '../entryRanges'
import { buildAnalyticsSummary } from '../analyticsHandlers'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const userData = mkdtempSync(join(tmpdir(), 'tt-perf-userdata-'))
  return { app: { getPath: () => userData }, ipcMain: { handle: vi.fn() } }
})

async function seed(): Promise<void> {
  const base = process.env.PERF_BASE_ROOT
  expect(base, 'Set PERF_BASE_ROOT to the v1.23.2 worktree').toBeTruthy()
  const root = resolve(base!)
  const dir = mkdtempSync(join(tmpdir(), 'tt-perf-seed-'))
  const path = join(dir, 'legacy.sqlite')
  const Ctor = await loadSqlite()
  const db = new Ctor(path)
  try {
    applyMigrations(db, LAST_V1_VERSION)
    const workingDays = generatePerformanceLegacyDb(db, PERF.seed, PERF.entries)
    expect(db.prepare('SELECT COUNT(*) AS n FROM entries').get()).toEqual({ n: PERF.entries })
    const stats = db
      .prepare(
        `
      SELECT MIN(date(started_at, 'localtime')) AS firstDay,
        MAX(date(started_at, 'localtime')) AS lastDay,
        COUNT(DISTINCT client_id) AS clients, COUNT(DISTINCT project_id) AS projects,
        SUM(deleted_at IS NOT NULL) AS deleted,
        SUM(date(started_at, 'localtime') <> date(stopped_at, 'localtime')) AS overnight
      FROM entries
    `
      )
      .get()
    process.stdout.write(`\nFixture: ${JSON.stringify(stats)}; ${workingDays} working days\n`)
  } finally {
    db.close()
  }
  // The baseline imports this dependency-free sampler, never current readers.
  copyFileSync(resolve('src/test/performanceMeasurement.ts'), join(dir, 'measurement.ts'))
  const normalized = (p: string): string => p.replaceAll('\\', '/')
  const baselineProbe = join(dir, 'baseline.probe.ts')
  const config = join(dir, 'baseline.config.mjs')
  const report = join(dir, 'baseline.json')
  writeFileSync(
    baselineProbe,
    `
import { it, expect, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { loadSqlite } from '@target/test/sqlite'
import { runMigrations } from '@target/main/migrations/runner'
import { monthEntries } from '@target/main/entryRanges'
import { buildAnalyticsSummary } from '@target/main/analyticsHandlers'
import { measurePerformance } from './measurement'
vi.mock('electron', () => ({ app: { getPath: () => ${JSON.stringify(dir)} }, ipcMain: { handle: vi.fn() } }))
it('measures v1.23.2 on the shared seed', async () => {
  const result = measurePerformance(${JSON.stringify(path)}, {
    Ctor: await loadSqlite(), migrate: runMigrations, month: monthEntries, analytics: buildAnalyticsSummary
  })
  expect(result.schema).toBe(27)
  writeFileSync(${JSON.stringify(report)}, JSON.stringify(result, null, 2))
  console.log('v1.23.2 baseline (ms):', result.medians)
})
`
  )
  writeFileSync(
    config,
    `
export default {
  root: ${JSON.stringify(normalized(dir))},
  cacheDir: ${JSON.stringify(normalized(join(dir, 'cache')))},
  resolve: { alias: {
    '@target': ${JSON.stringify(normalized(join(root, 'src')))},
    'vitest': ${JSON.stringify(normalized(join(root, 'node_modules/vitest/dist/index.js')))}
  } },
  test: { environment: 'node', include: ['baseline.probe.ts'], testTimeout: 600000 }
}
`
  )
  const ps = (p: string): string => `'${p.replaceAll("'", "''")}'`
  process.stdout.write(
    [
      `\n$env:PERF_DB = ${ps(path)}`,
      `$env:PERF_BASELINE_JSON = ${ps(report)}`,
      `pnpm --dir ${ps(root)} test --config ${ps(config)} --configLoader native`,
      "$env:PERF_MODE = 'compare'",
      'pnpm test --config vitest.probe.config.ts performance.probe.ts',
      ''
    ].join('\n')
  )
}

it('gates month view (< 50 ms) and Auswertung (< 200 ms) absolutely, with the v1.23.2 ratio as information', async () => {
  const mode = process.env.PERF_MODE ?? 'compare'
  expect(['seed', 'compare']).toContain(mode)
  if (mode === 'seed') return seed()
  const source = process.env.PERF_DB
  const baselinePath = process.env.PERF_BASELINE_JSON
  expect(source, 'Set PERF_DB to the seed file printed by PERF_MODE=seed').toBeTruthy()
  expect(baselinePath, 'Set PERF_BASELINE_JSON to the v1.23.2 report').toBeTruthy()
  const baseline: PerformanceReport = JSON.parse(readFileSync(baselinePath!, 'utf8'))
  expect(baseline.schema).toBe(LAST_V1_VERSION)
  const current = measurePerformance(source!, {
    Ctor: await loadSqlite(),
    migrate: runMigrations,
    month: monthEntries,
    analytics: buildAnalyticsSummary
  })
  expect(current.schema).toBe(migrations.at(-1)!.version)
  expect(
    current.contract,
    'Baseline must use the same input, machine, runtime and sampling; a baseline seeded before the absolute bounds (its contract has `limit`) must be seeded again'
  ).toEqual(baseline.contract)
  process.stdout.write(
    `\nP7: ${PERF.entries} entries; ${current.contract.year}-${current.contract.month}; now=${PERF.now}; warmup=${PERF.warmup}; N=${PERF.runs}; bounds: monthEntries < ${BOUNDS_MS.monthEntries} ms, buildAnalyticsSummary < ${BOUNDS_MS.buildAnalyticsSummary} ms\n`
  )
  for (const name of ['monthEntries', 'buildAnalyticsSummary'] as const) {
    const before = baseline.medians[name]
    expect(Number.isFinite(before) && before > 0, `Invalid baseline for ${name}`).toBe(true)
  }
  const verdicts = judgePerformance(baseline, current)
  for (const v of verdicts) process.stdout.write(`${v.line}\n`)
  const report = join(mkdtempSync(join(tmpdir(), 'tt-perf-report-')), 'comparison.json')
  writeFileSync(report, JSON.stringify({ baseline, current }, null, 2))
  process.stdout.write(`Report: ${report}\n`)
  expect(
    verdicts.every((v) => v.pass),
    `Month view must stay under ${BOUNDS_MS.monthEntries} ms, Auswertung under ${BOUNDS_MS.buildAnalyticsSummary} ms`
  ).toBe(true)
})
