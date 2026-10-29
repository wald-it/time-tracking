import { useId, useRef, useState } from 'react'
import { useT } from '../contexts/I18nContext'
import { Dialog } from './Dialog'
import { FIELD_LABEL, FOCUS, KEY, KEY_INV, TEXTAREA } from './instrumentClasses'

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Visual style for the confirm button. 'danger' = red. */
  variant?: 'danger' | 'primary'
  requireReason?: boolean
  onConfirm: (reason?: string) => void
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
  confirmLabel,
  cancelLabel,
  variant = 'primary',
  requireReason = false,
  onConfirm,
  onCancel
}: Props): React.ReactElement | null {
  // Mount fresh contents on each opening: a previous reason must never carry over.
  return open ? (
    <ConfirmDialogContent
      {...{
        title,
        message,
        confirmLabel,
        cancelLabel,
        variant,
        requireReason,
        onConfirm,
        onCancel
      }}
    />
  ) : null
}

function ConfirmDialogContent({
  title,
  message,
  confirmLabel,
  cancelLabel,
  variant,
  requireReason,
  onConfirm,
  onCancel
}: Omit<Props, 'open'>): React.ReactElement {
  const t = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const messageId = useId()
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState(false)

  function confirm(): void {
    if (requireReason && !reason.trim()) {
      setReasonError(true)
      return
    }
    onConfirm(requireReason ? reason.trim() : undefined)
  }

  return (
    <Dialog
      open
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
      {requireReason && (
        <label className="mb-6 flex flex-col gap-2">
          <span className={FIELD_LABEL}>{t('entry.billed.reason')}</span>
          <textarea
            value={reason}
            onChange={(e) => {
              setReason(e.target.value)
              setReasonError(false)
            }}
            aria-required="true"
            aria-invalid={reasonError}
            rows={3}
            className={TEXTAREA}
          />
          {reasonError && (
            <span role="alert" className="text-xs text-[var(--danger)]">
              {t('entry.billed.reasonRequired')}
            </span>
          )}
        </label>
      )}
      <div className="flex justify-end gap-2">
        <button ref={cancelRef} type="button" onClick={onCancel} className={KEY}>
          {cancelLabel ?? t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={confirm}
          className={variant === 'danger' ? KEY_DANGER : KEY_INV}
        >
          {confirmLabel ?? t('common.ok')}
        </button>
      </div>
    </Dialog>
  )
}
