import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { useT } from '../contexts/I18nContext'
import { FOCUS } from './instrumentClasses'

/**
 * Stacking order for overlays (one step each, PR 5). The calendar drawer sits
 * below at 30/40; TagInput's suggestion list (z-50) lives inside a dialog's
 * own stacking context and is unaffected.
 */
/** Every modal dialog, whatever opens it. */
export const Z_MODAL = 50
/** Toasts stay readable above an open modal (an undo toast after a delete). */
export const Z_TOAST = 60

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Open dialogs, innermost last. Only the top one reacts to Tab and Escape, so
 * two open dialogs (e.g. the idle prompt over the start modal) never fight
 * over focus and one Escape closes one dialog.
 */
const openStack: symbol[] = []

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
 * Focus management: moves focus inside on open, traps Tab/Shift+Tab inside,
 * returns focus to the previously focused element on close. Escape calls
 * `onClose`.
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
  const previouslyFocused = useRef<Element | null>(null)
  // Keep latest onClose in a ref so the focus/keydown effect doesn't re-run
  // every time the parent re-renders (which would re-focus the close button
  // on every tick — e.g. Today's running-timer pill ticks once per second).
  const onCloseRef = useRef(onClose)
  // eslint-disable-next-line react-hooks/refs -- #157: dauerhaft — hält onClose aktuell, ohne den Fokus-Effekt bei jedem Elternrender neu zu starten (siehe Kommentar darüber); der Compiler ist bewusst nicht aktiviert (Messung im Issue)
  onCloseRef.current = onClose
  // Same reasoning: the initial-focus target is read once per opening.
  const initialFocusRefRef = useRef(initialFocusRef)
  // eslint-disable-next-line react-hooks/refs -- see onCloseRef above
  initialFocusRefRef.current = initialFocusRef

  useEffect(() => {
    if (!open) return
    const token = Symbol('dialog')
    openStack.push(token)
    previouslyFocused.current = document.activeElement

    const handler = (e: KeyboardEvent): void => {
      if (openStack[openStack.length - 1] !== token) return
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const root = containerRef.current
      if (!root) return
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      const inside = active instanceof Node && root.contains(active)
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handler)
    // Move focus into the dialog after mount so screen readers announce it.
    // Prefer the first form control over the close (×) button — the close
    // button is earlier in the DOM but should never steal initial focus.
    queueMicrotask(() => {
      const root = containerRef.current
      if (!root) return
      const wanted = initialFocusRefRef.current?.current
      if (wanted) {
        wanted.focus()
        return
      }
      const firstField = root.querySelector<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
      )
      const fallback = root.querySelector<HTMLElement>('button:not([disabled])')
      ;(firstField ?? fallback)?.focus()
    })
    return () => {
      window.removeEventListener('keydown', handler)
      const at = openStack.indexOf(token)
      if (at !== -1) openStack.splice(at, 1)
      const prev = previouslyFocused.current
      if (prev instanceof HTMLElement) prev.focus()
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-[rgb(0_0_0/0.35)] p-6"
      style={{ zIndex: Z_MODAL }}
      role={role}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      onClick={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose()
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
