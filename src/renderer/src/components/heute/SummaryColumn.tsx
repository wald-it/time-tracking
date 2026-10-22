import { useT } from '../../contexts/I18nContext'
import { roundDuration } from '../../../../shared/duration'
import { formatHoursMinutes } from '../../../../shared/currency'
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
  roundMinutes,
  todayRoundedSeconds
}: {
  todaySeconds: number
  weekSeconds: number
  weekDaySeconds: number[]
  weekNumber: number
  todayIndex: number
  roundMinutes: number
  /**
   * Today's total as the invoice bills it (each entry rounded up to the
   * step). Omitted ⇒ the day total is rounded as a whole.
   */
  todayRoundedSeconds?: number
}): React.JSX.Element {
  const t = useT()
  const roundedSub =
    roundMinutes > 0
      ? t('today.summary.rounded', {
          total: formatHoursMinutes(
            Math.floor((todayRoundedSeconds ?? roundDuration(todaySeconds, roundMinutes)) / 60)
          ),
          step: roundMinutes
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
