import { useEffect } from 'react'
import { useUpdateStore } from '../store/updateStore'
import { useT } from '../contexts/I18nContext'
import { FOCUS } from './instrumentClasses'

/**
 * v1.5 PR B — slim banner above the main app surface.
 *
 * Visible only for non-idle states. Display style (HANDOFF §5: `--disp`,
 * `--disp-ink`) for every state; errors are NOT red — we don't want to alarm
 * users. Info and warn currently share one look: the text carries the
 * meaning, not the colour (Messinstrument rule 6). A full-width strip, so
 * it has no radius; its keys use radius 4 (`--r-key`).
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
              className={`min-h-8 rounded-[var(--r-key)] bg-[var(--disp-ink)] px-3 text-xs font-semibold text-[var(--disp)] key-hover ${FOCUS}`}
            >
              {t('update.ready.install')}
            </button>
            <button
              type="button"
              onClick={dismissReady}
              className={`min-h-8 rounded-[var(--r-key)] px-2 text-xs text-[var(--disp-dim)] hover:bg-[var(--disp-line)] hover:text-[var(--disp-ink)] ${FOCUS}`}
              aria-label={t('update.ready.dismiss')}
            >
              {t('update.ready.dismiss')}
            </button>
          </div>
        </div>
      )
      break
    case 'error':
      content = (
        <span className="text-sm">
          {t('update.error.text', { message: status.message ?? '' })}
          {' — '}
          <span className="text-xs text-[var(--disp-dim)]">{t('update.error.details')}</span>
        </span>
      )
      break
  }

  // One look for every state — the text carries the meaning, not the colour.
  return (
    <div
      role="status"
      className="flex items-center border-b border-[var(--disp-line)] bg-[var(--disp)] px-4 py-2 text-[var(--disp-ink)]"
    >
      {content}
    </div>
  )
}
