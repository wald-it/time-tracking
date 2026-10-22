import type { AnalyticsSummary } from '../../../shared/types'
import { useT } from '../contexts/I18nContext'

interface TrendChartProps {
  weeks: AnalyticsSummary['weeks']
  months: AnalyticsSummary['months']
  mode: 'week' | 'month'
  onModeChange: (m: 'week' | 'month') => void
}

const W = 720
const H = 220
const P = { l: 36, r: 48, t: 16, b: 28 }
const TICKS = 4

export function TrendChart({
  weeks,
  months,
  mode,
  onModeChange
}: TrendChartProps): React.JSX.Element {
  const t = useT()

  const data = mode === 'week' ? weeks : months
  const innerW = W - P.l - P.r
  const innerH = H - P.t - P.b
  const step = innerW / data.length
  const bw = step * 0.62

  const maxVal =
    mode === 'week'
      ? Math.max(...weeks.map((d) => d.b + d.n), 1) * 1.08
      : Math.max(...months.map((d) => d.h), 1) * 1.1
  const maxR = mode === 'month' ? Math.max(...months.map((d) => d.r), 1) * 1.1 : 0

  const tickVals = Array.from({ length: TICKS + 1 }, (_, i) => (maxVal * i) / TICKS)

  return (
    <div className="flex flex-col gap-3">
      {/* Header row with segmented control */}
      <div className="flex items-center gap-3">
        <div className="flex flex-col">
          <span className="text-sm font-bold" style={{ color: 'var(--text)' }}>
            Trend
          </span>
          <span className="text-xs" style={{ color: 'var(--text3)' }}>
            {mode === 'week'
              ? 'Letzte 12 Wochen · gestapelt nach abrechenbar / nicht abrechenbar'
              : 'Letzte 12 Monate · Stunden + Umsatzlinie'}
          </span>
        </div>
        {/* Segmented control */}
        <div
          className="ml-auto inline-flex p-0.5 rounded-[var(--r-key)] border"
          style={{
            background: 'var(--input-bg)',
            borderColor: 'var(--card-border)'
          }}
        >
          {(['week', 'month'] as const).map((v) => (
            <button
              key={v}
              onClick={() => onModeChange(v)}
              className="px-3.5 py-1 rounded-[var(--r-key)] text-xs font-medium transition-all"
              style={{
                background: mode === v ? 'var(--accent)' : 'transparent',
                color: mode === v ? 'var(--inv-ink)' : 'var(--text2)',
                border: 'none',
                cursor: 'pointer',
                fontWeight: mode === v ? 600 : 500
              }}
            >
              {v === 'week' ? t('analytics.chart.weeks') : t('analytics.chart.months')}
            </button>
          ))}
        </div>
      </div>

      {/* SVG chart */}
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {/* Grid + Y-axis labels */}
        {tickVals.map((tv, i) => {
          const y = P.t + innerH - (tv / maxVal) * innerH
          return (
            <g key={i}>
              <line
                x1={P.l}
                x2={P.l + innerW}
                y1={y}
                y2={y}
                stroke="var(--card-border)"
                strokeWidth="0.8"
                strokeDasharray={i === 0 ? undefined : '2 4'}
              />
              <text
                x={P.l - 8}
                y={y + 4}
                fontSize="9.5"
                fontFamily="var(--font-num)"
                fill="var(--text3)"
                textAnchor="end"
              >
                {Math.round(mode === 'week' ? tv / 3600 : tv / 3600)}h
              </text>
            </g>
          )
        })}

        {/* Right axis for revenue (month mode) */}
        {mode === 'month' &&
          Array.from({ length: TICKS + 1 }, (_, i) => {
            const rv = (maxR * i) / TICKS
            const y = P.t + innerH - (rv / maxR) * innerH
            return (
              <text
                key={i}
                x={P.l + innerW + 8}
                y={y + 4}
                fontSize="9.5"
                fontFamily="var(--font-num)"
                fill="var(--ink2)"
                textAnchor="start"
              >
                {Math.round(rv / 100000)}k
              </text>
            )
          })}

        {/* Bars */}
        {data.map((d, i) => {
          const x = P.l + step * i + (step - bw) / 2
          if (mode === 'week') {
            const wd = d as AnalyticsSummary['weeks'][number]
            const totalSec = wd.b + wd.n
            const totalH = (totalSec / maxVal) * innerH
            const billH = (wd.b / maxVal) * innerH
            const nbillH = (wd.n / maxVal) * innerH
            const yTotal = P.t + innerH - totalH
            return (
              <g key={i}>
                <rect
                  x={x}
                  y={yTotal + billH}
                  width={bw}
                  height={nbillH}
                  fill="var(--tick)"
                  rx="2"
                />
                <rect x={x} y={yTotal} width={bw} height={billH} fill="var(--ink)" rx="2" />
                <text
                  x={x + bw / 2}
                  y={H - 10}
                  fontSize="9.5"
                  fontFamily="var(--font-num)"
                  fill="var(--text3)"
                  textAnchor="middle"
                >
                  {wd.lbl.replace('KW', '')}
                </text>
                {totalSec > 0 && (
                  <text
                    x={x + bw / 2}
                    y={yTotal - 5}
                    fontSize="9"
                    fontFamily="var(--font-num)"
                    fill="var(--text2)"
                    textAnchor="middle"
                    fontWeight="600"
                  >
                    {Math.round(totalSec / 3600)}
                  </text>
                )}
              </g>
            )
          } else {
            const md = d as AnalyticsSummary['months'][number]
            const h = (md.h / maxVal) * innerH
            const y = P.t + innerH - h
            return (
              <g key={i}>
                <rect x={x} y={y} width={bw} height={h} fill="var(--ink)" rx="2" />
                <text
                  x={x + bw / 2}
                  y={H - 10}
                  fontSize="9.5"
                  fontFamily="var(--font-ui)"
                  fill="var(--text3)"
                  textAnchor="middle"
                >
                  {md.lbl}
                </text>
              </g>
            )
          }
        })}

        {/* Revenue line (month mode) */}
        {mode === 'month' && (
          <g>
            <path
              d={(data as AnalyticsSummary['months'])
                .map((d, i) => {
                  const cx = P.l + step * i + step / 2
                  const cy =
                    P.t + innerH - ((d as AnalyticsSummary['months'][number]).r / maxR) * innerH
                  return `${i === 0 ? 'M' : 'L'} ${cx} ${cy}`
                })
                .join(' ')}
              fill="none"
              stroke="var(--ink2)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {(data as AnalyticsSummary['months']).map((d, i) => {
              const cx = P.l + step * i + step / 2
              const cy =
                P.t + innerH - ((d as AnalyticsSummary['months'][number]).r / maxR) * innerH
              return <circle key={i} cx={cx} cy={cy} r="2.6" fill="var(--ink2)" />
            })}
          </g>
        )}
      </svg>

      {/* Legend */}
      <div className="flex gap-4 flex-wrap text-xs" style={{ color: 'var(--text2)' }}>
        {mode === 'week' ? (
          <>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="w-2.5 h-2.5 rounded-[var(--r-fine)]"
                style={{ background: 'var(--ink)' }}
              />
              {t('analytics.chart.billable')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="w-2.5 h-2.5 rounded-[var(--r-fine)]"
                style={{ background: 'var(--tick)' }}
              />
              {t('analytics.chart.nonBillable')}
            </span>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="w-2.5 h-2.5 rounded-[var(--r-fine)]"
                style={{ background: 'var(--ink)' }}
              />
              {t('analytics.chart.hoursLabel')}
            </span>
            <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--ink2)' }}>
              <span
                className="inline-block h-0.5 w-3.5 rounded"
                style={{ background: 'var(--ink2)' }}
              />
              {t('analytics.chart.revenueLabel')}
            </span>
          </>
        )}
      </div>
    </div>
  )
}
