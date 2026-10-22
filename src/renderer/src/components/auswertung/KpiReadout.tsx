import { useT } from '../../contexts/I18nContext'

/** A KPI delta (HANDOFF §3.6): direction, formatted change, comparison value. */
export interface KpiDelta {
  /**
   * 'up' / 'down' draw the triangle (turned 180° for 'down'); 'flat' — no
   * change — draws none, so "±0 pp" does not read as a rise.
   */
  direction: 'up' | 'down' | 'flat'
  /** Formatted change, e.g. "+6,1 %" or "−2 pp". null ⇒ no change shown (no base). */
  change: string | null
  /** Formatted comparison value, e.g. "118:45 h". */
  vs: string
}

/**
 * KPI readout, the Auswertung variant of the readout (HANDOFF §3.6): section
 * rule + legend → value in Plex Mono 56/300 + unit → delta line (triangle,
 * delta in Plex Mono 600, "vs. …" in `--ink3`) → optional sub-line. Deltas
 * stay ink-coloured; the triangle (and a screen-reader word) carry the
 * direction, never a colour.
 *
 * The sub-line sits below the delta line so the delta lines of the three
 * KPIs stay on one baseline when only one of them has a sub-line.
 */
export function KpiReadout({
  legend,
  value,
  unit,
  delta,
  sub
}: {
  legend: string
  value: string
  unit?: string
  delta?: KpiDelta | null
  sub?: string
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="flex min-w-0 flex-col gap-2.5 border-t-2 border-[var(--ink)] pt-3.5">
      <div className="text-[11px] font-semibold tracking-[0.14em] text-[var(--ink2)] uppercase [font-stretch:118%]">
        {legend}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-num text-[56px] leading-none font-light tracking-[-0.03em] text-[var(--ink)]">
          {value}
        </span>
        {unit && <span className="text-[15px] text-[var(--ink2)]">{unit}</span>}
      </div>
      {delta && (
        <div className="flex items-center gap-2 text-[13px] text-[var(--ink)]">
          {delta.change !== null && (
            <>
              {delta.direction !== 'flat' && (
                <svg
                  width="10"
                  height="8"
                  viewBox="0 0 10 8"
                  aria-hidden="true"
                  style={{ transform: delta.direction === 'down' ? 'rotate(180deg)' : 'none' }}
                >
                  <path d="M5 0l5 8H0z" fill="currentColor" />
                </svg>
              )}
              {delta.direction !== 'flat' && (
                <span className="sr-only">
                  {t(
                    delta.direction === 'down' ? 'analytics.kpi.deltaDown' : 'analytics.kpi.deltaUp'
                  )}
                </span>
              )}
              <span className="font-num font-semibold">{delta.change}</span>
            </>
          )}
          <span className="text-[var(--ink3)]">{t('analytics.kpi.vs', { value: delta.vs })}</span>
        </div>
      )}
      {sub && <div className="text-xs text-[var(--ink3)]">{sub}</div>}
    </div>
  )
}
