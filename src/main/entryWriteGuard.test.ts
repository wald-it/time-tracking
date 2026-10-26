/**
 * No bypass (design doc 11.5): every write to the entry tables in `src/`
 * goes through `writeEntry`. A grep over the sources for INSERT / UPDATE /
 * DELETE on `entry`, `entry_version`, `entry_segment` and the view `entries`
 * finds them only in the files listed here. The view itself refuses writes
 * at run time (entryWrite.test.ts); this guard catches the source before it
 * runs.
 *
 * Red probe (P2): a direct `UPDATE entries SET heartbeat_at …` put back into
 * ipc.ts turns this test red (see the PR report).
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'

const SRC = join(__dirname, '..')

/** Files that may write the entry tables directly, relative to src/. */
const ALLOWED = new Set([
  'main/entryMutations.ts',
  'main/entryLifecycle/migrateV2.ts',
  'main/entryLifecycle/schemaV2.ts',
  // Proves at run time that the view and the sealed-version triggers refuse
  // exactly these statements.
  'main/entryWrite.test.ts',
  'test/entryFixtures.ts',
  'test/legacyEntriesGenerator.ts'
])
const ALLOWED_DIRS = ['main/migrations/', 'main/entryLifecycle/']

/** The statements the guard looks for, on one line or across lines. */
export const WRITE_RE =
  /\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(entry|entry_version|entry_segment|entries)\b/gi

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function isAllowed(rel: string): boolean {
  if (ALLOWED.has(rel)) return true
  if (ALLOWED_DIRS.some((d) => rel.startsWith(d) && /\.test\.tsx?$/.test(rel))) return true
  return rel.startsWith('main/migrations/')
}

describe('no write to the entry tables outside writeEntry (11.5)', () => {
  const offenders: string[] = []
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).split(sep).join('/')
    if (rel === 'main/entryWriteGuard.test.ts') continue
    const text = readFileSync(file, 'utf8')
    const hits = [...text.matchAll(WRITE_RE)]
    if (hits.length > 0 && !isAllowed(rel)) {
      for (const h of hits) {
        const line = text.slice(0, h.index).split('\n').length
        offenders.push(`${rel}:${line}: ${h[0].replace(/\s+/g, ' ')}`)
      }
    }
  }

  it('finds no direct INSERT / UPDATE / DELETE on entry, entry_version, entry_segment or entries', () => {
    expect(offenders).toEqual([])
  })

  it('the pattern catches the statements it is meant to', () => {
    const probe = [
      'db.prepare(`UPDATE entries SET heartbeat_at = ? WHERE id = ?`)',
      "db.exec('INSERT INTO entry_version (entry_id) VALUES (1)')",
      'DELETE FROM entry_segment WHERE version_id = ?',
      'INSERT OR IGNORE INTO entry (id) VALUES (1)',
      'UPDATE\n  entries SET x = 1'
    ]
    for (const p of probe) expect(p.match(WRITE_RE)).not.toBeNull()
    // Not entry tables: no hit.
    for (const p of [
      'UPDATE entries_v1 SET x = 1',
      'DELETE FROM clients',
      'UPDATE entry_legacy_id SET x = 1'
    ]) {
      expect(p.match(WRITE_RE)).toBeNull()
    }
  })
})
