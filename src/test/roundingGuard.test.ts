/**
 * Guard (2.0 design, test 12): billing minutes are rounded in one place,
 * `src/shared/currency.ts`, and its SQL twin. Any other rounding-up code in
 * the source tree must be on the allowlist below with its reason, so a new
 * `Math.ceil` for billing cannot slip in unnoticed. An allowlist entry that no
 * longer matches fails too, so the list cannot rot.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = join(__dirname, '..')
const PATTERN = /Math\.ceil|roundDuration|snapToStep|\bCEIL\(/

const ALLOWED: Record<string, string> = {
  'shared/currency.ts': 'the rule itself (JS side)',
  'shared/duration.ts':
    'legacy display rounding (roundDuration), used only by Heute and the Stream Deck display seconds',
  'main/mcpBridgeCore.ts': 'legacy *_display_seconds for the Stream Deck',
  'main/dashboardTotals.ts': 'comment naming roundDuration as legacy',
  'main/pdf.ts': 'snapToStepLocal: grid alignment of the displayed start time, set by the profile',
  'main/analyticsHandlers.ts': 'ISO week number, not billing',
  'renderer/src/components/auswertung/ClientHours.tsx': 'chart axis maximum, not billing',
  'renderer/src/components/heute/EntryTable.tsx':
    'Heute display rounding, to be moved onto the rule (P4 renderer part)',
  'renderer/src/components/heute/SummaryColumn.tsx':
    'Heute display rounding, to be moved onto the rule (P4 renderer part)',
  'renderer/src/components/heute/TimerDisplay.tsx':
    'Heute display rounding, to be moved onto the rule (P4 renderer part)'
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

describe('rounding guard', () => {
  const hits = sourceFiles(ROOT)
    .filter((f) => PATTERN.test(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f).split(sep).join('/'))
    .filter((f) => !/\/(?:\w+Layout|\w+Scale|clientShares|compareNote)\.ts$/.test(f))

  it('finds rounding-up code only in allowlisted files', () => {
    const unexpected = hits.filter((f) => !(f in ALLOWED))
    expect(
      unexpected,
      'rounding outside currency.ts, add it there or allowlist it with a reason'
    ).toEqual([])
  })

  it('has no stale allowlist entries', () => {
    const stale = Object.keys(ALLOWED).filter((f) => !hits.includes(f))
    expect(stale).toEqual([])
  })
})
