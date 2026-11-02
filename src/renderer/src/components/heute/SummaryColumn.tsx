import { useLocale, useT } from '../../contexts/I18nContext'
import { formatHoursMinutes } from '../../../../shared/currency'
import type { RoundingRule } from '../../../../shared/types'
import { Readout } from './Readout'
import { WeekMeter } from './WeekMeter'
import { useSettingsStore } from '../../store/settingsStore'
import { parseWeeklyTargetHours } from '../../../../shared/targets'
import { unexplainedGaps, unexplainedMs, type GapEntry } from '../../../../shared/gaps'
import { parseWorkingHours } from '../../../../shared/workingHours'
import { useNow } from '../../contexts/NowContext'

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
  todayRoundedSeconds,
  todayEntries = []
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
  /** Dashboard rows: starts today plus any still-running entry. */
  todayEntries?: GapEntry[]
}): React.JSX.Element {
  const t = useT()
  const { locale } = useLocale()
  const now = new Date(useNow())
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const previousStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const hours = parseWorkingHours(useSettingsStore((s) => s.settings?.working_hours))
  // A carryover alone does not make today eligible. The dashboard includes
  // running carryovers, but not yesterday's already-stopped entries.
  const ownEntries = todayEntries.filter(
    (entry) => new Date(entry.started_at).toDateString() === dayStart.toDateString()
  )
  const carryovers = todayEntries.filter((entry) => {
    const start = Date.parse(entry.started_at)
    return (
      start >= previousStart.getTime() &&
      start < dayStart.getTime() &&
      (entry.stopped_at === null ? now.getTime() : Date.parse(entry.stopped_at)) >
        dayStart.getTime()
    )
  })
  const unexplained = ownEntries.length
    ? unexplainedMs(unexplainedGaps([...ownEntries, ...carryovers], dayStart, now, hours))
    : 0
  const weeklyTarget = parseWeeklyTargetHours(
    useSettingsStore((s) => s.settings?.target_hours_week)
  )
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
      <Readout
        legend={t('today.summary.today')}
        seconds={todaySeconds}
        size="L"
        sub={roundedSub}
        secondSub={
          unexplained > 0
            ? t('time.unexplained', { total: formatHoursMinutes(Math.floor(unexplained / 60_000)) })
            : undefined
        }
      />
      <div className="h-px bg-[var(--line)]" />
      <div>
        <Readout
          legend={t('today.summary.week', { week: weekNumber })}
          seconds={weekSeconds}
          size="M"
          sub={
            weeklyTarget === null
              ? undefined
              : t('today.summary.target', {
                  total: formatHoursMinutes(Math.max(0, Math.floor(weekSeconds / 60))),
                  // 16.5 → "16,5" in German, like every other number in the app.
                  target:
                    locale === 'en' ? String(weeklyTarget) : String(weeklyTarget).replace('.', ',')
                })
          }
        />
        <WeekMeter weekDaySeconds={weekDaySeconds} todayIndex={todayIndex} />
      </div>
    </div>
  )
}
