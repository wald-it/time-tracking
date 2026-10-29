import { useT } from '../contexts/I18nContext'

/** Ink on paper, like the other metadata chips; billing is not a signal colour. */
export function BilledChip({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const t = useT()
  return (
    <span
      title={t('entry.billed')}
      className="inline-flex w-fit items-center gap-1 rounded-[var(--r-fine)] border border-[var(--line)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--ink2)]"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M5 7V5a3 3 0 0 1 6 0v2M3.5 7h9v7h-9z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      <span className={compact ? '@max-[99px]:sr-only' : undefined}>{t('entry.billed')}</span>
    </span>
  )
}
