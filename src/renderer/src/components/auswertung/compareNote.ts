import type { Locale } from '../../../../shared/i18n'
import type { TFunction } from '../../contexts/I18nContext'

/**
 * The comparison note in the Auswertung header (HANDOFF §4.3, B2).
 *
 * - `samePeriod` (the current month): "Stand Do 22.10. · verglichen mit dem
 *   gleichen Zeitraum im Vormonat (1.–22. September)". `{date}` is today,
 *   `{range}` is day 1…`prevPeriodDays` of the month before the selected one.
 * - `fullMonth` (a past month): "verglichen mit dem Vormonat".
 *
 * `prevPeriodDays` comes from the analytics handler, which already clamps it
 * to the previous month's length. The note clamps once more, so a February
 * can never read "1.–31. Februar".
 */
export interface CompareNoteInput {
  comparison: 'samePeriod' | 'fullMonth'
  /** Last day of the previous month the comparison covers. */
  prevPeriodDays: number
  /** Selected year. */
  year: number
  /** Selected month, 1-based. */
  month: number
  /** "Now" — the date shown after "Stand". */
  now: Date
  locale: Locale
  /** The 12 month names in the UI locale, January first. */
  monthNames: readonly string[]
  t: TFunction
}

export function compareNote(input: CompareNoteInput): string {
  const { comparison, t } = input
  if (comparison === 'fullMonth') return t('analytics.compare.fullMonth')

  const prevYear = input.month === 1 ? input.year - 1 : input.year
  const prevMonth = input.month === 1 ? 12 : input.month - 1 // 1-based
  // Day 0 of the following month = last day of prevMonth.
  const prevLength = new Date(prevYear, prevMonth, 0).getDate()
  const lastDay = Math.max(1, Math.min(Math.floor(input.prevPeriodDays), prevLength))
  const prevName = input.monthNames[prevMonth - 1] ?? ''

  return t('analytics.compare.samePeriod', {
    date: formatToday(input.now, input.locale),
    range: input.locale === 'en' ? `1–${lastDay} ${prevName}` : `1.–${lastDay}. ${prevName}`
  })
}

/** "Do 22.10." (de) / "Thu 22 Oct" (en). */
function formatToday(now: Date, locale: Locale): string {
  // Some ICU versions abbreviate German weekdays with a dot ("Do."); drop it.
  const weekday = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'de-DE', {
    weekday: 'short'
  })
    .format(now)
    .replace(/\.$/, '')
  if (locale === 'en') {
    const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(
      now
    )
    return `${weekday} ${dayMonth}`
  }
  return `${weekday} ${now.getDate()}.${now.getMonth() + 1}.`
}
