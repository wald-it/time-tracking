import { getISOWeek, startOfWeek } from 'date-fns'
import { useSettingsStore } from '../store/settingsStore'
import { parseWeekStart, weekStartsOn, type WeekStart } from '../../../shared/weekStart'

/**
 * The configured week start (#188). Selector-scoped, so a view only re-renders
 * when this key changes — same pattern as RoundingContext reads
 * `pdf_round_minutes`.
 */
export function useWeekStart(): WeekStart {
  return parseWeekStart(useSettingsStore((s) => s.settings?.week_start))
}

/**
 * The week number shown for the week that contains `date`: the ISO week of
 * that week's first day — exactly how the calendar labels its rows, so Heute
 * and the calendar never disagree when the week starts on Sunday.
 */
export function weekNumberOf(date: Date, week: WeekStart): number {
  return getISOWeek(startOfWeek(date, { weekStartsOn: weekStartsOn(week) }))
}
