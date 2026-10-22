import { formatHoursMinutes } from '../../../../shared/currency'

/**
 * A stat readout (HANDOFF §3.6): legend → value in Plex Mono light + unit →
 * optional sub-line. `L` is the Heute total (44 px), `M` the week (28 px).
 * Values are completed durations, so they use `H:MM` (§2.2).
 */
export function Readout({
  legend,
  seconds,
  size,
  sub
}: {
  legend: string
  seconds: number
  size: 'L' | 'M'
  sub?: string
}): React.JSX.Element {
  const minutes = Math.max(0, Math.floor((Number.isFinite(seconds) ? seconds : 0) / 60))
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ink2)] [font-stretch:118%]">
        {legend}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span
          className={`font-num font-light leading-none text-[var(--ink)] ${
            size === 'L' ? 'text-[44px] tracking-[-0.02em]' : 'text-[28px]'
          }`}
        >
          {formatHoursMinutes(minutes)}
        </span>
        <span className="text-[13px] text-[var(--ink2)]">h</span>
      </div>
      {sub && <div className="mt-1.5 text-xs text-[var(--ink3)]">{sub}</div>}
    </div>
  )
}
