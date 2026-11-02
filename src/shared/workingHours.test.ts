import { describe, expect, it } from 'vitest'
import { DEFAULT_WORKING_HOURS, isValidWorkingHours, parseWorkingHours } from './workingHours'

describe('working hours', () => {
  it.each([undefined, '', '{', 'null', '[]', '42', '"hours"', '{}'])(
    'uses defaults for absent or malformed settings: %s',
    (raw) => {
      expect(parseWorkingHours(raw)).toEqual({
        start: '08:00',
        end: '18:00',
        days: [1, 2, 3, 4, 5]
      })
    }
  )

  it.each([
    ['start', '8:00'],
    ['start', '24:00'],
    ['start', null],
    ['end', '19:60'],
    ['end', 1800],
    ['end', '18:00:00'],
    ['days', []],
    ['days', [-1, 1]],
    ['days', [1, 7]],
    ['days', [1.5]],
    ['days', ['1']],
    ['days', null]
  ])('falls back only for invalid %s = %j', (key, value) => {
    const valid = { start: '09:00', end: '17:00', days: [0, 6] }
    expect(parseWorkingHours(JSON.stringify({ ...valid, [key]: value }))).toEqual({
      ...valid,
      [key]: DEFAULT_WORKING_HOURS[key as keyof typeof DEFAULT_WORKING_HOURS]
    })
    expect(isValidWorkingHours({ ...valid, [key]: value })).toBe(false)
  })

  it.each([{ start: '09:00' }, { end: '17:00' }, { days: [0, 6] }])(
    'retains each valid field when other fields are absent: %j',
    (fields) => {
      expect(parseWorkingHours(JSON.stringify(fields))).toEqual({
        ...DEFAULT_WORKING_HOURS,
        ...fields
      })
    }
  )

  it.each([
    ['18:00', '18:00'],
    ['19:00', '09:00']
  ])('rejects %s–%s and resets the window while keeping days', (start, end) => {
    const hours = { start, end, days: [0] }
    expect(isValidWorkingHours(hours)).toBe(false)
    expect(parseWorkingHours(JSON.stringify(hours))).toEqual({
      ...DEFAULT_WORKING_HOURS,
      days: [0]
    })
  })

  it('normalizes unordered/duplicate days on read, but rejects them in strict validation', () => {
    const hours = { start: '00:00', end: '23:59', days: [6, 0, 6, 1] }
    expect(isValidWorkingHours(hours)).toBe(false)
    expect(parseWorkingHours(JSON.stringify(hours))).toEqual({ ...hours, days: [0, 1, 6] })
    expect(isValidWorkingHours({ ...hours, days: [0, 1, 6] })).toBe(true)
    expect(isValidWorkingHours({ ...hours, days: [1, 1] })).toBe(false)
  })

  it.each([null, undefined, [], 'hours', {}])(
    'strictly rejects non-settings values: %j',
    (value) => {
      expect(isValidWorkingHours(value)).toBe(false)
    }
  )

  it('returns independent defaults, including the days array', () => {
    const hours = parseWorkingHours(undefined)
    hours.days.push(0)
    hours.start = '00:00'
    expect(parseWorkingHours(undefined)).toEqual(DEFAULT_WORKING_HOURS)
    expect(isValidWorkingHours(DEFAULT_WORKING_HOURS)).toBe(true)
  })
})
