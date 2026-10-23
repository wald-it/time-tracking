/**
 * Guard (#263): the berlin-zone CI job runs every test file that pins a zone
 * itself, so those files also run once with SQLite in Europe/Berlin. The job
 * names them one by one — a list that rots silently when a new zone-pinned
 * file is added. This test reads the workflow and turns red instead.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const REPO_ROOT = resolve(__dirname, '..', '..')
const STEP_NAME = 'Test zone-pinned files (Europe/Berlin)'
/** An assignment to the zone, not a mention in prose. */
const PINS_ZONE = /process\.env\.TZ\s*=[^=]/

function testFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) testFiles(join(dir, entry.name), acc)
    else if (/\.test\.tsx?$/.test(entry.name)) {
      acc.push(relative(REPO_ROOT, join(dir, entry.name)).split(sep).join('/'))
    }
  }
  return acc
}

/** The file arguments of the step, read from the workflow text. */
function listedInJob(): string[] {
  const yml = readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8')
  const lines = yml.split(/\r?\n/)
  const at = lines.findIndex((l) => l.includes(`name: ${STEP_NAME}`))
  if (at < 0) return []
  const listed: string[] = []
  for (const line of lines.slice(at + 1)) {
    if (/^\s*- (name|uses):/.test(line) || /^\S/.test(line)) break
    const m = /^\s+(src\/\S+\.test\.tsx?)\s*$/.exec(line)
    if (m) listed.push(m[1])
  }
  return listed
}

describe('the berlin-zone job runs every zone-pinned test file', () => {
  const pinned = testFiles(join(REPO_ROOT, 'src'))
    .filter((f) => !f.endsWith('.berlin.test.ts'))
    .filter((f) => PINS_ZONE.test(readFileSync(join(REPO_ROOT, f), 'utf8')))
  const listed = listedInJob()

  it('finds zone-pinned files and the step at all', () => {
    expect(pinned.length).toBeGreaterThan(5)
    expect(listed.length, `no file list under "${STEP_NAME}" in test.yml`).toBeGreaterThan(0)
  })

  it('every file that pins a zone is listed in the job', () => {
    const missing = pinned.filter((f) => !listed.includes(f))
    expect(missing, `add to "${STEP_NAME}" in test.yml:\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('every listed file still exists and still pins a zone', () => {
    const stale = listed.filter((f) => !pinned.includes(f))
    expect(stale, `remove from "${STEP_NAME}" in test.yml:\n  ${stale.join('\n  ')}`).toEqual([])
  })
})
