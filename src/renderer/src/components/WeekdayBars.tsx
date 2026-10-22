import type { AnalyticsSummary } from '../../../shared/types'

interface WeekdayBarsProps {
  weekday: AnalyticsSummary['weekday']
}

function fmtH(sec: number): string {
  return (sec / 3600).toFixed(1)
}

export function WeekdayBars({ weekday }: WeekdayBarsProps): React.JSX.Element {
  const maxSec = Math.max(...weekday.map((d) => d.h), 1)
  const BAR_MAX_H = 130 // px

  return (
    <div
      className="grid gap-2"
      style={{
        gridTemplateColumns: 'repeat(7, 1fr)',
        alignItems: 'end',
        height: 170
      }}
    >
      {weekday.map((d) => {
        const barH = Math.max((d.h / maxSec) * BAR_MAX_H, d.h > 0 ? 2 : 1)
        const isWeekend = d.d === 'Sa' || d.d === 'So'

        return (
          <div
            key={d.d}
            className="flex flex-col items-center gap-1.5 justify-end"
            style={{ height: '100%' }}
          >
            <span
              className="tabular-nums"
              style={{
                fontSize: 10,
                fontFamily: 'var(--font-num)',
                color: 'var(--text2)'
              }}
            >
              {fmtH(d.h)}
            </span>
            <div
              style={{
                width: '100%',
                height: barH,
                borderRadius: '4px 4px 1px 1px',
                background: isWeekend ? 'var(--tick)' : 'var(--accent)',
                transition: 'height 0.4s ease'
              }}
            />
            <span
              style={{
                fontSize: 11,
                fontWeight: isWeekend ? 400 : 600,
                color: isWeekend ? 'var(--text3)' : 'var(--text2)'
              }}
            >
              {d.d}
            </span>
          </div>
        )
      })}
    </div>
  )
}
