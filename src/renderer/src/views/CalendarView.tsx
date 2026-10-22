import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../contexts/I18nContext'
import type { TranslationKey } from '../../../shared/locales/de'
import {
  addMonths,
  endOfMonth,
  endOfWeek,
  getISOWeek,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek
} from 'date-fns'
import type { Entry } from '../../../shared/types'
import type { Client, Project } from '../../../shared/types'
import { useProjectsStore } from '../store/projectsStore'
import { localDateKey } from '../../../shared/dateRanges'
import { weekStartsOn, type WeekStart } from '../../../shared/weekStart'
import { useWeekStart } from '../hooks/useWeekStart'
import { useEntriesStore } from '../store/entriesStore'
import { useTimer } from '../hooks/useTimer'
import { CalendarDrawer } from '../components/CalendarDrawer'
import { GraphImportModal } from '../components/GraphImportModal'
import { useRounding } from '../contexts/RoundingContext'
import { roundDuration } from '../../../shared/duration'
import { billedMinutes, effectiveRateCent, feeCent, formatEur } from '../../../shared/currency'

/**
 * Month-grid calendar view. 7×N rows, KW column on the left.
 * Click a cell → opens `CalendarDrawer` with that day's entries.
 *
 * Performance budget (E12): grouping + render for 200 entries < 100ms.
 * The grouping pass is `O(n)` and uses local YYYY-MM-DD strings as keys.
 *
 * Refresh: re-fetches `entries:getByMonth` on mount, on month change,
 * and on `entriesStore.version` bump.
 */
export default function CalendarView(): React.JSX.Element {
  const t = useT()
  const { clients } = useTimer()
  const { roundMinutes } = useRounding()
  const weekStart = useWeekStart()
  const version = useEntriesStore((s) => s.version)
  const projectsVersion = useProjectsStore((s) => s.version)

  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    void window.api.projects.getAll({}).then((res) => {
      if (res.ok) setProjects(res.data)
    })
  }, [projectsVersion])

  const months = MONTHS_KEYS.map((k) => t(k as import('../../../shared/locales/de').TranslationKey))

  const [cursor, setCursor] = useState(() => startOfMonth(new Date()))
  const [entries, setEntries] = useState<Entry[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [selectedDay, setSelectedDay] = useState<Date | null>(null)
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

  // Group entries by local YYYY-MM-DD (the local-day key).
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

  // Build the visible grid (Mon-anchored weeks covering the whole month).
  const weeks = useMemo(() => buildMonthWeeks(cursor, weekStart), [cursor, weekStart])

  const onPrev = useCallback(() => setCursor((d) => addMonths(d, -1)), [])
  const onNext = useCallback(() => setCursor((d) => addMonths(d, 1)), [])
  const onToday = useCallback(() => {
    const today = new Date()
    setCursor(startOfMonth(today))
    setFocusDay(today)
  }, [setFocusDay])

  // Keyboard navigation on the grid.
  function handleKey(e: React.KeyboardEvent): void {
    let next: Date | null = null
    if (e.key === 'ArrowLeft') next = addDays(focusDay, -1)
    else if (e.key === 'ArrowRight') next = addDays(focusDay, 1)
    else if (e.key === 'ArrowUp') next = addDays(focusDay, -7)
    else if (e.key === 'ArrowDown') next = addDays(focusDay, 7)
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setSelectedDay(focusDay)
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

  const selectedKey = selectedDay ? localDateKey(selectedDay) : null
  const drawerEntries = selectedKey ? (byDay.get(selectedKey) ?? []) : []

  return (
    // `w-full` is load-bearing, not decoration: this is a flex item in App's
    // column layout, and `mx-auto` makes an item size to its content instead of
    // stretching. Until #153 the export toolbar (five pills plus an `ml-auto`
    // button) padded the content out to `max-w-5xl` by accident; with it gone
    // the widest child is the grid, which shrink-wrapped to ~370px in an 886px
    // pane. Every other view already carries `w-full` for this reason.
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onPrev}
          className="grid h-9 w-9 place-items-center rounded-lg border backdrop-blur-xl hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          style={{
            background: 'var(--card-bg)',
            borderColor: 'var(--card-border)',
            color: 'var(--text2)'
          }}
          aria-label={t('calendar.nav.prev')}
        >
          ‹
        </button>
        <h2
          className="min-w-[200px] text-center text-lg font-semibold"
          style={{ color: 'var(--text)' }}
        >
          {formatMonthHeader(cursor, months)}
        </h2>
        <button
          type="button"
          onClick={onNext}
          className="grid h-9 w-9 place-items-center rounded-lg border backdrop-blur-xl hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          style={{
            background: 'var(--card-bg)',
            borderColor: 'var(--card-border)',
            color: 'var(--text2)'
          }}
          aria-label={t('calendar.nav.next')}
        >
          ›
        </button>
        <button
          type="button"
          onClick={onToday}
          className="ml-2 rounded-lg border px-3 py-1.5 text-sm font-medium backdrop-blur-xl hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          style={{
            background: 'var(--card-bg)',
            borderColor: 'var(--card-border)',
            color: 'var(--text)'
          }}
        >
          {t('calendar.nav.today')}
        </button>
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          className="ml-2 rounded-lg border px-3 py-1.5 text-sm font-medium backdrop-blur-xl hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          style={{
            background: 'var(--card-bg)',
            borderColor: 'var(--card-border)',
            color: 'var(--text)'
          }}
        >
          {t('calendarImport.button')}
        </button>
        {status === 'loading' && (
          <span className="ml-auto text-xs" style={{ color: 'var(--text3)' }}>
            {t('calendar.status.loading')}
          </span>
        )}
        {status === 'error' && (
          <span
            className="ml-auto text-xs"
            style={{ color: 'var(--danger)' }}
            title={errorMsg ?? ''}
          >
            {t('calendar.status.error')}
          </span>
        )}
      </div>

      {/* Header row: KW + Mo–So */}
      <div
        className="grid grid-cols-[40px_repeat(7,minmax(0,1fr))] gap-px rounded-t-lg"
        style={{ background: 'var(--card-border)' }}
      >
        <div
          className="px-2 py-1 text-center text-xs font-medium"
          style={{ background: 'var(--nav-bg)', color: 'var(--text3)' }}
        >
          {t('calendar.header.week')}
        </div>
        {(
          [
            'calendar.days.mon',
            'calendar.days.tue',
            'calendar.days.wed',
            'calendar.days.thu',
            'calendar.days.fri',
            'calendar.days.sat',
            'calendar.days.sun'
          ] as TranslationKey[]
        ).map((k) => (
          <div
            key={k}
            className="px-2 py-1 text-center text-xs font-medium"
            style={{ background: 'var(--nav-bg)', color: 'var(--text2)' }}
          >
            {t(k)}
          </div>
        ))}
      </div>

      {/* Grid */}
      <div
        ref={gridRef}
        role="grid"
        aria-label={t('calendar.grid.aria')}
        onKeyDown={handleKey}
        className="grid grid-cols-[40px_repeat(7,minmax(0,1fr))] gap-px rounded-b-lg"
        style={{ background: 'var(--card-border)' }}
      >
        {weeks.map((week) => (
          <Week
            key={week.weekKey}
            week={week}
            cursor={cursor}
            byDay={byDay}
            clients={clients}
            projects={projects}
            focusDay={focusDay}
            months={months}
            roundMinutes={roundMinutes}
            onSelect={(d) => {
              setFocusDay(d)
              setSelectedDay(d)
            }}
          />
        ))}
      </div>

      <CalendarDrawer
        open={selectedDay !== null}
        dateISO={selectedDay ? localDateKey(selectedDay) : ''}
        entries={drawerEntries}
        clients={clients}
        onClose={() => setSelectedDay(null)}
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
  focusDay,
  months,
  roundMinutes,
  onSelect
}: {
  week: WeekData
  cursor: Date
  byDay: Map<string, Entry[]>
  clients: Client[]
  projects: Project[]
  focusDay: Date
  months: readonly string[]
  roundMinutes: number
  onSelect: (d: Date) => void
}): React.JSX.Element {
  return (
    <>
      <div
        className="px-2 py-2 text-center text-xs"
        style={{ background: 'var(--nav-bg)', color: 'var(--text3)' }}
      >
        {week.weekNumber}
      </div>
      {week.days.map((day) => {
        const key = localDateKey(day)
        const dayEntries = byDay.get(key) ?? []
        const inMonth = isSameMonth(day, cursor)
        const isToday = isSameDay(day, new Date())
        const isFocus = isSameDay(day, focusDay)
        const totalSeconds = dayEntries.reduce((sum, e) => sum + entryDurationSeconds(e), 0)
        const displaySeconds = roundDuration(totalSeconds, roundMinutes)
        const revenueCent = dayRevenueCent(dayEntries, clients, projects, roundMinutes)
        return (
          <button
            key={key}
            type="button"
            data-day={key}
            tabIndex={isFocus ? 0 : -1}
            role="gridcell"
            aria-label={`${formatAriaDate(day, months)}${dayEntries.length ? `, ${dayEntries.length}` : ''}`}
            onClick={() => onSelect(day)}
            className={[
              'relative flex h-24 flex-col gap-0.5 px-2 py-1 text-left transition-colors backdrop-blur-xl',
              'focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-400',
              !inMonth && 'opacity-40',
              isToday && 'border-2 border-indigo-500'
            ]
              .filter(Boolean)
              .join(' ')}
            style={{ background: 'var(--card-bg)' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--card-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--card-bg)')}
          >
            <div className="flex items-start justify-between">
              <span
                className="text-sm font-semibold"
                style={{ color: isToday ? 'var(--accent)' : 'var(--text)' }}
              >
                {day.getDate()}
              </span>
              {dayEntries.length > 0 && (
                <span
                  className="text-[10px] tabular-nums"
                  style={{ color: 'var(--text2)', fontFamily: "'JetBrains Mono', monospace" }}
                  title={displaySeconds !== totalSeconds ? formatHHMM(totalSeconds) : undefined}
                >
                  {formatHHMM(displaySeconds)}
                </span>
              )}
            </div>
            {revenueCent > 0 && (
              <span
                data-testid="day-revenue"
                className="self-end text-[10px] tabular-nums"
                style={{ color: 'var(--text3)', fontFamily: "'JetBrains Mono', monospace" }}
              >
                {formatEur(revenueCent)}
              </span>
            )}
            <DayBars
              entries={dayEntries}
              clients={clients}
              projects={projects}
              roundMinutes={roundMinutes}
            />
          </button>
        )
      })}
    </>
  )
}

const MAX_BARS = 5

/** Indigo fallback when an entry's client_id no longer resolves
 *  (deleted client, race during reload, etc.) — same accent as the
 *  rest of the calendar UI so it still reads as "an entry". */
const DEFAULT_BAR_COLOR = '#6366f1'

function DayBars({
  entries,
  clients,
  projects,
  roundMinutes
}: {
  entries: Entry[]
  clients: Client[]
  projects: Project[]
  roundMinutes: number
}): React.JSX.Element | null {
  if (entries.length === 0) return null
  const visible = entries.slice(0, MAX_BARS)
  const overflow = entries.length - visible.length
  const colorById = new Map(clients.map((c) => [c.id, c.color]))
  const projectColorById = new Map(projects.map((p) => [p.id, p.color]))
  return (
    <div className="mt-auto flex flex-col gap-[2px]">
      {visible.map((e) => {
        const projectColor = e.project_id != null ? projectColorById.get(e.project_id) : undefined
        const color = (projectColor || colorById.get(e.client_id)) ?? DEFAULT_BAR_COLOR
        const clientName = clients.find((c) => c.id === e.client_id)?.name ?? 'Eintrag'
        const label = e.description ? `${clientName} — ${e.description}` : clientName
        const rawSec = entryDurationSeconds(e)
        const dispSec = roundDuration(rawSec, roundMinutes)
        const tooltip =
          rawSec !== dispSec
            ? `${label} (${formatHHMM(dispSec)} · exakt: ${formatHHMM(rawSec)})`
            : `${label} (${formatHHMM(rawSec)})`
        return (
          <div
            key={e.id}
            className="h-[3px] rounded-sm"
            style={{ backgroundColor: color }}
            title={tooltip}
          />
        )
      })}
      {overflow > 0 && (
        <span className="text-[10px]" style={{ color: 'var(--text3)' }}>
          +{overflow}
        </span>
      )}
    </div>
  )
}

// --- helpers ---

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
      weekNumber: getISOWeek(days[0]),
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

function entryDurationSeconds(e: Entry): number {
  const stop = e.stopped_at ? new Date(e.stopped_at).getTime() : Date.now()
  return Math.max(0, Math.floor((stop - new Date(e.started_at).getTime()) / 1000))
}

/**
 * Billable revenue of one day in cents, computed per entry exactly like the
 * PDF invoice: billable entries only (#104), minutes ceiled and rounded up
 * to the step, project rate over client rate (#120). A running entry counts
 * up to now, like the hour total next to it.
 */
function dayRevenueCent(
  entries: Entry[],
  clients: Client[],
  projects: Project[],
  roundStep: number
): number {
  let sum = 0
  for (const e of entries) {
    if (e.billable !== 1) continue
    const clientRate = clients.find((c) => c.id === e.client_id)?.rate_cent ?? 0
    const projectRate =
      e.project_id != null ? projects.find((p) => p.id === e.project_id)?.rate_cent : null
    const rate = effectiveRateCent(projectRate, clientRate)
    if (rate <= 0) continue
    sum += feeCent(billedMinutes(entryDurationSeconds(e) * 1000, roundStep), rate)
  }
  return sum
}

function formatHHMM(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

const MONTHS_KEYS = [
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
] as const

function formatMonthHeader(d: Date, months: readonly string[]): string {
  return `${months[d.getMonth()]} ${d.getFullYear()}`
}

function formatAriaDate(d: Date, months: readonly string[]): string {
  return `${d.getDate()}. ${months[d.getMonth()]} ${d.getFullYear()}`
}
