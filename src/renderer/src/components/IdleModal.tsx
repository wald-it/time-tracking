import { useEffect } from 'react'
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
}: Props): React.JSX.Element {
  const t = useT()
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onKeep()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onKeep])

  const idleSinceLocal = new Date(idleSince).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit'
  })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(0_0_0/0.35)]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="idle-modal-title"
    >
      <div
        className="w-[460px] rounded-[var(--r-disp)] border p-6"
        style={{ background: 'var(--key)', borderColor: 'var(--line)' }}
      >
        <h2
          id="idle-modal-title"
          className="mb-2 text-xl font-semibold"
          style={{ color: 'var(--ink)' }}
        >
          {t('idle.title')}
        </h2>
        <p className="mb-6 text-sm" style={{ color: 'var(--ink2)' }}>
          {t('idle.body', { time: idleSinceLocal, duration: formatDuration(idleSeconds) })}
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={onKeep}
            className="rounded-[var(--r-key)] px-4 py-2.5 text-sm font-medium text-[var(--inv-ink)] hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
            style={{ background: 'var(--inv)' }}
            autoFocus
          >
            {t('idle.keep')}
          </button>
          <button
            type="button"
            onClick={onStopAtIdle}
            className="rounded-[var(--r-key)] px-4 py-2.5 text-sm font-medium key-hover focus:outline-none focus:ring-2 focus:ring-[var(--focus)] border"
            style={{
              background: 'var(--key)',
              borderColor: 'var(--line)',
              color: 'var(--ink)'
            }}
          >
            {t('idle.stopAtIdle', { time: idleSinceLocal })}
          </button>
          <button
            type="button"
            onClick={onMarkPause}
            className="rounded-[var(--r-key)] px-4 py-2.5 text-sm font-medium key-hover focus:outline-none focus:ring-2 focus:ring-[var(--focus)] border"
            style={{
              background: 'var(--key)',
              borderColor: 'var(--line)',
              color: 'var(--ink)'
            }}
          >
            {t('idle.markPause')}
          </button>
        </div>
        <p className="mt-4 text-xs" style={{ color: 'var(--ink3)' }}>
          {t('idle.tip')}
        </p>
      </div>
    </div>
  )
}
