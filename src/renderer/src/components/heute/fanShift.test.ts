/**
 * Codex on #242: in the Messinstrument layout the quick start sits in the
 * right-hand column, and the project fan (radius 180 px around the key)
 * reached past the window edge at 1000–1200 px. fanShift() moves the whole
 * fan sideways just enough to keep every item inside the viewport.
 */
import { describe, it, expect } from 'vitest'
import { fanShift } from './fanShift'

const items = (xs: number[], w = 120): Array<{ x: number; width: number }> =>
  xs.map((x) => ({ x, width: w }))

describe('fanShift', () => {
  it('does nothing when the fan fits', () => {
    expect(fanShift(600, items([-180, 0, 180]), 1280)).toBe(0)
  })

  it('moves left when the rightmost item would cross the right edge', () => {
    // centre 1100: rightmost item ends at 1100 + 180 + 60 = 1340 > 1280 - 16
    expect(fanShift(1100, items([-180, 0, 180]), 1280)).toBe(1280 - 16 - 1340)
  })

  it('moves right when the leftmost item would cross the left edge', () => {
    // centre 150: leftmost item starts at 150 - 180 - 60 = -90 < 16
    expect(fanShift(150, items([-180, 0, 180]), 1280)).toBe(16 - -90)
  })

  it('prefers the left edge when the fan is wider than the window', () => {
    const s = fanShift(300, items([-180, 180], 400), 500)
    expect(300 - 180 - 200 + s).toBe(16)
  })
})
