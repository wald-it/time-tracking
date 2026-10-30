import type Database from 'better-sqlite3'
import type { FeedbackRules } from '../shared/feedbackRules'

export type FeedbackFinding = {
  kind: 'prefix' | 'separator' | 'forbidden' | 'name'
  detail: string
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}

function containsPhrase(text: string, phrase: string): boolean {
  const normalized = normalizeWhitespace(phrase)
  if (!normalized) return false
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text)
}

/** Check one description without reading settings or changing an entry. */
export function checkFeedbackText(
  text: string,
  rules: FeedbackRules,
  masterNames: readonly string[]
): FeedbackFinding[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const findings: FeedbackFinding[] = []
  if (rules.prefixes.length && !rules.prefixes.some((prefix) => trimmed.startsWith(`${prefix}:`))) {
    findings.push({ kind: 'prefix', detail: rules.prefixes.join(', ') })
  }
  if (rules.separator) {
    const activities = trimmed.slice(trimmed.indexOf(':') + 1)
    activities.split(rules.separator).forEach((segment, index) => {
      // Segment positions are one-based for display in the review bench.
      if (!segment.trim()) findings.push({ kind: 'separator', detail: String(index + 1) })
    })
  }
  const normalizedText = normalizeWhitespace(trimmed)
  for (const word of rules.forbidden) {
    if (containsPhrase(normalizedText, word)) findings.push({ kind: 'forbidden', detail: word })
  }
  const seen = new Set(rules.forbidden.map((word) => normalizeWhitespace(word).toLowerCase()))
  for (const name of masterNames) {
    const normalized = normalizeWhitespace(name)
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (containsPhrase(normalizedText, normalized))
      findings.push({ kind: 'name', detail: normalized })
  }
  return findings
}

/** Contact persons remain relevant even when their client or project is archived. */
export function readMasterNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `
    SELECT contact_person FROM clients
    UNION ALL
    SELECT contact_person FROM projects
  `
    )
    .all() as { contact_person: string | null }[]
  const names = new Map<string, string>()
  for (const row of rows) {
    const name = row.contact_person?.trim()
    if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name)
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b))
}
