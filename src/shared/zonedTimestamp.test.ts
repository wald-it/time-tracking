import { afterEach, describe, expect, it } from 'vitest'
import { parseZonedTimestamp, zonedTimestampError, zonedTimestampExample } from './zonedTimestamp'

const previousTz = process.env.TZ
afterEach(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

describe('parseZonedTimestamp', () => {
  it('accepts an offset and returns the stored UTC form', () => {
    expect(parseZonedTimestamp('2026-10-01T00:30:00+02:00')).toEqual({
      ok: true,
      iso: '2026-09-30T22:30:00.000Z'
    })
  })

  it('accepts Z, with or without seconds and fractions, and lower case', () => {
    expect(parseZonedTimestamp('2026-10-01T08:00Z')).toEqual({
      ok: true,
      iso: '2026-10-01T08:00:00.000Z'
    })
    expect(parseZonedTimestamp('2026-10-01t08:00:00.5z')).toEqual({
      ok: true,
      iso: '2026-10-01T08:00:00.500Z'
    })
    expect(parseZonedTimestamp('2026-10-01T08:00:00-05:00')).toEqual({
      ok: true,
      iso: '2026-10-01T13:00:00.000Z'
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
    expect(reason(42)).toBe('fehlt')
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
})
