import { useToastStore } from '../store/toastStore'
import { useT } from '../contexts/I18nContext'
import { Z_TOAST } from './Dialog'
import { FOCUS } from './instrumentClasses'

/**
 * Toast tray. Mount once at the App root. Renders bottom-right above any
 * Drawer and any modal (`Z_TOAST`). Each toast lives ~5s; clicking the action button
 * (e.g. "Rückgängig") fires the snapshot stored on the toast.
 */
export function ToastTray(): React.ReactElement | null {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  const executeAction = useToastStore((s) => s.executeAction)
  const tr = useT()

  if (toasts.length === 0) return null

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 flex flex-col gap-2"
      style={{ zIndex: Z_TOAST }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className="pointer-events-auto flex min-w-[280px] max-w-[420px] items-center gap-3 rounded-[var(--r-key)] px-4 py-3 text-sm border"
          style={{
            background: 'var(--disp)',
            borderColor: 'var(--disp-line)',
            color: 'var(--disp-ink)'
          }}
        >
          <span className="flex-1">{t.message}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => void executeAction(t.id)}
              className={`-my-1.5 min-h-11 rounded-[var(--r-fine)] px-2 text-sm font-semibold underline hover:bg-[var(--disp-line)] ${FOCUS}`}
              style={{ color: 'var(--disp-ink)' }}
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            aria-label={tr('common.close')}
            className={`-m-1.5 grid h-11 w-11 place-items-center rounded-[var(--r-fine)] hover:bg-[var(--disp-line)] hover:text-[var(--disp-ink)] ${FOCUS}`}
            style={{ color: 'var(--disp-dim)' }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
