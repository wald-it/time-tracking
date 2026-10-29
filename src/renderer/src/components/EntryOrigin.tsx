import { useT } from '../contexts/I18nContext'

/** Only externally authored content gets a source label in the row. */
export function EntryOrigin({ source }: { source?: string | null }): React.JSX.Element | null {
  const t = useT()
  if (source !== 'mcp' && source !== 'import') return null
  return <span className="text-[11px] text-[var(--ink3)]">{t(`history.sourceName.${source}`)}</span>
}
