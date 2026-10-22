import { afterEach, describe, expect, it } from 'vitest'
import {
  formatLocalMoment,
  formatLocalSpan,
  formatOffset,
  offsetHint,
  parseZonedTimestamp,
  toLocalIso,
  zonedTimestampError,
  zonedTimestampExample
} from './zonedTimestamp'

const previousTz = process.env.TZ
afterEach(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

describe('parseZonedTimestamp', () => {
  it('accepts an offset and returns the stored UTC form', () => {
    expect(parseZonedTimestamp('2026-10-01T00:30:00+02:00')).toEqual({
      ok: true,
      iso: '2026-09-30T22:30:00.000Z',
      offsetMin: 120
    })
  })

  it('accepts Z, with or without seconds and fractions, and lower case', () => {
    expect(parseZonedTimestamp('2026-10-01T08:00Z')).toEqual({
      ok: true,
      iso: '2026-10-01T08:00:00.000Z',
      offsetMin: null
    })
    expect(parseZonedTimestamp('2026-10-01t08:00:00.5z')).toEqual({
      ok: true,
      iso: '2026-10-01T08:00:00.500Z',
      offsetMin: null
    })
    expect(parseZonedTimestamp('2026-10-01T08:00:00-05:00')).toEqual({
      ok: true,
      iso: '2026-10-01T13:00:00.000Z',
      offsetMin: -300
    })
  })

  it('names why a value is refused', () => {
    const reason = (v: unknown): string | null => {
      const r = parseZonedTimestamp(v)
      return r.ok ? null : r.reason
    }
    expect(reason('2026-10-01T08:00:00')).toBe('Zeitzone fehlt')
    expect(reason('2026-10-01')).toBe('Uhrzeit fehlt')
    expect(reason('2026-02-30T08:00:00Z')).toBe('kein gültiges Datum')
    expect(reason('2026-13-01T08:00:00Z')).toBe('kein gültiges Datum')
    expect(reason('2026-10-01T24:00:00Z')).toBe('kein gültiges Datum')
    expect(reason('2026-10-01T08:00:00+15:00')).toBe('kein gültiges Datum')
    expect(reason('2026-10-01 08:00:00Z')).toBe('kein ISO-Zeitstempel')
    expect(reason('gestern')).toBe('kein ISO-Zeitstempel')
    expect(reason('')).toBe('fehlt')
    expect(reason(undefined)).toBe('fehlt')
    expect(reason(null)).toBe('fehlt')
    // sent, but not a string
    expect(reason(42)).toBe('kein ISO-Zeitstempel')
  })

  it('keeps to plausible years and real offsets', () => {
    const ok = (v: string): boolean => parseZonedTimestamp(v).ok
    // year 9999 at -14:00 would become "+010000-…", sorting before 2026
    expect(ok('9999-12-31T23:59:59-14:00')).toBe(false)
    expect(ok('1969-12-31T12:00:00Z')).toBe(false)
    expect(ok('2100-01-01T12:00:00Z')).toBe(false)
    expect(ok('1970-01-01T12:00:00Z')).toBe(true)
    expect(ok('2099-12-31T12:00:00Z')).toBe(true)
    expect(ok('2026-10-01T08:00:00+14:00')).toBe(true)
    expect(ok('2026-10-01T08:00:00+14:01')).toBe(false)
    expect(ok('2026-10-01T08:00:00+05:45')).toBe(true)
    expect(ok('2028-02-29T08:00:00Z')).toBe(true)
  })
})

describe('zonedTimestampExample', () => {
  it('uses the offset of the machine on that day (summer and winter time)', () => {
    process.env.TZ = 'Europe/Berlin'
    expect(zonedTimestampExample(new Date(2026, 9, 22, 15))).toBe('2026-10-22T09:00:00+02:00')
    expect(zonedTimestampExample(new Date(2026, 11, 1, 15))).toBe('2026-12-01T09:00:00+01:00')
  })

  it('writes negative offsets with a minus', () => {
    process.env.TZ = 'America/New_York'
    expect(zonedTimestampExample(new Date(2026, 9, 22, 15))).toBe('2026-10-22T09:00:00-04:00')
  })
})

describe('zonedTimestampError', () => {
  it('names the field, the reason, an example and what came in', () => {
    process.env.TZ = 'Europe/Berlin'
    expect(
      zonedTimestampError(
        'started_at',
        '2026-10-22T09:00:00',
        'Zeitzone fehlt',
        new Date(2026, 9, 22, 15)
      )
    ).toBe(
      'started_at: Zeitzone fehlt, z. B. 2026-10-22T09:00:00+02:00 (erhalten: "2026-10-22T09:00:00")'
    )
  })

  it('repeats a long or quoted input shortened and escaped', () => {
    const msg = zonedTimestampError('started_at', `"${'x'.repeat(200)}`, 'kein ISO-Zeitstempel')
    expect(msg).toContain(`(erhalten: "\\"${'x'.repeat(59)}…")`)
    expect(msg.length).toBeLessThan(160)
  })
})

describe('local time for confirmation and preview (Europe/Berlin)', () => {
  const zone = (): void => {
    process.env.TZ = 'Europe/Berlin'
  }

  it('formats offsets, including half hours and negatives', () => {
    expect(formatOffset(60)).toBe('+01:00')
    expect(formatOffset(-210)).toBe('-03:30')
    expect(formatOffset(0)).toBe('+00:00')
  })

  it('writes an instant in local time with the offset of that day', () => {
    zone()
    expect(toLocalIso('2026-10-27T08:00:00.000Z')).toBe('2026-10-27T09:00:00+01:00')
    expect(toLocalIso('2026-10-20T07:00:00.000Z')).toBe('2026-10-20T09:00:00+02:00')
  })

  it('names weekday, date and times; a span past midnight names both days', () => {
    zone()
    expect(formatLocalMoment('2026-10-27T08:00:00.000Z')).toBe('Di 27.10.2026 09:00')
    expect(formatLocalSpan('2026-10-27T08:00:00.000Z', '2026-10-27T11:00:00.000Z')).toBe(
      'Di 27.10.2026 09:00–12:00'
    )
    expect(formatLocalSpan('2026-10-27T22:00:00.000Z', '2026-10-28T00:30:00.000Z')).toBe(
      'Di 27.10.2026 23:00 – Mi 28.10.2026 01:30'
    )
  })

  it('on a clock-change day every time carries its offset (the hour that exists twice)', () => {
    zone()
    // 02:15 summer time → 03:15 winter time: two hours
    expect(formatLocalSpan('2025-10-26T00:15:00.000Z', '2025-10-26T02:15:00.000Z')).toBe(
      'So 26.10.2025 02:15 (+02:00)–03:15 (+01:00)'
    )
    // 02:15 winter time → 03:15 winter time: one hour, now told apart
    expect(formatLocalSpan('2025-10-26T01:15:00.000Z', '2025-10-26T02:15:00.000Z')).toBe(
      'So 26.10.2025 02:15 (+01:00)–03:15 (+01:00)'
    )
    expect(formatLocalMoment('2025-03-30T01:30:00.000Z')).toBe('So 30.03.2025 03:30 (+02:00)')
    // the day after: no offsets
    expect(formatLocalMoment('2025-10-27T08:00:00.000Z')).toBe('Mo 27.10.2025 09:00')
  })

  it('notes a written offset that is not the local one on that day', () => {
    zone()
    const p = parseZonedTimestamp('2026-10-27T09:00:00+02:00')
    if (!p.ok) throw new Error('should parse')
    expect(offsetHint(p.iso, p.offsetMin)).toBe(
      'Hinweis: +02:00 weicht von der Ortszeit am 27.10. ab (+01:00) — wird als 08:00 Ortszeit gespeichert.'
    )
  })

  it('has no note for the matching offset or for Z', () => {
    zone()
    for (const v of ['2026-10-27T09:00:00+01:00', '2026-10-27T09:00:00Z']) {
      const p = parseZonedTimestamp(v)
      if (!p.ok) throw new Error('should parse')
      expect(offsetHint(p.iso, p.offsetMin), v).toBeNull()
    }
  })
})
