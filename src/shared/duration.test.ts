import { describe, it, expect } from 'vitest'
import { formatDuration } from './duration'

describe('formatDuration', () => {
  it('formats zero as 00:00:00', () => {
    expect(formatDuration(0)).toBe('00:00:00')
  })

  it('formats sub-minute values', () => {
    expect(formatDuration(7)).toBe('00:00:07')
    expect(formatDuration(59)).toBe('00:00:59')
  })

  it('formats sub-hour values', () => {
    expect(formatDuration(60)).toBe('00:01:00')
    expect(formatDuration(125)).toBe('00:02:05')
  })

  it('formats multi-hour values', () => {
    expect(formatDuration(3661)).toBe('01:01:01')
    expect(formatDuration(36000)).toBe('10:00:00')
  })

  it('truncates fractional seconds', () => {
    expect(formatDuration(59.9)).toBe('00:00:59')
  })

  it('clamps negative values to 00:00:00', () => {
    expect(formatDuration(-1)).toBe('00:00:00')
    expect(formatDuration(-3600)).toBe('00:00:00')
  })

  it('clamps non-finite values to 00:00:00', () => {
    expect(formatDuration(NaN)).toBe('00:00:00')
    expect(formatDuration(Infinity)).toBe('00:00:00')
  })
})
