import { useEffect } from 'react'
import { useUpdateStore } from '../store/updateStore'
import { useT } from '../contexts/I18nContext'

/**
 * v1.5 PR B — slim banner above the main app surface.
 *
 * Visible only for non-idle states. Display style (HANDOFF §5: `--disp`,
 * `--disp-ink`) for every state; errors are NOT red — we don't want to alarm
 * users. Info and warn currently share one look: the text carries the
 * meaning, not the colour (Messinstrument rule 6).
 *
 * `idle` and `not-available` collapse the banner entirely.
 */
export function UpdateBanner(): React.JSX.Element | null {
  const { status, dismissed, dismissReady, installNow } = useUpdateStore()
  const t = useT()

  useEffect(() => {
    void useUpdateStore.getState().init()
  }, [])

  if (status.status === 'idle' || status.status === 'not-available') return null
  if (status.status === 'ready' && dismissed) return null

  let content: React.ReactNode = null
  let tone: 'info' | 'warn' = 'info'

  switch (status.status) {
    case 'checking':
      content = <span className="text-sm">{t('update.checking')}</span>
      break
    case 'available':
      content = (
        <span className="text-sm">{t('update.available', { version: status.version ?? '' })}</span>
      )
      break
    case 'downloading':
      content = (
        <span className="text-sm">
          {t('update.downloading', {
            version: status.version ?? '…',
            progress: status.progress ?? 0
          })}
        </span>
      )
      break
    case 'ready':
      content = (
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-sm">
            {t('update.ready.text', { version: status.version ?? '' })}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void installNow()}
              className="rounded-[var(--r-key)] bg-[var(--disp-ink)] px-3 py-1.5 text-xs font-medium text-[var(--disp)] transition-colors key-hover"
            >
              {t('update.ready.install')}
            </button>
            <button
              type="button"
              onClick={dismissReady}
              className="rounded-[var(--r-key)] px-2 py-1 text-xs text-[var(--disp-ink)] transition-colors hover:bg-[var(--disp-line)]"
              aria-label={t('update.ready.dismiss')}
            >
              {t('update.ready.dismiss')}
            </button>
          </div>
        </div>
      )
      break
    case 'error':
      tone = 'warn'
      content = (
        <span className="text-sm">
          {t('update.error.text', { message: status.message ?? '' })}
          {' — '}
          <span className="text-xs opacity-80">{t('update.error.details')}</span>
        </span>
      )
      break
  }

  const toneStyle =
    tone === 'warn'
      ? {
          background: 'var(--disp)',
          color: 'var(--disp-ink)',
          borderColor: 'var(--disp-line)'
        }
      : {
          background: 'var(--disp)',
          color: 'var(--disp-ink)',
          borderColor: 'var(--disp-line)'
        }

  return (
    <div role="status" className="flex items-center px-4 py-2 border-b" style={toneStyle}>
      {content}
    </div>
  )
}
