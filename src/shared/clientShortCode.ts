/**
 * The client short code in the timesheet run number `SN-YYYY-MM-<code>-<nn>`
 * (design OQ9). Migration 032 enforces the same rule as a CHECK; this copy
 * lets the main process and the form refuse a bad code with a message instead
 * of a SQLite error.
 */
export const SHORT_CODE_PATTERN = /^[A-Z0-9]{1,8}$/

export const SHORT_CODE_MAX_LENGTH = 8

/** Main-process error texts; the form matches them exactly to pick its own wording. */
export const SHORT_CODE_INVALID_ERROR = 'Kurzcode muss 1 bis 8 Zeichen aus A–Z und 0–9 enthalten.'
export const SHORT_CODE_TAKEN_ERROR = 'Kurzcode ist bereits einem anderen Kunden zugeordnet.'

/** Trimmed and upper-cased; empty means no code (null). */
export function normaliseShortCodeInput(value: string): string | null {
  const code = value.trim().toUpperCase()
  return code === '' ? null : code
}
