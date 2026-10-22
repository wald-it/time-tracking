import { useEffect, useRef } from 'react'

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Visual style for the confirm button. 'danger' = red. */
  variant?: 'danger' | 'primary'
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Confirmation dialog used for destructive actions (e.g. entry delete).
 *
 * Default focus is on Cancel — never on the destructive action — so a
 * stray Enter press does not delete user data.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Abbrechen',
  variant = 'primary',
  onConfirm,
  onCancel
}: Props): React.ReactElement | null {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    queueMicrotask(() => cancelRef.current?.focus())
    return () => window.removeEventListener('keydown', handler)
  }, [open, onCancel])

  if (!open) return null

  const confirmClass =
    variant === 'danger'
      ? 'bg-[var(--danger)] text-[var(--bg)] key-hover focus:ring-[var(--focus)]'
      : 'bg-[var(--inv)] text-[var(--inv-ink)] key-hover focus:ring-[var(--focus)]'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(0_0_0/0.35)]"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-message"
    >
      <div
        className="w-[440px] rounded-[var(--r-disp)] border p-6"
        style={{ background: 'var(--key)', borderColor: 'var(--line)' }}
      >
        <h2
          id="confirm-title"
          className="mb-2 text-lg font-semibold"
          style={{ color: 'var(--ink)' }}
        >
          {title}
        </h2>
        <p id="confirm-message" className="mb-6 text-sm" style={{ color: 'var(--ink2)' }}>
          {message}
        </p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-[var(--r-key)] px-4 py-2.5 text-sm font-medium key-hover focus:outline-none focus:ring-2 focus:ring-[var(--focus)] border"
            style={{
              background: 'var(--key)',
              borderColor: 'var(--line)',
              color: 'var(--ink)'
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-[var(--r-key)] px-4 py-2.5 text-sm font-medium focus:outline-none focus:ring-2 ${confirmClass}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
