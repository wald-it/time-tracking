import type { Settings } from '../../../shared/types'
import { useT } from '../contexts/I18nContext'

export function SecretStorageHint({
  mode
}: {
  mode: Settings['secret_storage']
}): React.JSX.Element | null {
  const t = useT()
  if (mode !== 'plain' && mode !== 'unreadable') return null
  return (
    <p className="text-xs" style={{ color: 'var(--ink3)' }}>
      {t(mode === 'plain' ? 'settings.secrets.plain' : 'settings.secrets.unreadable')}
    </p>
  )
}

/**
 * The feed was on but its token was gone at startup (a backup restored on
 * another machine), so a new address was minted: subscribers must re-add it.
 */
export function FeedTokenRecreatedHint({
  recreated,
  enabled
}: {
  recreated: boolean | undefined
  enabled: boolean
}): React.JSX.Element | null {
  const t = useT()
  if (!recreated || !enabled) return null
  return (
    <p className="text-xs" style={{ color: 'var(--ink3)' }}>
      {t('settings.icalFeed.tokenRecreated')}
    </p>
  )
}
