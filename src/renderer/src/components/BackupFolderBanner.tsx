import { useEffect, useState } from 'react'
import { useT } from '../contexts/I18nContext'
import { FOCUS } from './instrumentClasses'

export function BackupFolderBanner({
  onOpenSettings
}: {
  onOpenSettings: () => void
}): React.JSX.Element | null {
  const t = useT()
  const [unreachable, setUnreachable] = useState(false)
  // App keeps this component mounted for the lifetime of the window.
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let active = true
    let request = 0
    async function refresh(): Promise<void> {
      const current = ++request
      try {
        const result = await window.api.backups.getPathInfo()
        if (active && current === request && result.ok) {
          setUnreachable(result.data.isCustom && !result.data.isReachable)
        }
      } catch (err) {
        console.warn('[backup] Could not check backup folder:', err)
      }
    }
    const onFocus = (): void => {
      void refresh()
    }
    void refresh()
    window.addEventListener('focus', onFocus)
    const interval = window.setInterval(onFocus, 5 * 60_000)
    return () => {
      active = false
      window.removeEventListener('focus', onFocus)
      window.clearInterval(interval)
    }
  }, [])

  if (!unreachable || dismissed) return null
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 border-b border-[var(--disp-line)] bg-[var(--disp)] px-4 py-2 text-[var(--disp-ink)]"
    >
      <span className="text-sm">{t('backupFolderBanner.unreachable')}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenSettings}
          className={`-my-1.5 min-h-11 rounded-[var(--r-key)] bg-[var(--disp-ink)] px-3 text-xs font-semibold text-[var(--disp)] key-hover ${FOCUS}`}
        >
          {t('backupFolderBanner.openSettings')}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label={t('common.close')}
          className={`-my-1.5 min-h-11 rounded-[var(--r-key)] px-2 text-sm text-[var(--disp-dim)] hover:bg-[var(--disp-line)] hover:text-[var(--disp-ink)] ${FOCUS}`}
        >
          ×
        </button>
      </div>
    </div>
  )
}
