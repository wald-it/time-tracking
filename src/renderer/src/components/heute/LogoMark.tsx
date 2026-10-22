/**
 * Logo mark (HANDOFF §2.6, §3.1): a dial with four index ticks and a `--sig`
 * needle. Markup taken from `design/messinstrument/reference.html`.
 * Decorative — the wordmark next to it carries the name.
 */
export function LogoMark({ size = 22 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="9.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M11 2.5v2.5M19.5 11H17M11 19.5V17M2.5 11H5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M11 11l4.2-4.2"
        style={{ stroke: 'var(--sig)' }}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="11" cy="11" r="1.6" fill="currentColor" />
    </svg>
  )
}
