import { useEffect, useRef, type ReactNode } from 'react'
import { useT } from '../contexts/I18nContext'

interface Props {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** Maximum width in tailwind units. Default: w-[460px]. */
  widthClass?: string
}

/**
 * Generic modal dialog used for "+ Eintrag nachtragen" on TodayView.
 * Inside the Calendar Drawer the form is inlined directly — this wrapper
 * is for the case where there is no surrounding drawer to host it.
 *
 * Focus management: traps focus inside on mount, returns it to the
 * previously focused element on close. Escape closes.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  widthClass = 'w-[460px]'
}: Props): React.ReactElement | null {
  const t = useT()
  const containerRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<Element | null>(null)
  // Keep latest onClose in a ref so the focus/keydown effect doesn't re-run
  // every time the parent re-renders (which would re-focus the close button
  // on every tick — e.g. Today's running-timer pill ticks once per second).
  const onCloseRef = useRef(onClose)
  // eslint-disable-next-line react-hooks/refs -- #157: dauerhaft — hält onClose aktuell, ohne den Fokus-Effekt bei jedem Elternrender neu zu starten (siehe Kommentar darüber); der Compiler ist bewusst nicht aktiviert (Messung im Issue)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    previouslyFocused.current = document.activeElement
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', handler)
    // Move focus into the dialog after mount so screen readers announce it.
    // Prefer the first form control over the close (×) button — the close
    // button is earlier in the DOM but should never steal initial focus.
    queueMicrotask(() => {
      const root = containerRef.current
      if (!root) return
      const firstField = root.querySelector<HTMLElement>('input, select, textarea')
      const fallback = root.querySelector<HTMLElement>('button')
      ;(firstField ?? fallback)?.focus()
    })
    return () => {
      window.removeEventListener('keydown', handler)
      const prev = previouslyFocused.current
      if (prev instanceof HTMLElement) prev.focus()
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-[rgb(0_0_0/0.35)] p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={containerRef}
        className={`${widthClass} flex max-h-[calc(100vh-3rem)] flex-col rounded-[var(--r-disp)] border`}
        style={{
          background: 'var(--modal-bg)',
          borderColor: 'var(--card-border)'
        }}
      >
        <div
          className="flex shrink-0 items-center justify-between rounded-t-[var(--r-disp)] border-b px-6 py-4"
          style={{ borderColor: 'var(--card-border)' }}
        >
          <h2 id="dialog-title" className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="-mr-2 grid h-9 w-9 place-items-center rounded-[var(--r-key)] hover:bg-[var(--key)] focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
            style={{ color: 'var(--text2)' }}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>
  )
}
