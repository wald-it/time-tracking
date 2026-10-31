import { describe, expect, it } from 'vitest'
import {
  parseWeeklyTargetHours,
  parseTargetRateCent,
  targetRateFromSetting,
  weekdaysInMonth,
  monthlyTargetHours,
  utilisation,
  monthProjection,
  workedHourlyRateCent
} from './targets'

describe('target input', () => {
  it.each([
    ['16', 16],
    ['16,5', 16.5],
    ['16.5', 16.5],
    [' 16,5 ', 16.5],
    ['168', 168],
    ['', null],
    ['abc', null],
    ['0', null],
    ['-1', null],
    ['168.01', null],
    ['Infinity', null],
    ['1e2', null],
    ['16 hours', null],
    ['1,2.3', null],
    [undefined, null]
  ])('weekly hours %s → %s', (input, expected) => {
    expect(parseWeeklyTargetHours(input)).toBe(expected)
  })

  it.each([
    ['95,50', 9550],
    ['95.50', 9550],
    ['95', 9500],
    [' 95,50 ', 9550],
    ['1.005', 101],
    ['95.505', 9551],
    ['95.504', 9550],
    ['0.005', 1],
    ['', null],
    ['abc', null],
    ['0', null],
    ['-1', null],
    ['0.004', null],
    ['Infinity', null],
    ['1.2.3', null],
    ['1e2', null],
    [undefined, null],
    ['9007199254740991', null]
  ])('euro rate %s → %s cents (half-up)', (input, expected) => {
    expect(parseTargetRateCent(input)).toBe(expected)
  })

  it('reads the saved rate as integer cents, not euros', () => {
    expect(targetRateFromSetting('9550')).toBe(9550)
    for (const raw of ['', undefined, 'abc', '0', '-1', '95.5', 'Infinity']) {
      expect(targetRateFromSetting(raw)).toBeNull()
    }
  })
})

describe('target calculations (decimal hours and integer cents)', () => {
  it.each([
    [2026, 8, 21],
    [2027, 2, 20],
    [2027, 3, 23]
  ])('%i-%i has %i Mon–Fri days', (year, month, weekdays) => {
    expect(weekdaysInMonth(year, month)).toBe(weekdays)
  })

  it('16 h/week over 21 weekdays is 67.2 h/month', () => {
    expect(monthlyTargetHours(16, 2026, 8)).toBeCloseTo(67.2)
  })

  it('uses weekdays even for a 31-day month starting on Monday', () => {
    expect(monthlyTargetHours(16, 2027, 3)).toBeCloseTo(73.6)
  })

  it('utilisation divides all worked hours by the monthly target', () => {
    expect(utilisation(33.6, 67.2)).toBe(0.5)
    expect(utilisation(84, 67.2)).toBe(1.25)
    expect(utilisation(0, 67.2)).toBe(0)
    expect(utilisation(10, 0)).toBeNull()
  })

  it('projects hours and revenue by elapsed calendar days including today', () => {
    expect(monthProjection(33.6, 16, 31)).toBeCloseTo(65.1)
    expect(monthProjection(292320, 16, 31)).toBe(566370)
    expect(monthProjection(2, 1, 31)).toBe(62)
    expect(monthProjection(9500, 1, 28)).toBe(266000)
    expect(monthProjection(67.2, 31, 31)).toBeCloseTo(67.2)
    expect(monthProjection(292320, 31, 31)).toBe(292320)
    expect(monthProjection(0, 1, 31)).toBe(0)
  })

  it('includes non-billable hours in the achieved hourly rate', () => {
    // 10 billable hours at €100 + 10 non-billable hours → €50/h overall.
    expect(workedHourlyRateCent(100000, 20)).toBe(5000)
    expect(workedHourlyRateCent(0, 20)).toBe(0)
    expect(workedHourlyRateCent(100000, 0)).toBeNull()
    expect(workedHourlyRateCent(0, 0)).toBeNull()
  })
})
