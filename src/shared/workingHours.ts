export interface WorkingHours {
  start: string
  end: string
  /** Sorted, unique JS weekdays (Sunday = 0). */
  days: number[]
}

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  start: '08:00',
  end: '18:00',
  days: [1, 2, 3, 4, 5]
}

const time = (value: unknown): value is string =>
  typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)

const days = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)

/** The editor writes only canonical settings; malformed runtime values are rejected too. */
export function isValidWorkingHours(value: unknown): value is WorkingHours {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<WorkingHours>
  return (
    time(candidate.start) &&
    time(candidate.end) &&
    candidate.start < candidate.end &&
    days(candidate.days) &&
    candidate.days.every((day, index, all) => index === 0 || day > all[index - 1])
  )
}

/** Invalid fields fall back independently; an inverted/equal window falls back as a pair. */
export function parseWorkingHours(raw: string | undefined): WorkingHours {
  let value: Partial<WorkingHours> = {}
  try {
    const parsed: unknown = JSON.parse(raw ?? '')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed
  } catch {
    // Missing or malformed settings use the defaults.
  }
  const result = { ...DEFAULT_WORKING_HOURS, days: [...DEFAULT_WORKING_HOURS.days] }
  const start = time(value.start) ? value.start : result.start
  const end = time(value.end) ? value.end : result.end
  if (start < end) {
    result.start = start
    result.end = end
  }
  // Normalize order and duplicates, but never silently discard invalid weekday values.
  if (days(value.days)) result.days = [...new Set(value.days)].sort((a, b) => a - b)
  return result
}
