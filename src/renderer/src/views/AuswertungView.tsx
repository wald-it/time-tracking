import { useState, useEffect, useCallback } from 'react'
import { useLocale, useT } from '../contexts/I18nContext'
import { useNow } from '../contexts/NowContext'
import type { AnalyticsSummary } from '../../../shared/types'
import type { Locale } from '../../../shared/i18n'
import type { TranslationKey } from '../../../shared/locales/de'
import { formatEurWholeDigits, formatSecondsHm } from '../../../shared/currency'
import { localDateKey } from '../../../shared/dateRanges'
import { KpiReadout, type KpiDelta } from '../components/auswertung/KpiReadout'
import { ClientHours, type ClientHoursMode } from '../components/auswertung/ClientHours'
import { WeekdayAverage } from '../components/auswertung/WeekdayAverage'
import { compareNote } from '../components/auswertung/compareNote'
import { TrendBands } from '../components/auswertung/TrendBands'
import { TrendChart } from '../components/TrendChart'
import { useSettingsStore } from '../store/settingsStore'
import {
  parseWeeklyTargetHours,
  targetRateFromSetting,
  monthlyTargetHours,
  utilisation,
  monthProjection,
  workedHourlyRateCent
} from '../../../shared/targets'

/**
 * B3 switch (HANDOFF §6): the trend shows hours and revenue in two bands that
 * share the x-axis instead of one chart with a second y-axis. `false` brings
 * back the old dual-axis `TrendChart`.
 */
export const TREND_TWO_BANDS = true

/** 2 px `--focus` outline, offset 2 px (HANDOFF §2.4). */
const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]'
const ICON_KEY = `key-hover flex h-11 w-11 items-center justify-center rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] text-[var(--ink)] shadow-[var(--edge-key)] active:translate-y-px disabled:cursor-not-allowed disabled:text-[var(--ink3)] disabled:active:translate-y-0 ${FOCUS}`
/** Section legend (HANDOFF §2.2): 11/600 caps, expanded. */
const LEGEND = 'text-[11px] font-semibold uppercase tracking-[.14em] [font-stretch:118%]'

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

// ── Formatters ─────────────────────────────────────────────────────────────

const hm = formatSecondsHm
const wholeEurDigits = formatEurWholeDigits

/** Relative change in percent, rounded to the one decimal it is shown with. */
function pctChange(cur: number, prev: number): number | null {
  if (prev <= 0) return null
  return Math.round(((cur - prev) / prev) * 1000) / 10
}

/** "+", "−" (U+2212) or "±" for no change. */
function sign(change: number): string {
  return change < 0 ? '−' : change > 0 ? '+' : '±'
}

function direction(change: number): KpiDelta['direction'] {
  return change < 0 ? 'down' : change > 0 ? 'up' : 'flat'
}

/**
 * A percentage delta: "+6,1 %" / "−2,3 %" / "±0,0 %". The direction follows
 * the shown, rounded value, so a "±0,0 %" never gets a triangle. Without a
 * base (empty comparison period) only "vs. …" is shown.
 */
function pctDelta(cur: number, prev: number, vs: string, locale: Locale): KpiDelta {
  const pct = pctChange(cur, prev)
  if (pct === null) return { direction: 'flat', change: null, vs }
  const digits = Math.abs(pct).toFixed(1)
  return {
    direction: direction(pct),
    change: `${sign(pct)}${locale === 'en' ? digits : digits.replace('.', ',')} %`,
    vs
  }
}

// ── Main view ──────────────────────────────────────────────────────────────

/**
 * Auswertung (Messinstrument, HANDOFF §4.3).
 *
 * Header: legend, month + year, prev/next keys; on the right the comparison
 * note (B2, `compareNote`). KPI row: STUNDEN, UMSATZ (or the `noRate` state),
 * ABRECHENBAR. Middle row: Stunden nach Kunde · Wochentag-Schnitt. Below: the
 * Verlauf (B3).
 *
 * The large numbers are worked time, raw (owner decision 2026-10-22): the
 * hours KPI shows `month.hours` unrounded, and the deltas compare raw with
 * raw. The per-entry rounded total (`hoursRounded`) only feeds the sub-line.
 */
export default function AuswertungView(): React.JSX.Element {
  const t = useT()
  const { locale } = useLocale()
  const now = new Date(useNow())

  // Month navigation state — default to the current month.
  const [year, setYear] = useState(() => new Date().getFullYear())
  const [month, setMonth] = useState(() => new Date().getMonth() + 1) // 1-based

  const [chartMode, setChartMode] = useState<'week' | 'month'>('month')
  // Q13: kept here like chartMode, so a month change does not reset it.
  const [clientMode, setClientMode] = useState<ClientHoursMode>('month')

  const [data, setData] = useState<AnalyticsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (y: number, m: number) => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.api.analytics.getSummary({ year: y, month: m })
      if (res.ok) {
        setData(res.data)
      } else {
        setError(res.error)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // Reload when the local day changes too, not only on month navigation:
  // the same-period comparison (B2) moves with today (Codex + review, PR 4).
  const dayKey = localDateKey(now)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- #142: dauerhaft — asynchroner Datenabruf pro Monatsnavigation
    void load(year, month)
  }, [year, month, load, dayKey])

  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1

  function prevMonth(): void {
    if (month === 1) {
      setYear((y) => y - 1)
      setMonth(12)
    } else {
      setMonth((m) => m - 1)
    }
  }

  function nextMonth(): void {
    if (isCurrentMonth) return
    if (month === 12) {
      setYear((y) => y + 1)
      setMonth(1)
    } else {
      setMonth((m) => m + 1)
    }
  }

  const monthNames = MONTHS_KEYS.map((k) => t(k))
  const ready = !loading && !error && data !== null
  const hasData = ready && data.month.hasData

  return (
    <div className="flex w-full flex-col gap-12">
      {/* Header row (§4.3.1) */}
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex flex-wrap items-end gap-6">
          <div>
            <div className={LEGEND} style={{ color: 'var(--ink2)' }}>
              {t('analytics.title')}
            </div>
            <h1
              className="m-0 mt-1.5 flex items-baseline gap-3.5 text-[44px] leading-none font-semibold tracking-[-0.01em] [font-stretch:112%]"
              style={{ color: 'var(--ink)' }}
            >
              {monthNames[month - 1]}{' '}
              <span
                className="font-num text-[28px] font-light tracking-normal"
                style={{ color: 'var(--ink3)' }}
              >
                {year}
              </span>
            </h1>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={prevMonth}
              className={ICON_KEY}
              aria-label={t('analytics.prevMonth')}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M9 2L4 7l5 5" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            </button>
            <button
              type="button"
              onClick={nextMonth}
              disabled={isCurrentMonth}
              className={ICON_KEY}
              aria-label={t('analytics.nextMonth')}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M5 2l5 5-5 5" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            </button>
          </div>
        </div>
        {hasData && (
          <p
            className="m-0 max-w-[340px] text-[13px] [text-align:end] max-[1000px]:[text-align:start]"
            style={{ color: 'var(--ink2)' }}
            data-testid="compare-note"
          >
            {compareNote({
              comparison: data.month.comparison,
              prevPeriodDays: data.month.prevPeriodDays,
              year,
              month,
              // "Stand …" is the day the data was computed for, so the note and
              // the compared span never come from two different days.
              now: new Date(year, month - 1, data.month.daysElapsed),
              locale,
              monthNames,
              t
            })}
          </p>
        )}
      </div>

      {/* Loading skeleton — hairline blocks */}
      {loading && (
        <div className="flex flex-col gap-12" aria-hidden="true">
          <div
            className="grid gap-8"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))' }}
          >
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-[120px] border-t-2 border-[var(--line)] motion-safe:animate-pulse"
              />
            ))}
          </div>
          <div className="h-56 border-t-2 border-[var(--line)] motion-safe:animate-pulse" />
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div
          role="alert"
          className="border-t-2 border-[var(--danger)] pt-3.5 text-sm"
          style={{ color: 'var(--danger)' }}
        >
          {error}
        </div>
      )}

      {/* Empty state — existing strings, restyled */}
      {ready && !data.month.hasData && (
        <section className="flex flex-col items-start gap-4 border-t-2 border-[var(--ink)] pt-3.5">
          <EmptyIcon />
          <div>
            <p className="m-0 mb-1.5 text-xl font-semibold [font-stretch:108%]">
              {t('analytics.empty.title')}
            </p>
            <p className="m-0 max-w-[320px] text-sm" style={{ color: 'var(--ink2)' }}>
              {t('analytics.empty.subtitle')}
            </p>
          </div>
        </section>
      )}

      {/* Q13: an empty month can still have a year — keep the 12-month view reachable. */}
      {ready && !data.month.hasData && (data.byClientYear?.clients.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-start gap-12">
          <ClientHours
            clients={data.byClient}
            clientYear={data.byClientYear}
            isCurrentMonth={isCurrentMonth}
            showRevenue={data.month.hasRateConfigured}
            mode={clientMode}
            onModeChange={setClientMode}
          />
        </div>
      )}

      {/* Data */}
      {hasData && (
        <>
          {/* KPI row (§4.3.2) */}
          <section
            aria-label={t('analytics.title')}
            className="grid gap-8"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))' }}
          >
            <KpiReadout
              legend={t('analytics.month.hours')}
              value={hm(data.month.hours)}
              unit="h"
              delta={pctDelta(
                data.month.hours,
                data.month.hoursPrev,
                `${hm(data.month.hoursPrev)} h`,
                locale
              )}
              sub={
                data.month.hoursRounded !== null
                  ? data.month.roundingRule?.kind === 'interval'
                    ? t('analytics.month.rounded', {
                        total: hm(data.month.hoursRounded),
                        step: data.month.roundingRule.minutes
                      })
                    : data.month.roundingRule?.kind === 'minimum'
                      ? t('analytics.month.minimum', {
                          total: hm(data.month.hoursRounded),
                          min: data.month.roundingRule.minutes
                        })
                      : t('analytics.month.roundedOnly', { total: hm(data.month.hoursRounded) })
                  : undefined
              }
            />
            {data.month.hasRateConfigured ? (
              <KpiReadout
                legend={t('analytics.month.revenue')}
                value={wholeEurDigits(data.month.revenue)}
                unit="€"
                delta={pctDelta(
                  data.month.revenue,
                  data.month.revenuePrev,
                  `${wholeEurDigits(data.month.revenuePrev)} €`,
                  locale
                )}
              />
            ) : (
              <KpiReadout
                legend={t('analytics.month.revenue')}
                value="—"
                sub={t('analytics.noRate')}
              />
            )}
            <BillableKpi
              legend={t('analytics.month.billable')}
              ratio={data.month.billable}
              ratioPrev={data.month.billablePrev}
              hasBase={data.month.hoursPrev > 0}
            />
            <TargetKpi
              stats={data.month}
              year={year}
              month={month}
              isCurrentMonth={isCurrentMonth}
            />
          </section>

          {/* Middle row (§4.3.3) */}
          <div className="flex flex-wrap items-start gap-12">
            <ClientHours
              clients={data.byClient}
              clientYear={data.byClientYear}
              isCurrentMonth={isCurrentMonth}
              showRevenue={data.month.hasRateConfigured}
              mode={clientMode}
              onModeChange={setClientMode}
            />
            <WeekdayAverage weekday={data.weekday} />
          </div>

          {/* Verlauf (§4.3.4, B3) */}
          {TREND_TWO_BANDS ? (
            <TrendBands
              weeks={data.weeks}
              months={data.months}
              mode={chartMode}
              onModeChange={setChartMode}
              anchor={{ year, month }}
              showRevenue={data.month.hasRateConfigured}
            />
          ) : (
            <TrendChart
              weeks={data.weeks}
              months={data.months}
              mode={chartMode}
              onModeChange={setChartMode}
            />
          )}
        </>
      )}
    </div>
  )
}

function TargetKpi({
  stats,
  year,
  month,
  isCurrentMonth
}: {
  stats: AnalyticsSummary['month']
  year: number
  month: number
  isCurrentMonth: boolean
}): React.JSX.Element {
  const t = useT()
  const weekly = parseWeeklyTargetHours(useSettingsStore((s) => s.settings?.target_hours_week))
  const targetRate = targetRateFromSetting(useSettingsStore((s) => s.settings?.target_rate_cent))
  const target = weekly === null ? null : monthlyTargetHours(weekly, year, month)
  const hours = stats.hours / 3600
  const ratio = target === null ? null : utilisation(hours, target)
  const hasTarget = weekly !== null || targetRate !== null
  const hasRate = stats.hasRateConfigured || targetRate !== null
  const hourlyRate = workedHourlyRateCent(stats.revenue, hours)
  return (
    <KpiReadout
      legend={t('analytics.target.title')}
      value={ratio === null ? '—' : String(Math.round(ratio * 100))}
      unit={ratio === null ? undefined : '%'}
      sub={
        !hasTarget ? (
          t('analytics.target.unset')
        ) : (
          <>
            {target !== null && (
              <div>
                {t('analytics.target.hours', {
                  actual: hm(stats.hours),
                  target: hm(target * 3600)
                })}
              </div>
            )}
            {target !== null && isCurrentMonth && (
              <div>
                {t('analytics.target.projection', {
                  hours: hm(monthProjection(stats.hours, stats.daysElapsed, stats.daysInMonth))
                })}
                {stats.hasRateConfigured &&
                  ` · ${wholeEurDigits(monthProjection(stats.revenue, stats.daysElapsed, stats.daysInMonth))} €`}
              </div>
            )}
            {hasRate && (
              <div>
                {t('analytics.target.effectiveRate', {
                  rate: hourlyRate === null ? '—' : wholeEurDigits(hourlyRate)
                })}
                {targetRate !== null &&
                  ` · ${t('analytics.target.rate', { rate: wholeEurDigits(targetRate) })}`}
              </div>
            )}
          </>
        )
      }
    />
  )
}

/** ABRECHENBAR: whole percent, delta in percentage points ("−2 pp"). */
function BillableKpi({
  legend,
  ratio,
  ratioPrev,
  hasBase
}: {
  legend: string
  ratio: number
  ratioPrev: number
  /** false when the comparison period has no time: no change, like pctDelta. */
  hasBase: boolean
}): React.JSX.Element {
  const pct = Math.round(ratio * 100)
  const pctPrev = Math.round(ratioPrev * 100)
  // Points between the two shown percentages, so "89 % vs. 91 %" reads −2 pp.
  const pp = pct - pctPrev
  return (
    <KpiReadout
      legend={legend}
      value={String(pct)}
      unit="%"
      delta={
        hasBase
          ? {
              direction: direction(pp),
              change: `${sign(pp)}${Math.abs(pp)} pp`,
              vs: `${pctPrev} %`
            }
          : { direction: 'flat', change: null, vs: `${pctPrev} %` }
      }
    />
  )
}

// ── Inline SVG icons ───────────────────────────────────────────────────────

function EmptyIcon(): React.JSX.Element {
  return (
    <svg
      width={56}
      height={56}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="square"
      aria-hidden="true"
      style={{ color: 'var(--ink3)' }}
    >
      <rect x="10" y="22" width="44" height="32" />
      <path d="M18 44V36M26 44V32M34 44V38M42 44V30M50 44V34" />
      <circle cx="48" cy="16" r="6" />
      <path d="M48 13v6M45 16h6" />
    </svg>
  )
}
