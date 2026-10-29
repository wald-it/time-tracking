import { useT } from '../../contexts/I18nContext'
import { formatHoursMinutes } from '../../../../shared/currency'
import type { RoundingRule } from '../../../../shared/types'
import { Readout } from './Readout'
import { WeekMeter } from './WeekMeter'

/**
 * The Summen column beside the display (HANDOFF §4.1): HEUTE readout L with
 * the rounded total when rounding is on → hairline → WOCHE · KW nn readout M
 * → WeekMeter. The caller passes values that already include the running
 * entry.
 */
export function SummaryColumn({
  todaySeconds,
  weekSeconds,
  weekDaySeconds,
  weekNumber,
  todayIndex,
  roundingRule,
  todayRoundedSeconds
}: {
  todaySeconds: number
  weekSeconds: number
  weekDaySeconds: number[]
  weekNumber: number
  todayIndex: number
  /** Rule to name in the sub-line, or null when the rows share no pure rule. */
  roundingRule: RoundingRule | null
  /**
   * Today's total as the invoice bills it (the billed minutes of the rows).
   * Omitted ⇒ nothing rounds today and no sub-line is shown.
   */
  todayRoundedSeconds?: number
}): React.JSX.Element {
  const t = useT()
  const roundedSub =
    todayRoundedSeconds !== undefined
      ? roundingRule?.kind === 'interval'
        ? t('today.summary.rounded', {
            total: formatHoursMinutes(Math.floor(todayRoundedSeconds / 60)),
            step: roundingRule.minutes
          })
        : roundingRule?.kind === 'minimum'
          ? t('today.summary.minimum', {
              total: formatHoursMinutes(Math.floor(todayRoundedSeconds / 60)),
              min: roundingRule.minutes
            })
          : t('today.summary.roundedOnly', {
              total: formatHoursMinutes(Math.floor(todayRoundedSeconds / 60))
            })
      : undefined

  return (
    <div className="flex flex-[1_1_260px] flex-col gap-[18px] border-t-2 border-[var(--ink)] pt-3.5">
      <Readout legend={t('today.summary.today')} seconds={todaySeconds} size="L" sub={roundedSub} />
      <div className="h-px bg-[var(--line)]" />
      <div>
        <Readout
          legend={t('today.summary.week', { week: weekNumber })}
          seconds={weekSeconds}
          size="M"
        />
        <WeekMeter weekDaySeconds={weekDaySeconds} todayIndex={todayIndex} />
      </div>
    </div>
  )
}
