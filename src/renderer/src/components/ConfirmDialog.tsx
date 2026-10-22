import { useId, useRef } from 'react'
import { Dialog } from './Dialog'
import { FOCUS, KEY, KEY_INV } from './instrumentClasses'

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

/** Destructive key: `--danger` fill, `--bg` text (HANDOFF §2.1). */
const KEY_DANGER = `key-hover inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-[var(--r-key)] border border-[var(--danger)] bg-[var(--danger)] px-4 text-[13px] font-semibold text-[var(--bg)] active:translate-y-px ${FOCUS}`

/**
 * Confirmation dialog used for destructive actions (e.g. entry delete).
 *
 * Default focus is on Cancel — never on the destructive action — so a
 * stray Enter press does not delete user data. Shell, focus trap, Escape
 * (= cancel) and focus return come from `Dialog`.
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
  const messageId = useId()

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      widthClass="w-[440px]"
      role="alertdialog"
      describedBy={messageId}
      initialFocusRef={cancelRef}
      closeButton={false}
      closeOnBackdrop={false}
    >
      <p id={messageId} className="mb-6 text-sm text-[var(--ink2)]">
        {message}
      </p>
      <div className="flex justify-end gap-2">
        <button ref={cancelRef} type="button" onClick={onCancel} className={KEY}>
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={variant === 'danger' ? KEY_DANGER : KEY_INV}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  )
}
