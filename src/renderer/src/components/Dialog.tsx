import { useId, useRef, type ReactNode, type RefObject } from 'react'
import { useT } from '../contexts/I18nContext'
import { FOCUS } from './instrumentClasses'
import { useModalFocus } from './modalFocus'

/**
 * Stacking order for overlays (one step each, PR 5). The calendar drawer sits
 * below at 30/40; TagInput's suggestion list (z-50) lives inside a dialog's
 * own stacking context and is unaffected.
 */
/** Every modal dialog, whatever opens it. */
export const Z_MODAL = 50
/** Toasts stay readable above an open modal (an undo toast after a delete). */
export const Z_TOAST = 60

interface Props {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** Width classes for the panel. Default: w-[460px]. */
  widthClass?: string
  /** `alertdialog` for confirmations. Default: `dialog`. */
  role?: 'dialog' | 'alertdialog'
  /** Id of the element that describes the dialog (`aria-describedby`). */
  describedBy?: string
  /**
   * Element that gets focus on opening. Default: the first form control,
   * else the first button.
   */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Show the × key in the title row. Default: true. */
  closeButton?: boolean
  /** Close on a click on the backdrop. Default: true. */
  closeOnBackdrop?: boolean
  /** Extra content on the right of the title row, before the × key. */
  titleAside?: ReactNode
}

/**
 * The one modal shell (Messinstrument, HANDOFF §5): `--bg` panel, 1 px
 * `--line` border, radius 6, plain `rgb(0 0 0 / .35)` backdrop, title row
 * under a 2 px `--ink` rule.
 *
 * Focus management (`useModalFocus`): moves focus inside on open, traps
 * Tab/Shift+Tab inside, returns focus to the previously focused element on
 * close — only when this dialog is the top one, and to the view's main area
 * when that element is gone. Escape calls `onClose`. Children must not
 * `autoFocus`; use `initialFocusRef`.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  widthClass = 'w-[460px]',
  role = 'dialog',
  describedBy,
  initialFocusRef,
  closeButton = true,
  closeOnBackdrop = true,
  titleAside
}: Props): React.ReactElement | null {
  const t = useT()
  const titleId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  // A press that starts in the panel and is released on the backdrop (a text
  // selection dragged past the edge) makes the browser fire `click` on the
  // backdrop, and so does the reverse. Only a press that started AND ended on
  // the backdrop may close.
  const pressOnBackdrop = useRef(false)
  const releaseOnBackdrop = useRef(false)
  // Focus in, Tab trap, Escape and focus back out (shared with the calendar
  // drawer). Paint in the same order the keyboard follows: the dialog opened
  // last is on top even when it comes earlier in the DOM (the idle prompt
  // opening over the start modal). Kept below the toasts.
  useModalFocus(open, containerRef, {
    onEscape: onClose,
    initialFocus: () => initialFocusRef?.current,
    onOpen: (depth) => {
      if (overlayRef.current) {
        overlayRef.current.style.zIndex = String(Math.min(Z_MODAL + depth, Z_TOAST - 1))
      }
    }
  })

  if (!open) return null

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 flex items-center justify-center bg-[rgb(0_0_0/0.35)] p-6"
      style={{ zIndex: Z_MODAL }}
      role={role}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      onPointerDown={(e) => {
        pressOnBackdrop.current = e.target === e.currentTarget
      }}
      onPointerUp={(e) => {
        releaseOnBackdrop.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        const onBackdrop = pressOnBackdrop.current && releaseOnBackdrop.current
        pressOnBackdrop.current = false
        releaseOnBackdrop.current = false
        if (closeOnBackdrop && onBackdrop && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={containerRef}
        className={`${widthClass} flex max-h-[calc(100vh-3rem)] flex-col rounded-[var(--r-disp)] border border-[var(--line)] bg-[var(--bg)]`}
      >
        <div className="shrink-0 px-6 pt-5">
          <div className="flex min-h-11 items-center justify-between gap-3 border-t-2 border-[var(--ink)] pt-3">
            <h2
              id={titleId}
              className="text-xl font-semibold [font-stretch:108%] text-[var(--ink)]"
            >
              {title}
            </h2>
            {(titleAside || closeButton) && (
              <div className="-mr-2 flex shrink-0 items-center gap-2">
                {titleAside}
                {closeButton && (
                  <button
                    type="button"
                    onClick={onClose}
                    className={`grid h-11 w-11 place-items-center rounded-[var(--r-key)] text-lg text-[var(--ink2)] hover:bg-[var(--key)] hover:text-[var(--ink)] ${FOCUS}`}
                    aria-label={t('common.close')}
                  >
                    ×
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6">{children}</div>
      </div>
    </div>
  )
}
