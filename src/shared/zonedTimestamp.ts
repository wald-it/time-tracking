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
import { translateLiteral, type Locale } from './i18n'
import { de } from './locales/de'
import { en } from './locales/en'

export type ZonedTimestampResult =
  | {
      ok: true
      iso: string
      /** The offset the caller wrote, in minutes east of UTC; null for `Z`. */
      offsetMin: number | null
    }
  | { ok: false; reason: ZonedTimestampReason }

export type ZonedTimestampReason =
  | 'fehlt'
  | 'kein ISO-Zeitstempel'
  | 'Uhrzeit fehlt'
  | 'Zeitzone fehlt'
  | 'kein gültiges Datum'

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const YEAR_MIN = 1970
const YEAR_MAX = 2099
/** How much of a refused value the error repeats. */
const ECHO_MAX = 60
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))?$/

export function parseZonedTimestamp(value: unknown): ZonedTimestampResult {
  if (value === undefined || value === null) return { ok: false, reason: 'fehlt' }
  if (typeof value !== 'string') return { ok: false, reason: 'kein ISO-Zeitstempel' }
  if (value.trim() === '') return { ok: false, reason: 'fehlt' }
  const upper = value.trim().toUpperCase()
  if (DATE_ONLY.test(upper)) return { ok: false, reason: 'Uhrzeit fehlt' }
  const m = DATE_TIME.exec(upper)
  if (!m) return { ok: false, reason: 'kein ISO-Zeitstempel' }
  const [, y, mo, d, h, mi, s, zone, oh, om] = m
  if (!zone) return { ok: false, reason: 'Zeitzone fehlt' }
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (
    // A plausible working life, not every year JS can represent: year 9999
    // with a negative offset turns into "+010000-…", which sorts before 2026.
    year < YEAR_MIN ||
    year > YEAR_MAX ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    Number(h) > 23 ||
    Number(mi) > 59 ||
    (s !== undefined && Number(s) > 59) ||
    (oh !== undefined && (Number(om) > 59 || Number(oh) * 60 + Number(om) > 14 * 60))
  ) {
    return { ok: false, reason: 'kein gültiges Datum' }
  }
  const ms = Date.parse(upper)
  if (Number.isNaN(ms)) return { ok: false, reason: 'kein ISO-Zeitstempel' }
  const offsetMin =
    zone === 'Z' ? null : (zone.startsWith('-') ? -1 : 1) * (Number(oh) * 60 + Number(om))
  return { ok: true, iso: new Date(ms).toISOString(), offsetMin }
}

/**
 * An example in the machine's current offset, e.g. `2026-10-22T09:00:00+02:00`
 * — today at 09:00, so it reads like a value the caller would send.
 */
export function zonedTimestampExample(now: Date = new Date()): string {
  const at9 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0)
  return toLocalIso(at9.toISOString())
}

/** `started_at: Zeitzone fehlt, z. B. 2026-10-22T09:00:00+02:00 (erhalten: "…")` */
export function zonedTimestampError(
  field: string,
  value: unknown,
  reason: ZonedTimestampReason,
  now: Date = new Date()
): string {
  const shown =
    typeof value === 'string' && value.length > ECHO_MAX ? `${value.slice(0, ECHO_MAX)}…` : value
  const got =
    value === undefined || value === null || value === ''
      ? ''
      : ` (erhalten: ${JSON.stringify(shown)})`
  return `${field}: ${reason}, z. B. ${zonedTimestampExample(now)}${got}`
}

// ── local time for the owner's confirmation and the client's reply ──────────
// The confirmation follows the app language (#270); the reply to the MCP
// client stays German, so its callers pass 'de'. English writes the date as
// ISO (`Tue 2026-10-27`): no reader has to guess between 10/27 and 27/10.

const pad = (n: number): string => String(n).padStart(2, '0')
const WEEKDAYS: Record<Locale, readonly string[]> = {
  de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
}
const LOCALES: Record<Locale, Record<string, string>> = { de, en }

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `+01:00` for 60, `-03:30` for -210. */
export function formatOffset(offsetMin: number): string {
  const abs = Math.abs(offsetMin)
  return `${offsetMin < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** The machine's offset at that instant, in minutes east of UTC. */
export function localOffsetAt(iso: string): number {
  return -new Date(iso).getTimezoneOffset()
}

/** `2026-10-27T09:00:00+01:00` — the instant in local time, with its offset. */
export function toLocalIso(iso: string): string {
  const d = new Date(iso)
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return `${date}T${time}${formatOffset(localOffsetAt(iso))}`
}

function localDay(d: Date, locale: Locale): string {
  const date =
    locale === 'en' ? isoDay(d) : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
  return `${WEEKDAYS[locale][d.getDay()]} ${date}`
}

function localTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Whether the clocks change on the local day of `d` (offset at its start ≠ at its end). */
function isClockChangeDay(d: Date): boolean {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  return start.getTimezoneOffset() !== next.getTimezoneOffset()
}

/**
 * The time of day for the confirmation. On a day the clocks change it carries
 * its offset: in the repeated hour `02:15` exists twice, and an edit from
 * `02:15 (+02:00)` to `02:15 (+01:00)` changes the duration by an hour —
 * without the offset the dialog would show the same text on both sides
 * (Codex, round 2).
 */
function clock(d: Date): string {
  return isClockChangeDay(d)
    ? `${localTime(d)} (${formatOffset(-d.getTimezoneOffset())})`
    : localTime(d)
}

/** `09:00`; `02:15 (+02:00)` on a clock-change day. */
export function formatLocalClock(iso: string): string {
  return clock(new Date(iso))
}

/** `Di 27.10.2026 09:00`; `So 26.10.2025 02:15 (+02:00)` on a clock-change day. */
export function formatLocalMoment(iso: string, locale: Locale): string {
  const d = new Date(iso)
  return `${localDay(d, locale)} ${clock(d)}`
}

/** `Di 27.10.2026 09:00–12:00`, or both days when the span crosses midnight. */
export function formatLocalSpan(startIso: string, stopIso: string, locale: Locale): string {
  const a = new Date(startIso)
  const b = new Date(stopIso)
  return localDay(a, locale) === localDay(b, locale)
    ? `${localDay(a, locale)} ${clock(a)}–${clock(b)}`
    : `${formatLocalMoment(startIso, locale)} – ${formatLocalMoment(stopIso, locale)}`
}

/**
 * A note when the caller wrote an explicit offset that is not the machine's
 * offset at that moment — typically the summer-time example copied for a day
 * after the clocks went back. Not a refusal: the instant is unambiguous, it
 * just may not be the wall-clock time the caller meant. `Z` gets no note.
 *
 * `Hinweis: +02:00 weicht von der Ortszeit am 27.10. ab (+01:00) — wird als
 * 08:00 Ortszeit gespeichert.`
 */
export function offsetHint(iso: string, offsetMin: number | null, locale: Locale): string | null {
  if (offsetMin === null) return null
  const local = localOffsetAt(iso)
  if (local === offsetMin) return null
  const d = new Date(iso)
  return translateLiteral(LOCALES[locale], 'mainDialog.mcp.offsetHint', {
    offset: formatOffset(offsetMin),
    day: locale === 'en' ? isoDay(d) : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`,
    local: formatOffset(local),
    time: localTime(d)
  })
}

/** For the tool descriptions: the zone the machine runs in, e.g. `Europe/Berlin`. */
export function localTimeZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'lokale Zeitzone'
}
