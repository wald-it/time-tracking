/**
 * Runs the backup probe against a copy of the owner's backup. Not a test and
 * not part of `pnpm test`: it needs a real file and prints a report for a
 * person to read. Start it with
 *
 *   $env:BACKUP_PROBE_DB = '<path to a backup .sqlite>'
 *   pnpm test --config vitest.probe.config.ts
 *
 * The copy goes to a fresh folder under the system temp directory; the source
 * file is never opened. Never commit the output, it names real entry ids.
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, it } from 'vitest'
import { loadSqlite } from '../../test/sqlite'
import { formatProbeResult, runBackupProbe } from './backupProbe'

it('runs the P1 migration on a copy of the backup and prints the report', async () => {
  const source = process.env.BACKUP_PROBE_DB
  expect(source, 'Set BACKUP_PROBE_DB to the path of a backup .sqlite file').toBeTruthy()
  const Ctor = await loadSqlite()
  const workDir = mkdtempSync(join(tmpdir(), 'tt-backup-probe-'))
  const result = runBackupProbe(Ctor, source as string, workDir)
  process.stdout.write(`\n${formatProbeResult(result)}\n\n`)
})
