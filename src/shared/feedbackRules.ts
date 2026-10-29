export interface FeedbackRules {
  prefixes: string[]
  separator: string
  forbidden: string[]
}

export const DEFAULT_FEEDBACK_RULES: FeedbackRules = {
  prefixes: [],
  separator: ';',
  forbidden: []
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => {
      const key = item.toLowerCase()
      if (!item || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/** Read the optional JSON setting, tolerating malformed or older values. */
export function parseFeedbackRules(raw: string | undefined): FeedbackRules {
  let value: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(raw ?? '')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      value = parsed as Record<string, unknown>
  } catch {
    // A missing or malformed setting uses the defaults.
  }
  return {
    prefixes: strings(value.prefixes),
    separator:
      typeof value.separator === 'string'
        ? value.separator.trim()
        : DEFAULT_FEEDBACK_RULES.separator,
    forbidden: strings(value.forbidden)
  }
}
