import { translate, type Locale } from './i18n'
import { de } from './locales/de'
import { en } from './locales/en'

export interface RuleCheckSettings {
  entryMaxHours: number
  dayMaxHours: number
  windowStart: string
  windowEnd: string
  weekend: boolean
  maxDescriptionLength: number
}

export const DEFAULT_RULE_CHECK: RuleCheckSettings = {
  entryMaxHours: 10,
  dayMaxHours: 10,
  windowStart: '06:00',
  windowEnd: '22:00',
  weekend: true,
  maxDescriptionLength: 300
}

const time = (value: unknown): value is string =>
  typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

/** Shared by the tolerant reader and the settings editor's strict validation. */
export function isValidRuleCheck(value: RuleCheckSettings): boolean {
  return (
    positive(value.entryMaxHours) &&
    positive(value.dayMaxHours) &&
    time(value.windowStart) &&
    time(value.windowEnd) &&
    value.windowStart < value.windowEnd &&
    typeof value.weekend === 'boolean' &&
    positive(value.maxDescriptionLength) &&
    Number.isSafeInteger(value.maxDescriptionLength)
  )
}

export function parseRuleCheck(raw: string | undefined): RuleCheckSettings {
  let value: Partial<RuleCheckSettings> = {}
  try {
    const parsed: unknown = JSON.parse(raw ?? '')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed
  } catch {
    // Missing or malformed settings use the defaults.
  }
  const result = { ...DEFAULT_RULE_CHECK }
  for (const key of ['entryMaxHours', 'dayMaxHours', 'maxDescriptionLength'] as const) {
    const candidate = { ...result, [key]: value[key] }
    if (isValidRuleCheck(candidate)) result[key] = candidate[key]
  }
  const windowStart = value.windowStart ?? result.windowStart
  const windowEnd = value.windowEnd ?? result.windowEnd
  if (time(windowStart) && time(windowEnd) && windowStart < windowEnd) {
    result.windowStart = windowStart
    result.windowEnd = windowEnd
  }
  if (typeof value.weekend === 'boolean') result.weekend = value.weekend
  return result
}

export const RULE_CHECK_IDS = [
  'missing_description',
  'missing_project',
  'billable_without_rate',
  'entry_over_threshold',
  'day_over_threshold',
  'outside_window',
  'weekend',
  'format_prefix',
  'format_separator',
  'format_forbidden',
  'format_name',
  'too_long',
  'not_billable'
] as const
export type RuleCheckId = (typeof RULE_CHECK_IDS)[number]

export interface RuleCheckFinding {
  entryId: number
  rule: RuleCheckId
  params: Record<string, string | number>
}

/** One renderer for the export tab and MCP, with single-pass interpolation. */
export function formatRuleCheckFinding(finding: RuleCheckFinding, locale: Locale): string {
  return translate(locale === 'en' ? en : de, `ruleCheck.${finding.rule}`, finding.params)
}
