/**
 * One week number for one week (owner pre-review, PR 2): the calendar labels
 * a row with the ISO week of its first day, and Heute must show the same
 * number. With week_start = sunday, the row Sun 18 Oct – Sat 24 Oct 2026
 * starts in ISO week 42 although Mon–Sat lie in ISO week 43.
 */
import { describe, it, expect } from 'vitest'
import { weekNumberOf } from './useWeekStart'

const day = (d: number): Date => new Date(2026, 9, d, 12, 0, 0)

describe('weekNumberOf', () => {
  it('monday weeks: the ISO week', () => {
    expect(weekNumberOf(day(19), 'monday')).toBe(43) // Mon
    expect(weekNumberOf(day(25), 'monday')).toBe(43) // Sun
  })

  it('sunday weeks: the ISO week of the Sunday the row starts with', () => {
    expect(weekNumberOf(day(18), 'sunday')).toBe(42) // Sun
    expect(weekNumberOf(day(22), 'sunday')).toBe(42) // Thu, same row
    expect(weekNumberOf(day(25), 'sunday')).toBe(43) // next Sun, next row
  })
})
