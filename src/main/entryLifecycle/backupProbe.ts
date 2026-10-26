/**
 * 2.0 entry lifecycle, backup probe (design doc, L7 and test 11.9): run the
 * P1 migration against a copy of the owner's backup and report what it found.
 * Needs no registration in the runner, which is the point: P2 registers the
 * migration only after this has run cleanly.
 *
 * The source file is only ever copied, never opened. The migration runs on the
 * copy inside a transaction that is always rolled back, so the copy stays a
 * 1.x database and the probe can be repeated on it. An abort
 * (MigrationAbortError) is a result of the probe, not a failure of it.
 */
import type Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { basename, join, resolve } from 'path'
import {
  MIGRATION_SHAPES,
  MigrationAbortError,
  migrateEntriesToV2,
  type MigrationReport
} from './migrateV2'

export type ProbeOutcome =
  | { kind: 'report'; report: MigrationReport }
  | { kind: 'abort'; code: string; details: string[] }

export interface ProbeResult {
  sourcePath: string
  copyPath: string
  /** The zone the run used: a segment's date is the local date of its start. */
  timeZone: string
  outcome: ProbeOutcome
}

/**
 * Copy `sourcePath` into `workDir` and run the migration on the copy.
 * Refuses a source with WAL sidecars: a plain file copy would miss their
 * contents, and a probe on a partial copy proves nothing.
 */
export function runBackupProbe(
  Ctor: new (path: string) => Database.Database,
  sourcePath: string,
  workDir: string
): ProbeResult {
  const source = resolve(sourcePath)
  if (!existsSync(source)) throw new Error(`Backup not found: ${source}`)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(source + suffix)) {
      throw new Error(`${source + suffix} exists: the backup is not a single self-contained file`)
    }
  }
  const work = resolve(workDir)
  mkdirSync(work, { recursive: true })
  const copyPath = join(work, `probe-${basename(source)}`)
  if (resolve(copyPath) === source) throw new Error('The work directory holds the source file')
  copyFileSync(source, copyPath)

  const db = new Ctor(copyPath)
  let outcome: ProbeOutcome
  try {
    db.exec('BEGIN')
    try {
      outcome = { kind: 'report', report: migrateEntriesToV2(db) }
    } catch (err) {
      if (!(err instanceof MigrationAbortError)) throw err
      outcome = { kind: 'abort', code: err.code, details: err.details }
    } finally {
      db.exec('ROLLBACK')
    }
  } finally {
    db.close()
  }
  return {
    sourcePath: source,
    copyPath,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    outcome
  }
}

/** Plain text for the owner's review (acceptance criterion 2). */
export function formatProbeResult(result: ProbeResult): string {
  const lines = [
    'Backup probe (design doc L7, test 11.9)',
    `Source: ${result.sourcePath}`,
    `Copy:   ${result.copyPath}`,
    `Zone:   ${result.timeZone}`,
    ''
  ]
  const { outcome } = result
  if (outcome.kind === 'abort') {
    lines.push(`ABORTED: ${outcome.code}`)
    for (const d of outcome.details) lines.push(`  ${d}`)
    return lines.join('\n')
  }
  const { report } = outcome
  lines.push(`Legacy rows: ${report.legacyRows}`, `Entries:     ${report.entries}`, '', 'Shapes:')
  for (const s of MIGRATION_SHAPES) lines.push(`  ${s.padEnd(20)} ${report.shapes[s]}`)
  lines.push('', 'Exceptions by code:')
  if (report.exceptions.length === 0) lines.push('  none')
  const byCode = new Map<string, number[][]>()
  for (const e of report.exceptions) {
    byCode.set(e.code, [...(byCode.get(e.code) ?? []), e.legacyIds])
  }
  for (const [code, groups] of [...byCode].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${code}: ${groups.length}`)
    for (const ids of groups) lines.push(`    ids ${ids.join(', ')}`)
  }
  lines.push('', 'Self-check passed; the transaction was rolled back, the copy is still 1.x.')
  return lines.join('\n')
}
