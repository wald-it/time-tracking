import type { AnalyticsSummary } from '../../../../shared/types'
import { formatEurWhole, formatSecondsHm } from '../../../../shared/currency'
import { useT } from '../../contexts/I18nContext'

/** Clients shown by name; the rest is summed into one "Sonstige" row (as before). */
export const MAX_CLIENT_ROWS = 4

type ClientRow = AnalyticsSummary['byClient'][number]

const hm = formatSecondsHm

/**
 * Stunden nach Kunde (HANDOFF §3.15): section rule + legend, period meta on
 * the right; a grid `170px | 1fr | 72px | 88px` with no column gap so the row
 * hairlines run through. A ruler on top (0…max in 10 h steps, 5 h minor
 * ticks, max = next multiple of 10 h at or above the largest row), 18 px bars
 * in the client colour, hours in Plex Mono 14 and revenue in Plex Mono 13 —
 * a client without revenue shows "intern" in `--ink3`.
 *
 * Values are worked time, raw (owner decision 2026-10-22); revenue comes
 * ready from the data (billed like the invoice).
 */
export function ClientHours({
  clients,
  isCurrentMonth,
  showRevenue
}: {
  clients: AnalyticsSummary['byClient']
  isCurrentMonth: boolean
  /** false when no client or project has a rate: no revenue column at all. */
  showRevenue: boolean
}): React.JSX.Element {
  const t = useT()

  const top = clients.slice(0, MAX_CLIENT_ROWS)
  const rest = clients.slice(MAX_CLIENT_ROWS)
  const rows: ClientRow[] =
    rest.length > 0
      ? [
          ...top,
          {
            client_id: -1,
            name: t('analytics.clients.other'),
            color: 'var(--tick)',
            h: rest.reduce((s, r) => s + r.h, 0),
            b: rest.reduce((s, r) => s + r.b, 0),
            rev: rest.reduce((s, r) => s + r.rev, 0),
            rest: true
          }
        ]
      : top

  const maxHours = Math.max(0, ...rows.map((r) => r.h / 3600))
  const axisMax = Math.max(10, Math.ceil(maxHours / 10) * 10)
  const ticks: number[] = []
  for (let v = 0; v <= axisMax; v += 5) ticks.push(v)

  const period = t(isCurrentMonth ? 'analytics.clients.period' : 'analytics.clients.periodPast')

  return (
    <section
      aria-labelledby="auswertung-clients"
      className="min-w-0 border-t-2 border-[var(--ink)] pt-3.5"
      style={{ flex: '3 1 520px' }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2
          id="auswertung-clients"
          className="m-0 text-[11px] font-semibold tracking-[0.14em] text-[var(--ink2)] uppercase [font-stretch:118%]"
        >
          {t('analytics.clients.title')}
        </h2>
        <span className="text-xs text-[var(--ink3)]">
          {showRevenue ? `${period} · ${t('analytics.clients.revenueRight')}` : period}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="mt-5 text-xs text-[var(--ink3)]">—</p>
      ) : (
        <div
          className="mt-[22px] grid items-center"
          style={{
            gridTemplateColumns: showRevenue
              ? '170px minmax(0, 1fr) 72px 88px'
              : '170px minmax(0, 1fr) 72px',
            columnGap: 0
          }}
        >
          <span />
          <div
            aria-hidden="true"
            className="relative mx-4 h-[26px] border-b border-[var(--ink)]"
            data-testid="client-ruler"
          >
            {ticks.map((v) => (
              <span
                key={`t${v}`}
                className="absolute bottom-0 w-px bg-[var(--tick)]"
                style={{ left: `${(v / axisMax) * 100}%`, height: v % 10 === 0 ? 8 : 4 }}
              />
            ))}
            {ticks
              .filter((v) => v % 10 === 0)
              .map((v) => (
                <span
                  key={`l${v}`}
                  className="font-num absolute top-0 -translate-x-1/2 text-[11px] text-[var(--ink2)]"
                  style={{ left: `${(v / axisMax) * 100}%` }}
                >
                  {v}
                </span>
              ))}
          </div>
          <span className="text-right text-[10px] font-semibold tracking-[0.14em] text-[var(--ink3)] uppercase [font-stretch:118%]">
            {t('analytics.clients.colHours')}
          </span>
          {showRevenue && (
            <span className="text-right text-[10px] font-semibold tracking-[0.14em] text-[var(--ink3)] uppercase [font-stretch:118%]">
              {t('analytics.clients.colRevenue')}
            </span>
          )}

          {rows.map((r) => {
            // "intern" means no billable time at all (owner 2026-10-22). Billable
            // time without revenue — no rate at that client, or goodwill — is "—".
            const internal = r.b <= 0
            const dim = internal || r.rev <= 0
            const revenue = internal
              ? t('analytics.clients.internal')
              : r.rev > 0
                ? formatEurWhole(r.rev)
                : '—'
            const width = axisMax > 0 ? Math.min(100, (r.h / 3600 / axisMax) * 100) : 0
            const cell = 'flex min-h-[52px] items-center border-b border-[var(--line)]'
            return (
              <div key={r.rest ? 'rest' : r.client_id} className="contents" data-client-row>
                <div className={`${cell} min-w-0 gap-2`}>
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 flex-none"
                    style={{ background: r.color }}
                  />
                  <span
                    className="truncate text-[13px] text-[var(--ink)]"
                    style={{ fontWeight: r.rest ? 400 : 600 }}
                  >
                    {r.name}
                  </span>
                </div>
                <div className={`${cell} px-4`}>
                  <div
                    title={
                      showRevenue
                        ? `${r.name}: ${hm(r.h)} h · ${revenue}`
                        : `${r.name}: ${hm(r.h)} h`
                    }
                    className="h-[18px]"
                    style={{ width: `${width}%`, background: r.color }}
                  />
                </div>
                <span className={`${cell} font-num justify-end text-sm text-[var(--ink)]`}>
                  {hm(r.h)}
                </span>
                {showRevenue && (
                  <span
                    className={`${cell} font-num justify-end text-[13px]`}
                    style={{ color: dim ? 'var(--ink3)' : 'var(--ink)' }}
                  >
                    {revenue}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
