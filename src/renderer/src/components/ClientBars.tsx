import type { AnalyticsSummary } from '../../../shared/types'
import { useT } from '../contexts/I18nContext'

export const MAX_CLIENT_BARS = 4

interface ClientBarsProps {
  clients: AnalyticsSummary['byClient']
}

function fmtHours(sec: number): string {
  return (sec / 3600).toFixed(1).replace('.', ',') + ' h'
}

export function ClientBars({ clients }: ClientBarsProps): React.JSX.Element {
  const t = useT()

  // Top N clients; remainder grouped as "Sonstige"
  const top = clients.slice(0, MAX_CLIENT_BARS)
  const rest = clients.slice(MAX_CLIENT_BARS)

  const restH = rest.reduce((s, r) => s + r.h, 0)
  const restB = rest.reduce((s, r) => s + r.b, 0)
  const restRev = rest.reduce((s, r) => s + r.rev, 0)

  const items: AnalyticsSummary['byClient'] =
    rest.length > 0
      ? [
          ...top,
          {
            client_id: -1,
            name: t('analytics.clients.other'),
            color: 'var(--text3)',
            h: restH,
            b: restB,
            rev: restRev,
            rest: true
          }
        ]
      : top

  const totalH = items.reduce((s, it) => s + it.h, 0)
  const maxH = Math.max(...items.map((it) => it.h), 1)

  if (items.length === 0) {
    return (
      <p className="text-xs" style={{ color: 'var(--text3)' }}>
        —
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2.5">
      {items.map((it, i) => {
        const pct = (it.h / maxH) * 100
        const sharePct = totalH > 0 ? (it.h / totalH) * 100 : 0
        const color = it.color.startsWith('var(') ? it.color : it.color

        return (
          <div key={it.rest ? 'rest' : (it.client_id ?? i)} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs">
              <span
                className="w-2 h-2 rounded-[var(--r-fine)] shrink-0"
                style={{
                  background: color,
                  opacity: it.rest ? 0.5 : 1
                }}
              />
              <span
                className="flex-1 truncate"
                style={{
                  color: 'var(--text)',
                  fontWeight: it.rest ? 400 : 500,
                  fontStyle: it.rest ? 'italic' : 'normal'
                }}
              >
                {it.name}
              </span>
              <span
                className="tabular-nums"
                style={{
                  fontFamily: 'var(--font-num)',
                  fontSize: '11.5px',
                  color: 'var(--text2)'
                }}
              >
                {fmtHours(it.h)}
              </span>
              <span
                className="tabular-nums text-right"
                style={{
                  fontFamily: 'var(--font-num)',
                  fontSize: '11px',
                  color: 'var(--text3)',
                  minWidth: 36
                }}
              >
                {sharePct.toFixed(0)}%
              </span>
            </div>
            <div
              className="h-1 rounded"
              style={{ background: 'var(--card-border)', overflow: 'hidden' }}
            >
              <div
                className="h-full rounded transition-[width] duration-400"
                style={{
                  width: `${pct}%`,
                  background: it.rest ? 'var(--text3)' : color
                }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
