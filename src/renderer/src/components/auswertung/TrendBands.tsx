import { useRef, useState } from 'react'
import type { AnalyticsSummary } from '../../../../shared/types'
import type { TranslationKey } from '../../../../shared/locales/de'
import { formatHoursMinutes } from '../../../../shared/currency'
import { useT } from '../../contexts/I18nContext'
import { useNow } from '../../contexts/NowContext'
import { SegmentedControl } from './SegmentedControl'
import {
  BAND_GAP_PX,
  HOURS_BAND_PX,
  LABEL_ROW_PX,
  REVENUE_BAND_PX,
  formatEurWhole,
  formatQuota,
  hoursAxis,
  monthPeriods,
  moveIndex,
  revenueAxis,
  revenuePoints,
  revenuePx,
  runningIndex,
  stackPx,
  tickPx,
  weekPeriods,
  type YearMonth
} from './trendLayout'

const MONTH_KEYS: TranslationKey[] = [
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

const ROWS = `${HOURS_BAND_PX}px ${BAND_GAP_PX}px ${REVENUE_BAND_PX}px ${LABEL_ROW_PX}px`
const HATCH = 'repeating-linear-gradient(135deg, var(--tick) 0 2px, transparent 2px 4px)'
const LEGEND = 'font-semibold uppercase tracking-[0.14em] [font-stretch:118%]'

/** Minutes for `H:MM` (completed durations, §2.2). */
const hm = (seconds: number): string =>
  formatHoursMinutes(Math.max(0, Math.floor((Number.isFinite(seconds) ? seconds : 0) / 60)))

interface Column {
  lbl: string
  b: number
  n: number
  total: number
  r: number
  period: string
  year: number
  showYear: boolean
}

/**
 * Verlauf (HANDOFF §3.15, B3): 12 months or 12 weeks as two bands that share
 * the x-axis — stacked hours on top, revenue with its own T€ axis below — so
 * there is no second y-axis. One `<button>` per period spans both bands and
 * moves the cursor; the display strip above reads the cursor out.
 *
 * `anchor` is the selected month: the columns trail to its end (the same
 * buckets as `analyticsHandlers`), which gives each column its year and tells
 * which one is still running.
 */
export function TrendBands({
  weeks,
  months,
  mode,
  onModeChange,
  anchor
}: {
  weeks: AnalyticsSummary['weeks']
  months: AnalyticsSummary['months']
  mode: 'week' | 'month'
  onModeChange: (mode: 'week' | 'month') => void
  anchor: YearMonth
}): React.JSX.Element {
  const t = useT()
  const nowMs = useNow()
  const buttons = useRef<Array<HTMLButtonElement | null>>([])

  const periods =
    mode === 'week' ? weekPeriods(anchor, weeks.length) : monthPeriods(anchor, months.length)
  const running = runningIndex(mode, anchor, nowMs)
  const columns: Column[] = (
    mode === 'week'
      ? weeks.map((w) => ({ lbl: w.lbl, b: w.b, n: w.n, total: w.b + w.n, r: w.r }))
      : months.map((m) => ({ lbl: m.lbl, b: m.b, n: m.n, total: m.h, r: m.r }))
  ).map((c, i) => {
    const p = periods[i]
    const base = mode === 'week' ? `${c.lbl} ${p.year}` : `${t(MONTH_KEYS[p.index - 1])} ${p.year}`
    return {
      ...c,
      period: i === running ? `${base} · ${t('analytics.cursor.running')}` : base,
      year: p.year,
      showYear: p.showYear
    }
  })

  // The cursor defaults to the running period when the selected month is the
  // current one (in week mode the last column can be a week still ahead),
  // else to the latest period. It resets whenever the columns change meaning
  // (mode or selected month), not on every data refresh.
  const resetKey = `${mode}:${anchor.year}-${anchor.month}`
  const [cursor, setCursor] = useState<{ key: string; index: number } | null>(null)
  const last = columns.length - 1
  const active =
    cursor && cursor.key === resetKey && cursor.index <= last
      ? cursor.index
      : running >= 0 && running <= last
        ? running
        : Math.max(0, last)
  const point = (index: number): void => setCursor({ key: resetKey, index })

  const hAxis = hoursAxis(Math.max(0, ...columns.map((c) => c.total)), mode)
  const rAxis = revenueAxis(Math.max(0, ...columns.map((c) => c.r)), mode)
  const current = columns[active]

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = moveIndex(e.key, index, columns.length)
    if (next === null) return
    e.preventDefault()
    point(next)
    buttons.current[next]?.focus()
  }

  return (
    <section aria-labelledby="h-trend" className="border-t-2 border-[var(--ink)] pt-3.5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 id="h-trend" className={`m-0 text-[11px] text-[var(--ink2)] ${LEGEND}`}>
            {t('analytics.trend.title')}
          </h2>
          <span className="text-xs text-[var(--ink3)]">
            {mode === 'week' ? t('analytics.trend.metaWeeks') : t('analytics.trend.metaMonths')}
          </span>
        </div>
        <SegmentedControl
          labelledBy="h-trend"
          value={mode}
          onChange={onModeChange}
          options={[
            { value: 'week', label: t('analytics.chart.weeks') },
            { value: 'month', label: t('analytics.chart.months') }
          ]}
        />
      </div>

      {current && (
        <div
          aria-live="polite"
          data-testid="trend-cursor"
          className="mt-[18px] flex flex-wrap items-stretch rounded-[6px] border border-[var(--disp-line)] bg-[var(--disp)] text-[var(--disp-ink)]"
        >
          <div className="flex flex-col justify-center gap-0.5 border-r border-[var(--disp-line)] px-5 py-3">
            <span className={`text-[10px] text-[var(--sig)] ${LEGEND}`}>
              {t('analytics.cursor.legend')}
            </span>
            <span className="text-[15px] font-semibold">{current.period}</span>
          </div>
          {[
            { key: 'analytics.cursor.hours' as const, value: hm(current.total) },
            { key: 'analytics.cursor.billable' as const, value: hm(current.b) },
            {
              key: 'analytics.cursor.quota' as const,
              value: formatQuota(current.b, current.total)
            },
            { key: 'analytics.cursor.revenue' as const, value: formatEurWhole(current.r) }
          ].map((cell) => (
            <div
              key={cell.key}
              className="flex flex-col justify-center gap-0.5 border-r border-[var(--disp-line)] px-5 py-3"
            >
              <span className={`text-[10px] text-[var(--disp-dim)] ${LEGEND}`}>{t(cell.key)}</span>
              <span className="font-num text-[20px] font-normal">{cell.value}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-[18px] flex flex-wrap gap-6 text-xs text-[var(--ink2)]">
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="h-3 w-3 bg-[var(--ink)]" />
          {t('analytics.legend.billable')}
        </span>
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-3 w-3"
            style={{ background: HATCH, boxShadow: 'inset 0 0 0 1px var(--tick)' }}
          />
          {t('analytics.legend.nonBillable')}
        </span>
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="h-0.5 w-4 bg-[var(--ink2)]" />
          {t('analytics.legend.revenue')}
        </span>
      </div>

      {/* min-width: 12 columns of ≥ 44 px plus the axis, so the chart fits the
          app's 760 px minimum window without a scrollbar. */}
      <div className="mt-3.5 overflow-x-auto">
        <div
          className="grid min-w-[600px]"
          style={{
            gridTemplateColumns: `56px repeat(${Math.max(1, columns.length)}, minmax(0, 1fr))`,
            gridTemplateRows: ROWS
          }}
        >
          <AxisLabels row={1} ticks={hAxis.ticks} top={hAxis.top} bandPx={HOURS_BAND_PX} unit="h" />
          <Gridlines row={1} ticks={hAxis.ticks} top={hAxis.top} bandPx={HOURS_BAND_PX} />
          <AxisLabels
            row={3}
            ticks={rAxis.ticks}
            top={rAxis.top}
            bandPx={REVENUE_BAND_PX}
            unit={t('analytics.axis.kiloEuro')}
          />
          <Gridlines row={3} ticks={rAxis.ticks} top={rAxis.top} bandPx={REVENUE_BAND_PX}>
            <svg
              viewBox={`0 0 ${columns.length * 10} ${REVENUE_BAND_PX}`}
              preserveAspectRatio="none"
              className="absolute inset-0 h-full w-full overflow-visible"
            >
              <polyline
                data-testid="revenue-line"
                points={revenuePoints(
                  columns.map((c) => c.r),
                  rAxis.top
                )}
                fill="none"
                style={{ stroke: 'var(--ink2)' }}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            </svg>
          </Gridlines>

          {columns.map((c, i) => {
            const isActive = i === active
            const stack = stackPx(c.b, c.n, hAxis.top)
            return (
              <button
                key={`${c.lbl}-${c.year}`}
                ref={(el) => {
                  buttons.current[i] = el
                }}
                type="button"
                tabIndex={isActive ? 0 : -1}
                aria-label={t('analytics.column.aria', {
                  period: c.period,
                  hours: hm(c.total),
                  billable: hm(c.b),
                  revenue: formatEurWhole(c.r)
                })}
                aria-current={isActive ? 'true' : undefined}
                onMouseEnter={() => point(i)}
                onFocus={() => point(i)}
                onClick={() => point(i)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className="relative grid cursor-pointer rounded-none border-0 p-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus)] focus-visible:outline-solid"
                style={{
                  gridColumn: i + 2,
                  gridRow: '1 / 5',
                  gridTemplateRows: ROWS,
                  background: isActive
                    ? 'color-mix(in srgb, var(--ink) 6%, transparent)'
                    : 'transparent'
                }}
              >
                <span className="flex flex-col items-center justify-end gap-0.5">
                  {stack.nonBillable > 0 && (
                    <span
                      data-testid="bar-nonbillable"
                      className="block w-[38%]"
                      style={{
                        height: stack.nonBillable,
                        background: HATCH,
                        boxShadow: 'inset 0 0 0 1px var(--tick)'
                      }}
                    />
                  )}
                  {stack.billable > 0 && (
                    <span
                      data-testid="bar-billable"
                      className="block w-[38%] bg-[var(--ink)]"
                      style={{ height: stack.billable }}
                    />
                  )}
                </span>
                <span />
                <span className="relative">
                  <span
                    data-testid="revenue-dot"
                    className="absolute left-1/2 h-2.5 w-2.5 rounded-full bg-[var(--ink2)]"
                    style={{
                      bottom: revenuePx(c.r, rAxis.top),
                      transform: 'translate(-50%, 50%)',
                      boxShadow: '0 0 0 2px var(--bg)'
                    }}
                  />
                </span>
                <span className="flex flex-col items-center justify-end pb-0.5">
                  <span
                    className={`font-num text-xs ${
                      isActive
                        ? 'font-semibold text-[var(--ink)]'
                        : 'font-normal text-[var(--ink2)]'
                    }`}
                  >
                    {c.lbl}
                  </span>
                  <span className="font-num min-h-[1lh] text-[10px] text-[var(--ink3)]">
                    {c.showYear ? c.year : ''}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  data-testid={isActive ? 'cursor-line' : undefined}
                  className="absolute top-0 left-1/2 w-px"
                  style={{
                    bottom: LABEL_ROW_PX,
                    background: isActive ? 'var(--sig)' : 'transparent'
                  }}
                />
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function AxisLabels({
  row,
  ticks,
  top,
  bandPx,
  unit
}: {
  row: number
  ticks: number[]
  top: number
  bandPx: number
  unit: string
}): React.JSX.Element {
  return (
    <div aria-hidden="true" className="relative" style={{ gridColumn: 1, gridRow: row }}>
      {ticks.map((v) => (
        <span
          key={v}
          className="font-num absolute right-3 text-[11px] text-[var(--ink3)]"
          style={{ bottom: tickPx(v, top, bandPx), transform: 'translateY(50%)' }}
        >
          {v}
        </span>
      ))}
      <span className={`absolute right-3 -top-[22px] text-[10px] text-[var(--ink3)] ${LEGEND}`}>
        {unit}
      </span>
    </div>
  )
}

function Gridlines({
  row,
  ticks,
  top,
  bandPx,
  children
}: {
  row: number
  ticks: number[]
  top: number
  bandPx: number
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="relative border-b border-[var(--ink)]"
      style={{ gridColumn: '2 / -1', gridRow: row }}
    >
      {ticks
        .filter((v) => v > 0)
        .map((v) => (
          <span
            key={v}
            className="absolute right-0 left-0 h-0 border-t border-dotted border-[var(--line)]"
            style={{ bottom: tickPx(v, top, bandPx) }}
          />
        ))}
      {children}
    </div>
  )
}
