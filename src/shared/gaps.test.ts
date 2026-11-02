// Pin the whole file, like dateRanges.local.test.ts: changing TZ inside a shared
// file can leak into later cases, since deleting TZ does not reset Node's zone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIN_GAP_MS, unexplainedGaps, unexplainedMs, type GapEntry } from './gaps'
import { DEFAULT_WORKING_HOURS, type WorkingHours } from './workingHours'

const previousTz = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'Europe/Berlin'
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

const date = (time: string, day = '2026-11-02'): Date => new Date(`${day}T${time}:00`)
const gap = (start: string, end: string, day?: string): { startMs: number; endMs: number } => ({
  startMs: date(start, day).getTime(),
  endMs: date(end, day).getTime()
})
const entry = (start: string, end: string | null, day?: string): GapEntry => ({
  started_at: date(start, day).toISOString(),
  stopped_at: end === null ? null : date(end, day).toISOString()
})
const gaps = (
  entries: GapEntry[],
  now = date('20:00'),
  hours: WorkingHours = DEFAULT_WORKING_HOURS
): ReturnType<typeof unexplainedGaps> => unexplainedGaps(entries, date('00:00'), now, hours)

describe('unexplained gaps', () => {
  it('leaves days without entries free, even on a workday', () => {
    expect(gaps([])).toEqual([])
    expect(gaps([entry('10:00', '11:00', '2026-11-03')])).toEqual([])
    expect(gaps([entry('06:00', '07:00')])).toEqual([gap('08:00', '18:00')])
  })

  it('requires a configured weekday as well as an entry', () => {
    const sunday = '2026-11-01'
    const entries = [entry('10:00', '11:00', sunday)]
    expect(
      unexplainedGaps(entries, date('00:00', sunday), date('20:00'), DEFAULT_WORKING_HOURS)
    ).toEqual([])
    expect(
      unexplainedGaps(entries, date('00:00', sunday), date('20:00'), {
        ...DEFAULT_WORKING_HOURS,
        days: [0]
      })
    ).toEqual([gap('08:00', '10:00', sunday), gap('11:00', '18:00', sunday)])
  })

  it('returns gaps before, between and after entries in start order', () => {
    expect(gaps([entry('14:00', '17:00'), entry('09:00', '12:00')])).toEqual([
      gap('08:00', '09:00'),
      gap('12:00', '14:00'),
      gap('17:00', '18:00')
    ])
    expect(gaps([entry('07:00', '19:00')])).toEqual([])
  })

  it('drops 4:59 and keeps exactly 5:00, including at the window edges', () => {
    expect(MIN_GAP_MS).toBe(300_000)
    for (const seconds of [299, 300]) {
      const entries = [
        {
          started_at: new Date(date('08:00').getTime() + seconds * 1000).toISOString(),
          stopped_at: date('12:00').toISOString()
        },
        {
          started_at: new Date(date('12:00').getTime() + seconds * 1000).toISOString(),
          stopped_at: new Date(date('18:00').getTime() - seconds * 1000).toISOString()
        }
      ]
      expect(gaps(entries)).toEqual(
        seconds === 299 ? [] : [gap('08:00', '08:05'), gap('12:00', '12:05'), gap('17:55', '18:00')]
      )
    }
  })

  it('covers running entries up to now, without inventing a trailing gap', () => {
    expect(gaps([entry('09:00', null)], date('12:00'))).toEqual([gap('08:00', '09:00')])
    expect(gaps([entry('07:00', null)], date('20:00'))).toEqual([])
    expect(gaps([entry('09:00', '10:00')], date('12:00'))).toEqual([
      gap('08:00', '09:00'),
      gap('10:00', '12:00')
    ])
    expect(gaps([entry('13:00', null)], date('12:00'))).toEqual([])
  })

  it('counts both parts of an entry across midnight and no part on a third day', () => {
    const entries = [
      {
        started_at: date('17:00').toISOString(),
        stopped_at: date('09:00', '2026-11-03').toISOString()
      }
    ]
    const now = date('20:00', '2026-11-04')
    expect(gaps(entries, now)).toEqual([gap('08:00', '17:00')])
    expect(
      unexplainedGaps(entries, date('00:00', '2026-11-03'), now, DEFAULT_WORKING_HOURS)
    ).toEqual([gap('09:00', '18:00', '2026-11-03')])
    expect(
      unexplainedGaps(entries, date('00:00', '2026-11-04'), now, DEFAULT_WORKING_HOURS)
    ).toEqual([])
    expect(
      gaps([
        {
          started_at: date('23:00', '2026-11-01').toISOString(),
          stopped_at: date('00:00').toISOString()
        }
      ])
    ).toEqual([])
    expect(gaps([entry('00:00', '01:00', '2026-11-03')])).toEqual([])
  })

  it('merges nested, overlapping and adjacent entries without changing input order', () => {
    const entries = [
      entry('13:00', '16:00'),
      entry('10:00', '11:00'),
      entry('09:00', '14:00'),
      entry('16:00', '17:00')
    ]
    const original = structuredClone(entries)
    expect(gaps(entries)).toEqual([gap('08:00', '09:00'), gap('17:00', '18:00')])
    expect(entries).toEqual(original)
    expect(gaps([entry('09:00', '12:00'), entry('13:00', '17:00')])).toEqual([
      gap('08:00', '09:00'),
      gap('12:00', '13:00'),
      gap('17:00', '18:00')
    ])
  })

  it('ignores deleted entries for both day eligibility and coverage', () => {
    const deleted = { ...entry('08:00', '18:00'), deleted_at: date('19:00').toISOString() }
    expect(gaps([deleted])).toEqual([])
    expect(gaps([deleted, entry('10:00', '11:00')])).toEqual([
      gap('08:00', '10:00'),
      gap('11:00', '18:00')
    ])
    expect(gaps([{ ...deleted, deleted_at: null }])).toEqual([])
  })

  it('covers billable work and non-billable Pause entries equally', () => {
    const entries = [
      { ...entry('08:00', '12:00'), billable: 1 },
      { ...entry('12:00', '13:00'), billable: 0, description: 'Pause' },
      { ...entry('13:00', '18:00'), billable: 1 }
    ]
    expect(gaps(entries)).toEqual([])
    expect(gaps(entries.filter((item) => item.billable === 1))).toEqual([gap('12:00', '13:00')])
  })

  it('clips the window to now and returns nothing before the window or on a future day', () => {
    const entries = [entry('09:00', '10:00')]
    expect(gaps(entries, date('12:00'))).toEqual([gap('08:00', '09:00'), gap('10:00', '12:00')])
    expect(gaps(entries, date('20:00'))).toEqual([gap('08:00', '09:00'), gap('10:00', '18:00')])
    expect(gaps(entries, date('07:00'))).toEqual([])
    expect(gaps(entries, date('08:00'))).toEqual([])
    expect(gaps(entries, date('20:00', '2026-11-01'))).toEqual([])
  })

  it.each([
    ['2026-03-29', '2026-03-29T06:00:00.000Z', '2026-03-29T16:00:00.000Z', 3],
    ['2026-10-25', '2026-10-25T07:00:00.000Z', '2026-10-25T17:00:00.000Z', 5]
  ] as const)('uses local boundaries on the DST day %s', (day, start, end, nightHours) => {
    const hours = { ...DEFAULT_WORKING_HOURS, days: [0] }
    const early = [entry('00:00', '00:30', day)]
    const now = date('23:59', day)
    expect(unexplainedGaps(early, date('00:00', day), now, hours)).toEqual([
      { startMs: Date.parse(start), endMs: Date.parse(end) }
    ])
    const nightGaps = unexplainedGaps(early, date('00:00', day), now, {
      ...hours,
      start: '01:00',
      end: '05:00'
    })
    expect(nightGaps).toEqual([gap('01:00', '05:00', day)])
    expect(unexplainedMs(nightGaps)).toBe(nightHours * 3600_000)
    expect(
      unexplainedGaps([entry('01:00', '05:00', day)], date('00:00', day), now, {
        ...hours,
        start: '01:00',
        end: '05:00'
      })
    ).toEqual([])
    // An entry ending at the next local midnight does not activate the following day.
    const nextDay = new Date(date('00:00', day))
    nextDay.setDate(nextDay.getDate() + 1)
    expect(
      unexplainedGaps(
        [{ started_at: date('23:30', day).toISOString(), stopped_at: nextDay.toISOString() }],
        nextDay,
        new Date(nextDay.getTime() + 20 * 3600_000),
        DEFAULT_WORKING_HOURS
      )
    ).toEqual([])
  })

  it('sums only the returned gaps', () => {
    expect(unexplainedMs([])).toBe(0)
    expect(unexplainedMs(gaps([entry('09:00', '17:00')]))).toBe(2 * 3600_000)
  })
})
