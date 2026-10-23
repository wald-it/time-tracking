/**
 * MCP list_entries month window = the local calendar month (#246).
 * Pinned to Europe/Berlin for the whole file, on purpose in a file of its own:
 * `delete process.env.TZ` does not reset Node's time zone, so a pin inside a
 * shared test file leaks into the tests after it. Vitest runs each test file
 * in its own process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { monthWindow } from './queries'

const previousTz = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'Europe/Berlin'
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

describe('monthWindow', () => {
  it('builds the LOCAL month window with December rollover', () => {
    // Off UTC on purpose: on a UTC runner a UTC window would pass as well.
    expect(monthWindow(2026, 12)).toEqual({
      start: '2026-11-30T23:00:00.000Z',
      end: '2026-12-31T23:00:00.000Z'
    })
  })
})
