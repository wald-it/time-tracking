/**
 * Timestamps an MCP client writes must say which moment they mean: a real
 * calendar date, a time of day and a zone (`Z` or `±HH:MM`). Owner decision
 * 2026-10-22: without a zone a value is ambiguous — the app has read it as
 * local time, MCP `list_entries` reads `from`/`to` as UTC — so it is refused
 * instead of guessed. Accepted values are returned in the stored form (UTC,
 * milliseconds, `Z`).
 *
 * Not `toStoredInstant` (mcp/queries): that one deliberately reads a value
 * without a zone as UTC, for the read-only range filter.
 */

export type ZonedTimestampResult =
  | { ok: true; iso: string }
  | { ok: false; reason: ZonedTimestampReason }

export type ZonedTimestampReason =
  | 'fehlt'
  | 'kein ISO-Zeitstempel'
  | 'Uhrzeit fehlt'
  | 'Zeitzone fehlt'
  | 'kein gültiges Datum'

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))?$/

export function parseZonedTimestamp(value: unknown): ZonedTimestampResult {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, reason: 'fehlt' }
  const upper = value.trim().toUpperCase()
  if (DATE_ONLY.test(upper)) return { ok: false, reason: 'Uhrzeit fehlt' }
  const m = DATE_TIME.exec(upper)
  if (!m) return { ok: false, reason: 'kein ISO-Zeitstempel' }
  const [, y, mo, d, h, mi, s, zone, oh, om] = m
  if (!zone) return { ok: false, reason: 'Zeitzone fehlt' }
  const month = Number(mo)
  const day = Number(d)
  const daysInMonth = new Date(Date.UTC(Number(y), month, 0)).getUTCDate()
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    Number(h) > 23 ||
    Number(mi) > 59 ||
    (s !== undefined && Number(s) > 59) ||
    (oh !== undefined && (Number(oh) > 14 || Number(om) > 59))
  ) {
    return { ok: false, reason: 'kein gültiges Datum' }
  }
  const ms = Date.parse(upper)
  if (Number.isNaN(ms)) return { ok: false, reason: 'kein ISO-Zeitstempel' }
  return { ok: true, iso: new Date(ms).toISOString() }
}

/**
 * An example in the machine's current offset, e.g. `2026-10-22T09:00:00+02:00`
 * — today at 09:00, so it reads like a value the caller would send.
 */
export function zonedTimestampExample(now: Date = new Date()): string {
  const at9 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0)
  const offsetMin = -at9.getTimezoneOffset()
  const sign = offsetMin < 0 ? '-' : '+'
  const abs = Math.abs(offsetMin)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const date = `${at9.getFullYear()}-${pad(at9.getMonth() + 1)}-${pad(at9.getDate())}`
  return `${date}T09:00:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** `started_at: Zeitzone fehlt, z. B. 2026-10-22T09:00:00+02:00 (erhalten: "…")` */
export function zonedTimestampError(
  field: string,
  value: unknown,
  reason: ZonedTimestampReason,
  now: Date = new Date()
): string {
  const got = typeof value === 'string' && value !== '' ? ` (erhalten: "${value}")` : ''
  return `${field}: ${reason}, z. B. ${zonedTimestampExample(now)}${got}`
}
