import { describe, it, expect } from 'vitest'
import { compareNote, type CompareNoteInput } from './compareNote'
import { translate } from '../../../../shared/i18n'
import { de } from '../../../../shared/locales/de'
import { en } from '../../../../shared/locales/en'
import type { TFunction } from '../../contexts/I18nContext'

const DE_MONTHS = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember'
]
const EN_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

const tDe: TFunction = (key, vars) => translate(de, key, vars)
const tEn: TFunction = (key, vars) => translate(en, key, vars)

function note(over: Partial<CompareNoteInput>): string {
  return compareNote({
    comparison: 'samePeriod',
    prevPeriodDays: 22,
    year: 2026,
    month: 10,
    now: new Date(2026, 9, 22, 12, 0),
    locale: 'de',
    monthNames: DE_MONTHS,
    t: tDe,
    ...over
  })
}

describe('compareNote (HANDOFF §4.3, B2)', () => {
  it('current month: today and the same span of the previous month (mockup wording)', () => {
    expect(note({})).toBe(
      'Stand Do 22.10. · verglichen mit dem gleichen Zeitraum im Vormonat (1.–22. September)'
    )
  })

  it('past month: full month against full month', () => {
    expect(note({ comparison: 'fullMonth', month: 9 })).toBe('verglichen mit dem Vormonat')
  })

  it('January compares with December of the previous year', () => {
    expect(
      note({ year: 2027, month: 1, now: new Date(2027, 0, 14, 9, 0), prevPeriodDays: 14 })
    ).toBe('Stand Do 14.1. · verglichen mit dem gleichen Zeitraum im Vormonat (1.–14. Dezember)')
  })

  it('clamps the span to the length of February', () => {
    // 31 March 2026 → February 2026 has 28 days.
    expect(note({ month: 3, now: new Date(2026, 2, 31, 9, 0), prevPeriodDays: 31 })).toBe(
      'Stand Di 31.3. · verglichen mit dem gleichen Zeitraum im Vormonat (1.–28. Februar)'
    )
    // Leap year: February 2028 has 29 days.
    expect(
      note({ year: 2028, month: 3, now: new Date(2028, 2, 31, 9, 0), prevPeriodDays: 31 })
    ).toContain('(1.–29. Februar)')
  })

  it('takes the span from the data when it is shorter than the month', () => {
    expect(note({ month: 3, now: new Date(2026, 2, 5, 9, 0), prevPeriodDays: 5 })).toContain(
      '(1.–5. Februar)'
    )
  })

  it('English wording', () => {
    expect(note({ locale: 'en', monthNames: EN_MONTHS, t: tEn })).toBe(
      'As of Thu 22 Oct · compared with the same period last month (1–22 September)'
    )
    expect(note({ locale: 'en', monthNames: EN_MONTHS, t: tEn, comparison: 'fullMonth' })).toBe(
      'compared with last month'
    )
  })
})
