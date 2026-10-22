import type { AnalyticsSummary } from '../../../../shared/types'
import { formatSecondsHm } from '../../../../shared/currency'
import { useT } from '../../contexts/I18nContext'

/** Plot height of the 0–10 h axis in px (the row is 180 px; 20 px headroom for labels). */
const PLOT_PX = 160
const AXIS_MAX_H = 10
const AXIS_STEPS = [0, 2, 4, 6, 8, 10]

const hm = formatSecondsHm

/**
 * Wochentag-Schnitt (HANDOFF §3.15): axis 0–10 h every 2 h, 7 bars at 56 %
 * of the column width in `--ink2`, the value above each bar (Plex Mono 11
 * `--ink2`), weekend labels in `--ink3`. A day above 10 h is clipped at the
 * top of the axis; its label still shows the real value.
 */
export function WeekdayAverage({
  weekday
}: {
  weekday: AnalyticsSummary['weekday']
}): React.JSX.Element {
  const t = useT()
  return (
    <section
      aria-labelledby="auswertung-weekday"
      className="min-w-0 border-t-2 border-[var(--ink)] pt-3.5"
      style={{ flex: '2 1 340px' }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2
          id="auswertung-weekday"
          className="m-0 text-[11px] font-semibold tracking-[0.14em] text-[var(--ink2)] uppercase [font-stretch:118%]"
        >
          {t('analytics.weekday.title')}
        </h2>
        <span className="text-xs text-[var(--ink3)]">{t('analytics.weekday.period')}</span>
      </div>
      <div
        className="mt-[22px] grid gap-x-2"
        style={{
          gridTemplateColumns: '28px repeat(7, minmax(0, 1fr))',
          gridTemplateRows: '180px 28px'
        }}
      >
        <div aria-hidden="true" className="relative" style={{ gridColumn: 1, gridRow: 1 }}>
          {AXIS_STEPS.map((v) => (
            <span
              key={v}
              className="font-num absolute right-0 translate-y-1/2 text-[11px] text-[var(--ink3)]"
              style={{ bottom: (v / AXIS_MAX_H) * PLOT_PX }}
            >
              {v}
            </span>
          ))}
        </div>
        <div
          aria-hidden="true"
          className="relative border-b border-[var(--ink)]"
          style={{ gridColumn: '2 / -1', gridRow: 1 }}
        >
          {AXIS_STEPS.filter((v) => v > 0).map((v) => (
            <span
              key={v}
              className="absolute right-0 left-0 h-0 border-t border-dotted border-[var(--line)]"
              style={{ bottom: (v / AXIS_MAX_H) * PLOT_PX }}
            />
          ))}
        </div>
        {weekday.map((d, i) => {
          const weekend = i >= 5
          const height = Math.min(1, d.h / 3600 / AXIS_MAX_H) * PLOT_PX
          return (
            <div key={d.d} className="contents">
              <div
                className="relative flex flex-col items-center justify-end gap-1.5"
                style={{ gridColumn: i + 2, gridRow: 1 }}
              >
                <span className="font-num text-[11px] text-[var(--ink2)]">{hm(d.h)}</span>
                <div
                  title={`${d.d}: Ø ${hm(d.h)} h`}
                  className="bg-[var(--ink2)]"
                  style={{ width: '56%', height }}
                />
              </div>
              <span
                className="font-num self-end text-center text-xs"
                style={{
                  gridColumn: i + 2,
                  gridRow: 2,
                  color: weekend ? 'var(--ink3)' : 'var(--ink2)'
                }}
              >
                {d.d}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
