import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNow } from '../contexts/NowContext'
import { useLocale, useT } from '../contexts/I18nContext'
import type { TranslationKey } from '../../../shared/locales/de'
import { addMonths, endOfMonth, endOfWeek, isSameMonth, startOfMonth, startOfWeek } from 'date-fns'
import type { Client, Entry, Project } from '../../../shared/types'
import { useProjectsStore } from '../store/projectsStore'
import { localDateKey } from '../../../shared/dateRanges'
import { weekStartsOn, type WeekStart } from '../../../shared/weekStart'
import { useWeekStart, weekNumberOf } from '../hooks/useWeekStart'
import { useEntriesStore } from '../store/entriesStore'
import { useTimer } from '../hooks/useTimer'
import { CalendarDrawer } from '../components/CalendarDrawer'
import { DayPanel } from '../components/kalender/DayPanel'
import { ClientBreakdown } from '../components/kalender/ClientBreakdown'
import { GraphImportModal } from '../components/GraphImportModal'
import { useRounding } from '../contexts/RoundingContext'
import { roundDuration } from '../../../shared/duration'
import { billedMinutes, effectiveRateCent, feeCent, formatEur } from '../../../shared/currency'
import { formatHm, type DayRange } from '../components/heute/dayScaleLayout'
import { MiniDayScale } from '../components/kalender/MiniDayScale'
import { formatRangeHour, monthRange } from '../components/kalender/monthScale'

/**
 * B4 switch point (HANDOFF §6): from this window width on, the day details
 * live in the persistent aside panel and a click on a day opens NO drawer.
 * Below it the overlay `CalendarDrawer` stays the fallback. To get the old
 * drawer-only behaviour back, make this a query that never matches
 * (e.g. `'(min-width: 100000px)'`).
 */
export const DAY_PANEL_MEDIA_QUERY = '(min-width: 1100px)'

/** 2 px `--focus` outline, offset 2 px (HANDOFF §2.4). */
const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]'
const KEY = `key-hover flex min-h-11 items-center gap-2.5 rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] px-4 text-[13px] font-semibold text-[var(--ink)] shadow-[var(--edge-key)] active:translate-y-px ${FOCUS}`
const ICON_KEY = `key-hover flex h-11 w-11 items-center justify-center rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] text-[var(--ink)] shadow-[var(--edge-key)] active:translate-y-px ${FOCUS}`
/** Section legend (HANDOFF §2.2): 11/600 caps, expanded. */
const LEGEND = 'text-[11px] font-semibold uppercase tracking-[.14em] [font-stretch:118%]'

/**
 * Month-grid calendar view (Messinstrument, HANDOFF §4.2 / §3.12).
 *
 * Header: legend, month + year, prev/next/Heute keys; on the right the Graph
 * import key and the month total. Body: the grid (KW column + 7 day cells,
 * each with its MiniDayScale on one range shared by the whole month) and an
 * aside for the day panel + client breakdown. From `DAY_PANEL_MEDIA_QUERY` on
 * the selected day shows in that panel; below it a click opens the overlay
 * `CalendarDrawer` as before.
 *
 * Selection defaults to today (§4.2.3). Keyboard navigation (v1.2): roving
 * tabindex, arrows move, Enter/Space select, crossing the month edge pages.
 *
 * Performance budget (E12): grouping + render for 200 entries < 100ms.
 * The grouping pass is `O(n)` and uses local YYYY-MM-DD strings as keys.
 *
 * Refresh: re-fetches `entries:getByMonth` on mount, on month change,
 * and on `entriesStore.version` bump. Running entries are measured against
 * the shared clock (`useNow()`), which ticks every second while one runs.
 */
export default function CalendarView(): React.JSX.Element {
  const t = useT()
  const { locale } = useLocale()
  const nowMs = useNow()
  const { clients } = useTimer()
  const { roundMinutes } = useRounding()
  const weekStart = useWeekStart()
  const version = useEntriesStore((s) => s.version)
  const projectsVersion = useProjectsStore((s) => s.version)
  const wide = useMediaQuery(DAY_PANEL_MEDIA_QUERY)

  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    void window.api.projects.getAll({}).then((res) => {
      if (res.ok) setProjects(res.data)
    })
  }, [projectsVersion])

  const months = MONTHS_KEYS.map((k) => t(k))

  const [cursor, setCursor] = useState(() => startOfMonth(new Date()))
  const [entries, setEntries] = useState<Entry[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // Default selection on open = today (§4.2.3).
  const [selectedDay, setSelectedDay] = useState<Date>(() => new Date())
  // The overlay drawer is only the narrow-width fallback; at wide widths it
  // never opens (the aside panel shows the selected day instead).
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [focusDay, setFocusDay] = useState<Date>(() => new Date())
  const [importOpen, setImportOpen] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      setStatus((s) => (s === 'ready' ? s : 'loading'))
      const res = await window.api.entries.getByMonth({
        year: cursor.getFullYear(),
        month: cursor.getMonth() + 1
      })
      if (cancelled) return
      if (res.ok) {
        setEntries(res.data)
        setStatus('ready')
        setErrorMsg(null)
      } else {
        setStatus('error')
        setErrorMsg(res.error)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [cursor, version])

  // Group entries by local YYYY-MM-DD of their start (the local-day key).
  const byDay = useMemo(() => {
    const map = new Map<string, Entry[]>()
    for (const e of entries) {
      const key = localDateKey(new Date(e.started_at))
      const arr = map.get(key)
      if (arr) arr.push(e)
      else map.set(key, [e])
    }
    return map
  }, [entries])

  const clientsById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients])
  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])

  // One range for every cell of the month, so the scales compare (§3.9).
  const range = useMemo(() => monthRange(entries, cursor, nowMs), [entries, cursor, nowMs])

  const weeks = useMemo(() => buildMonthWeeks(cursor, weekStart), [cursor, weekStart])
  const weekdayHeads = useMemo(() => weekdayHeaderKeys(weekStart), [weekStart])

  // Raw worked time (owner decision: the big figure is raw, not rounded).
  const monthSeconds = entries.reduce((sum, e) => sum + entryDurationSeconds(e, nowMs), 0)

  // The roving tabindex needs a cell in the visible month. After paging with
  // the arrow keys the focused day is still in the old month; the 1st of the
  // shown month then takes over until a cell is focused again.
  const activeDay = isSameMonth(focusDay, cursor) ? focusDay : cursor

  const onPrev = useCallback(() => setCursor((d) => addMonths(d, -1)), [])
  const onNext = useCallback(() => setCursor((d) => addMonths(d, 1)), [])
  const onToday = useCallback(() => {
    const today = new Date()
    setCursor(startOfMonth(today))
    setFocusDay(today)
    setSelectedDay(today)
  }, [])

  const selectDay = useCallback(
    (d: Date) => {
      setFocusDay(d)
      setSelectedDay(d)
      if (!wide) setDrawerOpen(true)
    },
    [wide]
  )

  // Keyboard navigation on the grid.
  function handleKey(e: React.KeyboardEvent): void {
    let next: Date | null = null
    if (e.key === 'ArrowLeft') next = addDays(activeDay, -1)
    else if (e.key === 'ArrowRight') next = addDays(activeDay, 1)
    else if (e.key === 'ArrowUp') next = addDays(activeDay, -7)
    else if (e.key === 'ArrowDown') next = addDays(activeDay, 7)
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      selectDay(activeDay)
      return
    } else return
    e.preventDefault()
    setFocusDay(next)
    if (!isSameMonth(next, cursor)) setCursor(startOfMonth(next))
  }

  // When focusDay changes, move DOM focus to it (if rendered).
  useEffect(() => {
    if (!gridRef.current) return
    const key = localDateKey(focusDay)
    const cell = gridRef.current.querySelector<HTMLElement>(`[data-day="${key}"]`)
    cell?.focus({ preventScroll: true })
  }, [focusDay, cursor])

  // The selection always lies in the shown month: after paging away from it,
  // today (if this is the current month) or the 1st stands in, so the panel
  // never shows an "empty" day that simply is not loaded.
  const shownSelection = isSameMonth(selectedDay, cursor)
    ? selectedDay
    : isSameMonth(new Date(nowMs), cursor)
      ? new Date(nowMs)
      : cursor
  const selectedKey = localDateKey(shownSelection)
  // Only meaningful while the selected day lies in the loaded month; the
  // drawer can only be opened from a visible cell, so that always holds there.
  const selectedEntries = byDay.get(selectedKey) ?? []

  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'de-DE', {
        weekday: 'long',
        day: 'numeric',
        month: 'long'
      }),
    [locale]
  )

  const todayKey = localDateKey(new Date(nowMs))
  const monthName = months[cursor.getMonth()]

  return (
    <div className="flex w-full flex-col gap-8">
      {/* Header row (§4.2.1) */}
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex flex-wrap items-end gap-6">
          <div>
            <div className={LEGEND} style={{ color: 'var(--ink2)' }}>
              {t('calendar.legend')}
            </div>
            <h1
              className="m-0 mt-1.5 flex items-baseline gap-3.5 text-[44px] leading-none font-semibold tracking-[-0.01em] [font-stretch:112%]"
              style={{ color: 'var(--ink)' }}
            >
              {monthName}{' '}
              <span
                className="font-num text-[28px] font-light tracking-normal"
                style={{ color: 'var(--ink3)' }}
              >
                {cursor.getFullYear()}
              </span>
            </h1>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onPrev}
              className={ICON_KEY}
              aria-label={t('calendar.nav.prev')}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M9 2L4 7l5 5" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onNext}
              className={ICON_KEY}
              aria-label={t('calendar.nav.next')}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M5 2l5 5-5 5" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            </button>
            <button type="button" onClick={onToday} className={KEY}>
              {t('calendar.nav.today')}
            </button>
          </div>
          {status === 'loading' && (
            <span className="self-center text-xs" style={{ color: 'var(--ink3)' }}>
              {t('calendar.status.loading')}
            </span>
          )}
          {status === 'error' && (
            <span
              className="self-center text-xs"
              style={{ color: 'var(--danger)' }}
              title={errorMsg ?? ''}
            >
              {t('calendar.status.error')}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-8">
          <button type="button" onClick={() => setImportOpen(true)} className={KEY}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect
                x="1.5"
                y="3"
                width="13"
                height="11.5"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <path d="M1.5 6.5h13M5 1v3.5M11 1v3.5" stroke="currentColor" strokeWidth="1.4" />
            </svg>
            {t('calendarImport.button')}
          </button>
          <div className="text-right">
            <div className={LEGEND} style={{ color: 'var(--ink2)' }}>
              {t('calendar.monthTotal', { month: monthName })}
            </div>
            <div className="mt-1.5 flex items-baseline justify-end gap-1.5">
              <span
                data-testid="month-total"
                className="font-num text-[44px] leading-none font-light tracking-[-0.02em]"
                style={{ color: 'var(--ink)' }}
              >
                {formatHm(monthSeconds)}
              </span>
              <span className="text-[13px]" style={{ color: 'var(--ink2)' }}>
                h
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Body (§4.2.2): grid + aside, wrapping below ~1100 px */}
      <div className="flex flex-wrap items-start gap-10">
        <section
          aria-label={`${monthName} ${cursor.getFullYear()}`}
          className="min-w-0 overflow-x-auto"
          style={{ flex: '999 1 680px' }}
        >
          <div
            ref={gridRef}
            role="group"
            aria-label={t('calendar.grid.aria')}
            onKeyDown={handleKey}
            className="grid min-w-[660px] grid-cols-[72px_repeat(7,minmax(0,1fr))]"
            style={{ borderBottom: '1px solid var(--line)' }}
          >
            <div
              className={`${LEGEND} pb-2.5 text-[10px]`}
              style={{ color: 'var(--ink3)', borderBottom: '2px solid var(--ink)' }}
            >
              {t('calendar.header.week')}
            </div>
            {weekdayHeads.map(({ key, weekend }) => (
              <div
                key={key}
                className={`${LEGEND} pb-2.5 pl-2.5 text-[10px]`}
                style={{
                  color: weekend ? 'var(--ink3)' : 'var(--ink2)',
                  borderBottom: '2px solid var(--ink)'
                }}
              >
                {t(key)}
              </div>
            ))}

            {weeks.map((week) => (
              <Week
                key={week.weekKey}
                week={week}
                cursor={cursor}
                byDay={byDay}
                clients={clients}
                projects={projects}
                clientsById={clientsById}
                projectsById={projectsById}
                range={range}
                nowMs={nowMs}
                todayKey={todayKey}
                selectedKey={selectedKey}
                activeDay={activeDay}
                roundMinutes={roundMinutes}
                dateFmt={dateFmt}
                onSelect={selectDay}
              />
            ))}
          </div>
          <p className="m-0 mt-3 text-xs" style={{ color: 'var(--ink3)' }}>
            {t('calendar.footnote', {
              start: formatRangeHour(range.startHour),
              end: formatRangeHour(range.endHour)
            })}
          </p>
        </section>

        {/* min-w-0: a flex item's automatic minimum is its min-content width;
            one long description would otherwise push the aside below the grid. */}
        <aside className="flex min-w-0 flex-col gap-9" style={{ flex: '1 1 300px' }}>
          {wide && <DayPanel dateISO={selectedKey} entries={selectedEntries} clients={clients} />}
          <ClientBreakdown
            entries={entries}
            clients={clients}
            projects={projects}
            monthLabel={monthName}
            nowMs={nowMs}
          />
        </aside>
      </div>

      <CalendarDrawer
        open={!wide && drawerOpen}
        dateISO={selectedKey}
        entries={selectedEntries}
        clients={clients}
        onClose={() => setDrawerOpen(false)}
      />

      <GraphImportModal open={importOpen} onClose={() => setImportOpen(false)} clients={clients} />
    </div>
  )
}

interface WeekData {
  weekKey: string
  weekNumber: number
  days: Date[]
}

function Week({
  week,
  cursor,
  byDay,
  clients,
  projects,
  clientsById,
  projectsById,
  range,
  nowMs,
  todayKey,
  selectedKey,
  activeDay,
  roundMinutes,
  dateFmt,
  onSelect
}: {
  week: WeekData
  cursor: Date
  byDay: Map<string, Entry[]>
  clients: Client[]
  projects: Project[]
  clientsById: Map<number, Client>
  projectsById: Map<number, Project>
  range: DayRange
  nowMs: number
  todayKey: string
  selectedKey: string
  activeDay: Date
  roundMinutes: number
  dateFmt: Intl.DateTimeFormat
  onSelect: (d: Date) => void
}): React.JSX.Element {
  const t = useT()
  // Only the loaded month has entries; out-of-month days count nothing.
  const weekSeconds = week.days.reduce(
    (sum, day) =>
      sum +
      (byDay.get(localDateKey(day)) ?? []).reduce((s, e) => s + entryDurationSeconds(e, nowMs), 0),
    0
  )
  const activeKey = localDateKey(activeDay)
  return (
    <>
      <div
        data-testid="week-cell"
        className="flex min-h-[104px] flex-col justify-between py-2.5 pr-2.5"
        style={{ borderTop: '1px solid var(--line)' }}
      >
        <span
          className="font-num text-[20px] leading-none font-light"
          style={{ color: 'var(--ink)' }}
        >
          {week.weekNumber}
        </span>
        <span
          data-testid="week-total"
          className="font-num text-xs"
          style={{ color: 'var(--ink2)' }}
        >
          {weekSeconds > 0 ? formatHm(weekSeconds) : '–'}
        </span>
      </div>
      {week.days.map((day) => {
        const key = localDateKey(day)
        const inMonth = isSameMonth(day, cursor)
        const dayEntries = inMonth ? (byDay.get(key) ?? []) : []
        const isToday = key === todayKey
        const isSelected = inMonth && key === selectedKey
        const weekend = isWeekend(day)
        const totalSeconds = dayEntries.reduce((sum, e) => sum + entryDurationSeconds(e, nowMs), 0)
        const roundedSeconds = roundDuration(totalSeconds, roundMinutes)
        const revenueCent = dayRevenueCent(dayEntries, clients, projects, roundMinutes, nowMs)
        const date = dateFmt.format(day)
        const ariaLabel =
          totalSeconds > 0
            ? t('calendar.cellAria', { date, hours: formatHm(totalSeconds) })
            : t('calendar.cellAriaEmpty', { date })
        const numberInk = isToday
          ? 'var(--sig-ink)'
          : !inMonth
            ? 'var(--ink3)'
            : weekend
              ? 'var(--ink2)'
              : 'var(--ink)'
        return (
          <button
            key={key}
            type="button"
            data-day={key}
            tabIndex={key === activeKey ? 0 : -1}
            disabled={!inMonth}
            aria-pressed={isSelected}
            aria-label={ariaLabel}
            onClick={() => onSelect(day)}
            className={[
              '@container flex min-h-[104px] min-w-0 cursor-pointer flex-col justify-between gap-2.5 overflow-hidden rounded-none p-2.5 text-left',
              'disabled:cursor-default',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus)]',
              isSelected ? 'bg-[var(--key)]' : 'bg-transparent enabled:hover:bg-[var(--key)]'
            ].join(' ')}
            style={{
              borderLeft: '1px solid var(--line)',
              borderTop: isToday ? '2px solid var(--ink)' : '1px solid var(--line)',
              boxShadow: isSelected ? 'inset 0 0 0 1px var(--ink)' : 'none'
            }}
          >
            {/* Narrow cells (window ~760px): the totals wrap below the number
                instead of running into the neighbour cell. */}
            <span
              className="flex w-full flex-wrap items-start justify-between gap-x-1.5 gap-y-0.5"
              title={revenueCent > 0 ? formatEur(revenueCent) : undefined}
            >
              <span
                data-testid="day-number"
                className="font-num -ml-[5px] px-[5px] py-px text-[13px] font-medium"
                style={{
                  background: isToday ? 'var(--sig)' : 'transparent',
                  color: numberInk
                }}
              >
                {day.getDate()}
              </span>
              <span className="ml-auto flex flex-col items-end gap-0.5">
                {totalSeconds > 0 && (
                  <span
                    data-testid="day-total"
                    className="font-num whitespace-nowrap text-xs"
                    style={{ color: 'var(--ink2)' }}
                    title={
                      roundedSeconds !== totalSeconds
                        ? t('today.summary.rounded', {
                            total: formatHm(roundedSeconds),
                            step: roundMinutes
                          })
                        : undefined
                    }
                  >
                    {formatHm(totalSeconds)}
                  </span>
                )}
                {/* Owner decision: the revenue line stays in the cell (deviates from the
                    mockup). Below ~80px of cell content (narrowest windows) it is
                    hidden rather than split or overflowing — the cell's title keeps it. */}
                {revenueCent > 0 && (
                  <span
                    data-testid="day-revenue"
                    className="font-num whitespace-nowrap text-[11px] @max-[79px]:hidden"
                    style={{ color: 'var(--ink3)' }}
                  >
                    {formatEur(revenueCent)}
                  </span>
                )}
              </span>
            </span>
            {inMonth && (
              <MiniDayScale
                entries={dayEntries}
                range={range}
                nowMs={nowMs}
                isToday={isToday}
                projectsById={projectsById}
                clientsById={clientsById}
              />
            )}
          </button>
        )
      })}
    </>
  )
}

// --- helpers ---

/** Matches a media query and follows changes; `false` where matchMedia is missing (tests). */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = (): void => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

const WEEKDAY_KEYS: TranslationKey[] = [
  'calendar.days.sun',
  'calendar.days.mon',
  'calendar.days.tue',
  'calendar.days.wed',
  'calendar.days.thu',
  'calendar.days.fri',
  'calendar.days.sat'
]

/** Weekday header in grid order — it follows the week_start setting like the rows do. */
function weekdayHeaderKeys(week: WeekStart): { key: TranslationKey; weekend: boolean }[] {
  const first = weekStartsOn(week)
  return Array.from({ length: 7 }, (_, i) => {
    const dow = (first + i) % 7
    return { key: WEEKDAY_KEYS[dow], weekend: dow === 0 || dow === 6 }
  })
}

function isWeekend(d: Date): boolean {
  const dow = d.getDay()
  return dow === 0 || dow === 6
}

function buildMonthWeeks(cursor: Date, week: WeekStart): WeekData[] {
  // Weeks covering the visible month, anchored per the week_start setting
  // (#188) so the grid breaks where the week total does.
  const opts = { weekStartsOn: weekStartsOn(week) } as const
  const start = startOfWeek(startOfMonth(cursor), opts)
  const end = endOfWeek(endOfMonth(cursor), opts)
  const weeks: WeekData[] = []
  let d = start
  while (d <= end) {
    const days: Date[] = []
    for (let i = 0; i < 7; i++) {
      days.push(d)
      d = addDays(d, 1)
    }
    weeks.push({
      weekKey: localDateKey(days[0]),
      weekNumber: weekNumberOf(days[0], week),
      days
    })
  }
  return weeks
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d)
  next.setDate(next.getDate() + n)
  return next
}

/** Elapsed seconds of an entry; a running one counts up to `nowMs`. */
function entryDurationSeconds(e: Entry, nowMs: number): number {
  const stop = e.stopped_at ? new Date(e.stopped_at).getTime() : nowMs
  return Math.max(0, Math.floor((stop - new Date(e.started_at).getTime()) / 1000))
}

/**
 * Billable revenue of one day in cents, computed per entry exactly like the
 * PDF invoice: billable entries only (#104), minutes ceiled and rounded up
 * to the step, project rate over client rate (#120), project rate 0 =
 * goodwill. A running entry counts up to now, like the hour total next to it.
 */
function dayRevenueCent(
  entries: Entry[],
  clients: Client[],
  projects: Project[],
  roundStep: number,
  nowMs: number
): number {
  let sum = 0
  for (const e of entries) {
    if (e.billable !== 1) continue
    const clientRate = clients.find((c) => c.id === e.client_id)?.rate_cent ?? 0
    const projectRate =
      e.project_id != null ? projects.find((p) => p.id === e.project_id)?.rate_cent : null
    const rate = effectiveRateCent(projectRate, clientRate)
    if (rate <= 0) continue
    // Milliseconds, not entryDurationSeconds: the invoice ceils the exact span.
    const stop = e.stopped_at ? new Date(e.stopped_at).getTime() : nowMs
    const rawMs = Math.max(0, stop - new Date(e.started_at).getTime())
    sum += feeCent(billedMinutes(rawMs, roundStep), rate)
  }
  return sum
}

const MONTHS_KEYS: TranslationKey[] = [
  'calendar.months.jan',
  'calendar.months.feb',
  'calendar.months.mar',
  'calendar.months.apr',
  'calendar.months.may',
  'calendar.months.jun',
  'calendar.months.jul',
  'calendar.months.aug',
  'calendar.months.sep',
  'calendar.months.oct',
  'calendar.months.nov',
  'calendar.months.dec'
]
