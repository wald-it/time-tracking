import { useRef } from 'react'
import { Dialog } from './Dialog'
import { KEY, KEY_INV } from './instrumentClasses'
import { formatDuration } from '../../../shared/duration'
import { useT } from '../contexts/I18nContext'

interface Props {
  idleSince: string
  idleSeconds: number
  onKeep: () => void
  onStopAtIdle: () => void
  onMarkPause: () => void
}

export function IdleModal({
  idleSince,
  idleSeconds,
  onKeep,
  onStopAtIdle,
  onMarkPause
}: Props): React.JSX.Element | null {
  const t = useT()
  const keepRef = useRef<HTMLButtonElement>(null)

  const idleSinceLocal = new Date(idleSince).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit'
  })

  return (
    <Dialog
      open
      onClose={onKeep}
      title={t('idle.title')}
      initialFocusRef={keepRef}
      closeButton={false}
      closeOnBackdrop={false}
    >
      <p className="mb-6 text-sm text-[var(--ink2)]">
        {t('idle.body', { time: idleSinceLocal, duration: formatDuration(idleSeconds) })}
      </p>
      <div className="flex flex-col gap-2">
        <button ref={keepRef} type="button" onClick={onKeep} className={KEY_INV}>
          {t('idle.keep')}
        </button>
        <button type="button" onClick={onStopAtIdle} className={KEY}>
          {t('idle.stopAtIdle', { time: idleSinceLocal })}
        </button>
        <button type="button" onClick={onMarkPause} className={KEY}>
          {t('idle.markPause')}
        </button>
      </div>
      <p className="mt-4 text-xs text-[var(--ink3)]">{t('idle.tip')}</p>
    </Dialog>
  )
}
