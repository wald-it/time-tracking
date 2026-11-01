import { useState } from 'react'
import type { AnalyticsSummary } from '../../../../shared/types'
import { formatEurWhole, formatSecondsHm } from '../../../../shared/currency'
import { workedHourlyRateCent } from '../../../../shared/targets'
import {
  CLIENT_REVENUE_SHARE_THRESHOLD,
  nonBillableShare,
  revenueShare,
  yearLabelStep
} from '../../../../shared/clientShares'
import { useLocale, useT } from '../../contexts/I18nContext'
import { SegmentedControl } from './SegmentedControl'

/** Clients shown by name; the rest is summed into one "Sonstige" row (as before). */
export const MAX_CLIENT_ROWS = 4

type ClientRow = AnalyticsSummary['byClient'][number]

const hm = formatSecondsHm
const percent = (ratio: number | null): string =>
  ratio === null ? '—' : `${Math.round(ratio * 100)} %`
const COLUMN =
  'text-right text-[10px] font-semibold tracking-[0.14em] text-[var(--ink3)] uppercase [font-stretch:118%]'

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
export type ClientHoursMode = 'month' | 'year'

export function ClientHours({
  clients,
  clientYear,
  isCurrentMonth,
  showRevenue,
  mode: controlledMode,
  onModeChange
}: {
  clients: AnalyticsSummary['byClient']
  clientYear?: AnalyticsSummary['byClientYear']
  isCurrentMonth: boolean
  /** false when no client or project has a rate: no revenue column at all. */
  showRevenue: boolean
  /** Held by the view so the choice survives a month change (reload unmounts this). */
  mode?: ClientHoursMode
  onModeChange?: (mode: ClientHoursMode) => void
}): React.JSX.Element {
  const t = useT()
  const { locale } = useLocale()
  const [localMode, setLocalMode] = useState<ClientHoursMode>('month')
  const mode = controlledMode ?? localMode
  const setMode = (next: ClientHoursMode): void => {
    setLocalMode(next)
    onModeChange?.(next)
  }
  const yearMode = mode === 'year'
  const windowClients = yearMode ? (clientYear?.clients ?? []) : clients

  const top = windowClients.slice(0, MAX_CLIENT_ROWS)
  const rest = windowClients.slice(MAX_CLIENT_ROWS)
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
  // Month: labels every 10 h, minor ticks every 5 h (unchanged). Year: the
  // label step grows with the range so the narrower ruler keeps at most five steps.
  const labelStep = yearMode ? yearLabelStep(maxHours) : 10
  const axisMax = Math.max(labelStep, Math.ceil(maxHours / labelStep) * labelStep)
  const ticks: number[] = []
  for (let v = 0; v <= axisMax; v += labelStep / 2) ticks.push(v)

  const monthFormatter = new Intl.DateTimeFormat(locale, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  })
  const period =
    yearMode && clientYear
      ? `${monthFormatter.format(new Date(`${clientYear.from}T12:00:00Z`))} – ${monthFormatter.format(new Date(`${clientYear.to}T12:00:00Z`))}`
      : t(isCurrentMonth ? 'analytics.clients.period' : 'analytics.clients.periodPast')

  return (
    <section
      aria-labelledby="auswertung-clients"
      className="min-w-0 border-t-2 border-[var(--ink)] pt-3.5"
      // Year mode needs its extra columns plus a readable ruler: a wider basis
      // makes it take its own row beside the weekday average instead of squeezing.
      style={{ flex: yearMode ? '3 1 860px' : '3 1 520px' }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2
          id="auswertung-clients"
          className="m-0 text-[11px] font-semibold tracking-[0.14em] text-[var(--ink2)] uppercase [font-stretch:118%]"
        >
          {t('analytics.clients.title')}
        </h2>
        <SegmentedControl
          labelledBy="auswertung-clients"
          options={[
            { value: 'month', label: t('analytics.clients.modeMonth') },
            { value: 'year', label: t('analytics.clients.modeYear') }
          ]}
          value={mode}
          onChange={setMode}
        />
        <span className="text-xs text-[var(--ink3)]">
          {showRevenue && !yearMode ? `${period} · ${t('analytics.clients.revenueRight')}` : period}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="mt-5 text-xs text-[var(--ink3)]">—</p>
      ) : (
        <div
          className="mt-[22px] grid items-center"
          style={{
            gridTemplateColumns: yearMode
              ? showRevenue
                ? 'minmax(80px, 110px) minmax(200px, 1fr) 52px 64px 60px 76px 82px'
                : 'minmax(80px, 170px) minmax(200px, 1fr) 72px 76px'
              : showRevenue
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
                style={{ left: `${(v / axisMax) * 100}%`, height: v % labelStep === 0 ? 8 : 4 }}
              />
            ))}
            {ticks
              .filter((v) => v % labelStep === 0)
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
          {yearMode && (
            <>
              {showRevenue && <span className={COLUMN}>{t('analytics.clients.colRate')}</span>}
              <span className={COLUMN}>{t('analytics.clients.colNonBillable')}</span>
              {showRevenue && (
                <span className={COLUMN}>{t('analytics.clients.colRevenueShare')}</span>
              )}
            </>
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
            const rate = workedHourlyRateCent(r.rev, r.h / 3600)
            const share = revenueShare(r.rev, windowClients)
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
                {yearMode && (
                  <>
                    {showRevenue && (
                      <span
                        className={`${cell} font-num justify-end text-[11px] text-[var(--ink)]`}
                      >
                        {rate === null ? '—' : `${formatEurWhole(rate)}/h`}
                      </span>
                    )}
                    <span className={`${cell} font-num justify-end text-[11px] text-[var(--ink)]`}>
                      {percent(nonBillableShare(r.h, r.b))}
                    </span>
                    {showRevenue && (
                      <div
                        className={`${cell} flex-col items-end justify-center gap-1.5 text-[var(--ink)]`}
                      >
                        <span className="font-num text-[11px]">{percent(share)}</span>
                        {!r.rest && share !== null && (
                          <div
                            className="relative h-1 w-16 bg-[var(--tick)]"
                            data-testid="client-share-bar"
                          >
                            <span
                              aria-hidden="true"
                              className="absolute inset-y-0 left-0 bg-[var(--ink3)]"
                              style={{ width: `${Math.min(100, Math.max(0, share * 100))}%` }}
                            />
                            {/* 1 px line in --ink (visible on the fill), inside a
                                9 px transparent hit area so the tooltip can be reached. */}
                            <span
                              role="img"
                              title={t('analytics.clients.shareThreshold')}
                              aria-label={t('analytics.clients.shareThreshold')}
                              data-testid="client-share-mark"
                              className="absolute -top-1.5 -bottom-1.5 flex w-[9px] -translate-x-1/2 cursor-help justify-center"
                              style={{ left: `${CLIENT_REVENUE_SHARE_THRESHOLD * 100}%` }}
                            >
                              <span aria-hidden="true" className="h-full w-px bg-[var(--ink)]" />
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
