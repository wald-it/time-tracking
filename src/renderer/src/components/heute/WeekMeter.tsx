import { useT } from '../../contexts/I18nContext'
import { useWeekStart } from '../../hooks/useWeekStart'
import { formatHoursMinutes } from '../../../../shared/currency'
import type { TranslationKey } from '../../../../shared/locales/de'

const MONDAY_FIRST: TranslationKey[] = [
  'calendar.days.mon',
  'calendar.days.tue',
  'calendar.days.wed',
  'calendar.days.thu',
  'calendar.days.fri',
  'calendar.days.sat',
  'calendar.days.sun'
]

/** The track is 60 px tall and stands for 10 h (HANDOFF §3.7). */
const TRACK_PX = 60
const TRACK_SECONDS = 10 * 3600

/**
 * Seven bars for the current week (HANDOFF §3.7). `weekDaySeconds` and
 * `todayIndex` are in `week_start` order, so the labels follow the same
 * setting. Past days `--ink2`, today `--sig`, future days stay empty.
 */
export function WeekMeter({
  weekDaySeconds,
  todayIndex
}: {
  weekDaySeconds: number[]
  todayIndex: number
}): React.JSX.Element {
  const t = useT()
  const weekStart = useWeekStart()
  const labels =
    weekStart === 'sunday' ? [MONDAY_FIRST[6], ...MONDAY_FIRST.slice(0, 6)] : MONDAY_FIRST

  return (
    <ul className="mt-3.5 flex gap-1.5">
      {labels.map((key, i) => {
        const label = t(key)
        const seconds = Math.max(0, weekDaySeconds[i] ?? 0)
        const value = `${label} ${formatHoursMinutes(Math.floor(seconds / 60))} h`
        const isToday = i === todayIndex
        const isFuture = i > todayIndex
        const height = isFuture ? 0 : Math.min(1, seconds / TRACK_SECONDS) * TRACK_PX
        return (
          <li key={key} className="flex flex-1 flex-col items-stretch gap-1.5">
            <div
              title={value}
              aria-hidden="true"
              className="flex items-end"
              style={{
                height: TRACK_PX,
                background:
                  'repeating-linear-gradient(to top, var(--line) 0 1px, transparent 1px 12px)'
              }}
            >
              {height > 0 && (
                <div
                  className="w-full"
                  style={{
                    height,
                    background: isToday ? 'var(--sig)' : 'var(--ink2)'
                  }}
                />
              )}
            </div>
            <span
              aria-hidden="true"
              className={`font-num text-center text-[11px] ${
                isToday ? 'text-[var(--ink)]' : 'text-[var(--ink3)]'
              }`}
            >
              {label}
            </span>
            <span className="sr-only">{value}</span>
          </li>
        )
      })}
    </ul>
  )
}
