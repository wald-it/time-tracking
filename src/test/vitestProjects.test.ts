/**
 * Guard: every test file in the repo is actually run by some Vitest project.
 *
 * This replaces the absolute test count that used to sit in CLAUDE.md ("a
 * green run is 596 passed"). That number was a proxy for the real condition,
 * and it rotted within three releases — 596 against an actual 969 reads as
 * "something is broken" to whoever compares them next.
 *
 * But the number did cover one thing the "0 skipped" rule does not: a suite
 * that silently *shrinks*. Vitest runs the files its projects include and says
 * nothing about the ones they do not — a test file in an uncovered directory
 * never runs, reports no skip, and leaves the run green. That risk grew when
 * the `streamdeck` project was added for the plugin's modules (#186): had the
 * registration been wrong, 32 tests would have quietly stopped existing.
 *
 * So the condition moves out of prose and into a check that can go red:
 *   - every `*.test.ts(x)` in the repo matches at least one project's include
 *   - every project's include still matches at least one file
 *
 * The config is imported, not parsed — the assertion is about the object
 * Vitest actually runs on, not about the text of the file.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import config, { BERLIN_TESTS, RUNS_IN_BERLIN } from '../../vitest.config'

const REPO_ROOT = resolve(__dirname, '..', '..')

/** Directories that never hold source tests (build output, deps, tooling). */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  'release',
  'templates',
  'resources'
])

function findTestFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      findTestFiles(join(dir, entry.name), acc)
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      acc.push(relative(REPO_ROOT, join(dir, entry.name)).split(sep).join('/'))
    }
  }
  return acc
}

/**
 * Minimal glob → RegExp for the shapes these Vitest configs actually use: a
 * double star plus slash (any depth), a single star (one path segment), and
 * `{ts,tsx}` alternation. Not a general glob implementation — the assertions
 * below pin exactly what it claims to handle.
 */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      out += '(?:[^/]+/)*'
      i += 2
    } else if (c === '*' && glob[i + 1] === '*') {
      out += '.*'
      i += 1
    } else if (c === '*') {
      out += '[^/]*'
    } else if (c === '{') {
      const end = glob.indexOf('}', i)
      out += `(?:${glob
        .slice(i + 1, end)
        .split(',')
        .map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})`
      i = end
    } else if ('.+?^$()[]|\\'.includes(c)) {
      out += `\\${c}`
    } else {
      out += c
    }
  }
  return new RegExp(`^${out}$`)
}

interface ProjectShape {
  test?: { name?: string; include?: string[] }
}

const projects = ((config as { test?: { projects?: ProjectShape[] } }).test?.projects ??
  []) as ProjectShape[]

const declared = projects.map((p) => ({
  name: p.test?.name ?? '(unnamed)',
  patterns: (p.test?.include ?? []).map((g) => ({ glob: g, re: globToRegExp(g) }))
}))
// Outside Europe/Berlin the `berlin` project is not registered (#263); its
// files run in the berlin-zone CI job. They count as covered here, and the
// pattern must still match something.
if (!RUNS_IN_BERLIN) {
  declared.push({
    name: 'berlin (registered only in Europe/Berlin)',
    patterns: [{ glob: BERLIN_TESTS, re: globToRegExp(BERLIN_TESTS) }]
  })
}

describe('vitest projects cover every test file', () => {
  const files = findTestFiles(REPO_ROOT)

  it('finds test files at all — a broken walker would make this vacuous', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('declares at least one project, each with includes', () => {
    expect(declared.length).toBeGreaterThan(0)
    for (const p of declared) {
      expect(p.patterns.length, `project "${p.name}" has no include patterns`).toBeGreaterThan(0)
    }
  })

  it('every test file is included by some project', () => {
    const orphans = files.filter((f) => !declared.some((p) => p.patterns.some((x) => x.re.test(f))))
    // A file listed here runs nowhere: green, zero skips, zero coverage.
    expect(orphans, `test files no Vitest project runs:\n  ${orphans.join('\n  ')}`).toEqual([])
  })

  it('every project still matches at least one file', () => {
    for (const p of declared) {
      const matched = files.filter((f) => p.patterns.some((x) => x.re.test(f)))
      expect(
        matched.length,
        `project "${p.name}" matches nothing — patterns: ${p.patterns.map((x) => x.glob).join(', ')}`
      ).toBeGreaterThan(0)
    }
  })
})

describe('globToRegExp', () => {
  it('handles the shapes used in the config', () => {
    expect(globToRegExp('src/main/**/*.test.ts').test('src/main/ipc.test.ts')).toBe(true)
    expect(globToRegExp('src/main/**/*.test.ts').test('src/main/migrations/x.test.ts')).toBe(true)
    expect(globToRegExp('src/main/**/*.test.ts').test('src/mcp/x.test.ts')).toBe(false)
    // Extension alternation.
    const rx = globToRegExp('src/renderer/**/*.test.{ts,tsx}')
    expect(rx.test('src/renderer/src/views/A.test.tsx')).toBe(true)
    expect(rx.test('src/renderer/src/views/A.test.ts')).toBe(true)
    expect(rx.test('src/renderer/src/views/A.test.js')).toBe(false)
    // `*` stays within one segment.
    expect(globToRegExp('a/*/b.test.ts').test('a/x/b.test.ts')).toBe(true)
    expect(globToRegExp('a/*/b.test.ts').test('a/x/y/b.test.ts')).toBe(false)
    // A dot is a literal, not "any character".
    expect(globToRegExp('src/a.test.ts').test('src/aXtest.ts')).toBe(false)
  })
})
