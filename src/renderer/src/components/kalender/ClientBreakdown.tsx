import { useId, useMemo } from 'react'
import type { Client, Entry, Project } from '../../../../shared/types'
import { useT } from '../../contexts/I18nContext'
import { formatHm } from '../heute/dayScaleLayout'
import { clientShares } from './clientShares'

/**
 * Kalender — "<Monat> nach Kunde" (HANDOFF §3.14), below the day panel.
 *
 * One row per colour group, largest first: colour square · name · share % ·
 * hours, and under it a 4 px `--line` track filled in that colour, its width
 * the share of the month total. Grouped by the colour the bars carry (like
 * the Heute day-scale legend): a project with its own colour is its own row,
 * everything else stays under its client. `nowMs` is the shared clock from
 * `useNow()`; a running entry counts up to it. The maths lives in
 * `clientShares.ts`.
 */
export function ClientBreakdown({
  entries,
  clients,
  projects,
  monthLabel,
  nowMs
}: {
  entries: Entry[]
  clients: Client[]
  projects: Project[]
  /** Month name as shown in the header, e.g. "Oktober". */
  monthLabel: string
  nowMs: number
}): React.JSX.Element {
  const t = useT()
  const headingId = useId()
  const rows = useMemo(
    () => clientShares(entries, clients, nowMs, projects),
    [entries, clients, nowMs, projects]
  )

  return (
    <section aria-labelledby={headingId} className="border-t-2 border-[var(--ink)] pt-[14px]">
      <h2 id={headingId} className="m-0 text-[var(--ink2)]" style={LEGEND}>
        {t('calendar.breakdown.legend', { month: monthLabel })}
      </h2>
      {rows.length === 0 ? (
        <p className="font-num m-0 mt-[14px] text-[13px] text-[var(--ink3)]">–</p>
      ) : (
        <ul className="m-0 mt-[14px] flex list-none flex-col gap-[14px] p-0">
          {rows.map((r) => {
            const color = r.color ?? 'var(--tick)'
            const name = r.name || t('common.unknown')
            return (
              <li key={r.key} className="flex flex-col gap-[6px]">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-[10px] w-[10px] flex-none"
                    style={{ background: color }}
                  />
                  <span
                    className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--ink)]"
                    title={name}
                  >
                    {name}
                  </span>
                  <span className="font-num text-[12px] text-[var(--ink3)]">
                    {Math.round(r.sharePct)} %
                  </span>
                  <span className="font-num min-w-[48px] text-right text-[13px] text-[var(--ink)]">
                    {formatHm(r.seconds)}
                  </span>
                </div>
                <div aria-hidden="true" className="h-[4px] bg-[var(--line)]">
                  <div
                    className="h-[4px]"
                    style={{ width: `${r.sharePct.toFixed(1)}%`, background: color }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** Legend style (HANDOFF §2.2): Archivo 11/600, caps, .14em, expanded. */
const LEGEND: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  fontStretch: '118%'
}
