import { useState, useEffect, useCallback } from 'react'
import { useT } from '../contexts/I18nContext'
import type { AnalyticsSummary } from '../../../shared/types'
import { TrendChart } from '../components/TrendChart'
import { ClientBars } from '../components/ClientBars'
import { WeekdayBars } from '../components/WeekdayBars'
import { useRounding } from '../contexts/RoundingContext'
import { roundDuration } from '../../../shared/duration'

// ── Helper formatters ──────────────────────────────────────────────────────

function fmtHours(sec: number): string {
  return (sec / 3600).toFixed(1).replace('.', ',') + ' h'
}

function fmtEUR(cents: number): string {
  return (
    (cents / 100).toLocaleString('de-DE', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }) + ' €'
  )
}

function fmtPct(ratio: number, sign = false): string {
  const n = (ratio * 100).toFixed(0)
  return (sign && ratio > 0 ? '+' : '') + n + ' %'
}

function fmtPctPP(diff: number): string {
  const n = Math.abs(diff * 100).toFixed(0)
  return (diff >= 0 ? '+' : '−') + n + ' pp'
}

function deltaRatio(cur: number, prev: number): number {
  if (prev === 0) return 0
  return (cur - prev) / prev
}

const DE_MONTHS = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember'
]

// ── Sub-components ─────────────────────────────────────────────────────────

interface DeltaPillProps {
  value: number // ratio for revenue/hours, absolute diff for pp
  label: string
  isPp?: boolean // true for billable % (percentage points)
}

function DeltaPill({ value, label, isPp = false }: DeltaPillProps): React.JSX.Element {
  const up = value >= 0
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--r-key)] text-xs font-semibold"
      // Deltas stay ink-coloured; the arrow carries the direction (HANDOFF §3.6).
      style={{ border: '1px solid var(--line)', color: 'var(--ink)' }}
    >
      <span>{up ? '↑' : '↓'}</span>
      {isPp ? fmtPctPP(value) : fmtPct(value, true)}
      <span style={{ color: 'var(--text3)', fontWeight: 500, marginLeft: 2 }}>{label}</span>
    </span>
  )
}

interface StatCardProps {
  label: string
  value: string
  accent?: string
  foot?: React.ReactNode
}

function StatCard({ label, value, accent, foot }: StatCardProps): React.JSX.Element {
  return (
    <div
      className="rounded-[var(--r-disp)] border p-4 flex flex-col gap-2 min-h-[120px]"
      style={{
        background: 'var(--card-bg)',
        borderColor: 'var(--card-border)'
      }}
    >
      <div
        className="text-xs font-semibold uppercase tracking-wide"
        style={{ color: 'var(--text3)' }}
      >
        {label}
      </div>
      <div
        className="text-3xl font-bold tabular-nums leading-tight"
        style={{
          fontFamily: 'var(--font-mono, monospace)',
          color: accent ?? 'var(--text)',
          letterSpacing: 1
        }}
      >
        {value}
      </div>
      {foot && <div className="mt-auto pt-1">{foot}</div>}
    </div>
  )
}

// ── Main View ──────────────────────────────────────────────────────────────

export default function AuswertungView(): React.JSX.Element {
  const t = useT()
  const { roundMinutes } = useRounding()

  // Month navigation state — default to current month
  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth() + 1) // 1-based

  const [chartMode, setChartMode] = useState<'week' | 'month'>('week')
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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- #142: dauerhaft — asynchroner Datenabruf pro Monatsnavigation
    void load(year, month)
  }, [year, month, load])

  function prevMonth(): void {
    if (month === 1) {
      setYear((y) => y - 1)
      setMonth(12)
    } else {
      setMonth((m) => m - 1)
    }
  }

  function nextMonth(): void {
    const isCurrentMonth = year === today.getFullYear() && month === today.getMonth() + 1
    if (isCurrentMonth) return
    if (month === 12) {
      setYear((y) => y + 1)
      setMonth(1)
    } else {
      setMonth((m) => m + 1)
    }
  }

  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth() + 1

  // ── Render ──────────────────────────────────────────────────────────────

  const headerLabel = `${DE_MONTHS[month - 1]} ${year}`

  return (
    <div
      className="flex flex-col gap-4 max-w-[920px] mx-auto w-full"
      style={{ animation: 'fadeIn 0.2s ease' }}
    >
      {/* Header + month nav */}
      <header className="flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-bold tracking-tight" style={{ color: 'var(--text)' }}>
          {t('analytics.title')}
        </h1>

        <div className="flex items-center gap-2">
          <button
            onClick={prevMonth}
            aria-label={t('analytics.prevMonth')}
            className="w-7 h-7 rounded-[var(--r-key)] border grid place-items-center transition-colors key-hover"
            style={{
              background: 'var(--card-bg)',
              borderColor: 'var(--card-border)',
              color: 'var(--text2)',
              cursor: 'pointer'
            }}
          >
            <ChevLeftIcon />
          </button>
          <span
            className="text-sm font-semibold text-center tabular-nums"
            style={{ color: 'var(--text2)', minWidth: 130 }}
          >
            {headerLabel}
          </span>
          <button
            onClick={nextMonth}
            disabled={isCurrentMonth}
            aria-label={t('analytics.nextMonth')}
            className="w-7 h-7 rounded-[var(--r-key)] border grid place-items-center transition-colors key-hover disabled:opacity-30 disabled:cursor-not-allowed"
            style={{
              background: 'var(--card-bg)',
              borderColor: 'var(--card-border)',
              color: 'var(--text2)',
              cursor: isCurrentMonth ? 'not-allowed' : 'pointer'
            }}
          >
            <ChevRightIcon />
          </button>
        </div>

        {data && (
          <span
            className="ml-auto text-xs tabular-nums"
            style={{ color: 'var(--text3)', fontFamily: 'var(--font-mono, monospace)' }}
          >
            Tag {data.month.daysElapsed}/{data.month.daysInMonth}
          </span>
        )}
      </header>

      {/* Loading skeleton */}
      {loading && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="rounded-[var(--r-disp)] border h-[120px] animate-pulse"
                style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
              />
            ))}
          </div>
          <div
            className="rounded-[var(--r-disp)] border h-56 animate-pulse"
            style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
          />
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div
          className="rounded-[var(--r-disp)] border px-4 py-3 text-sm"
          style={{
            borderColor: 'var(--danger)',
            color: 'var(--danger)',
            background: 'var(--danger-bg)'
          }}
        >
          {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && data && !data.month.hasData && (
        <div
          className="rounded-[var(--r-disp)] border p-14 flex flex-col items-center gap-4 text-center"
          style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
        >
          <EmptyIcon />
          <div>
            <p className="text-base font-bold mb-1.5" style={{ color: 'var(--text)' }}>
              {t('analytics.empty.title')}
            </p>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text2)', maxWidth: 320 }}>
              {t('analytics.empty.subtitle')}
            </p>
          </div>
        </div>
      )}

      {/* Data */}
      {!loading && !error && data && data.month.hasData && (
        <>
          {/* Section 1 — Stat cards */}
          <div className="grid grid-cols-3 gap-3">
            <StatCard
              label={t('analytics.month.hours')}
              value={fmtHours(roundDuration(data.month.hours, roundMinutes))}
              foot={
                <DeltaPill
                  value={deltaRatio(data.month.hours, data.month.hoursPrev)}
                  label={t('analytics.vsLastMonth')}
                />
              }
            />
            {data.month.hasRateConfigured ? (
              <StatCard
                label={t('analytics.month.revenue')}
                value={fmtEUR(data.month.revenue)}
                accent="var(--ink)"
                foot={
                  <DeltaPill
                    value={deltaRatio(data.month.revenue, data.month.revenuePrev)}
                    label={t('analytics.vsLastMonth')}
                  />
                }
              />
            ) : (
              <StatCard
                label={t('analytics.month.revenue')}
                value="—"
                foot={
                  <span className="text-xs" style={{ color: 'var(--text3)' }}>
                    {t('analytics.noRate')}
                  </span>
                }
              />
            )}
            <StatCard
              label={t('analytics.month.billable')}
              value={fmtPct(data.month.billable)}
              foot={
                <DeltaPill value={data.month.billable - data.month.billablePrev} label="pp" isPp />
              }
            />
          </div>

          {/* Section 2 — Trend chart */}
          <div
            className="rounded-[var(--r-disp)] border p-4 flex flex-col gap-3"
            style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
          >
            <TrendChart
              weeks={data.weeks}
              months={data.months}
              mode={chartMode}
              onModeChange={setChartMode}
            />
          </div>

          {/* Section 3 — Distribution */}
          <div className="grid gap-3" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
            <div
              className="rounded-[var(--r-disp)] border p-4 flex flex-col gap-3"
              style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-bold" style={{ color: 'var(--text)' }}>
                  {t('analytics.clients.title')}
                </span>
                <span className="text-xs" style={{ color: 'var(--text3)' }}>
                  {t('analytics.clients.period')}
                </span>
              </div>
              <ClientBars clients={data.byClient} />
            </div>

            <div
              className="rounded-[var(--r-disp)] border p-4 flex flex-col gap-3"
              style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-bold" style={{ color: 'var(--text)' }}>
                  {t('analytics.weekday.title')}
                </span>
                <span className="text-xs" style={{ color: 'var(--text3)' }}>
                  {t('analytics.weekday.period')}
                </span>
              </div>
              <WeekdayBars weekday={data.weekday} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Inline SVG icons ───────────────────────────────────────────────────────

function ChevLeftIcon(): React.JSX.Element {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 12L6 8l4-4" />
    </svg>
  )
}

function ChevRightIcon(): React.JSX.Element {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  )
}

function EmptyIcon(): React.JSX.Element {
  return (
    <svg
      width={56}
      height={56}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: 'var(--text3)', opacity: 0.7 }}
    >
      <rect x="10" y="22" width="44" height="32" rx="4" />
      <path d="M18 44V36M26 44V32M34 44V38M42 44V30M50 44V34" />
      <circle cx="48" cy="16" r="6" />
      <path d="M48 13v6M45 16h6" />
    </svg>
  )
}
