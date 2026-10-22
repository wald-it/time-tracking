import { useEffect, useRef } from 'react'
import type { Client, Entry } from '../../../shared/types'
import { useT } from '../contexts/I18nContext'
import { DayDetails } from './kalender/DayDetails'

interface Props {
  open: boolean
  /** ISO date YYYY-MM-DD (LOCAL) the drawer is showing entries for. */
  dateISO: string
  /** Entries for this day (caller filters from getByMonth). */
  entries: Entry[]
  clients: Client[]
  onClose: () => void
}

/**
 * Right-side overlay drawer for a single day in CalendarView — the fallback
 * below 1100 px window width (HANDOFF §4.2.4). Wide windows show the same
 * content in the persistent day panel instead (`DayPanel`).
 *
 * The drawer only owns the overlay: backdrop, dialog semantics, initial focus
 * and focus restore on close. Everything inside — list, tag filter, inline
 * edit, backfill, delete with undo toast — is `DayDetails`. Escape first
 * cancels what is open in there (edit → backfill → delete question) and only
 * then closes the drawer, via `onEscape`.
 */
export function CalendarDrawer({
  open,
  dateISO,
  entries,
  clients,
  onClose
}: Props): React.ReactElement | null {
  const t = useT()
  const drawerRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement
    queueMicrotask(() => {
      drawerRef.current?.querySelector<HTMLElement>('button, [tabindex]')?.focus()
    })
    return () => {
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [open])

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-30 bg-[rgb(0_0_0/0.35)]"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Drawer */}
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('drawer.aria', { date: formatHumanDate(dateISO) })}
        className="fixed right-0 top-0 z-40 flex h-screen w-96 max-w-full flex-col border-l border-[var(--line)] bg-[var(--bg)]"
      >
        <div className="flex shrink-0 justify-end px-3 pt-3">
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="grid h-11 w-11 place-items-center rounded-[var(--r-key)] text-[var(--ink3)] hover:bg-[var(--key)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
          >
            <CloseGlyph />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <DayDetails dateISO={dateISO} entries={entries} clients={clients} onEscape={onClose} />
        </div>
      </aside>
    </>
  )
}

function CloseGlyph(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

function formatHumanDate(dateISO: string): string {
  // dateISO is YYYY-MM-DD (LOCAL); show as DD.MM.YYYY
  const [y, m, d] = dateISO.split('-')
  return `${d}.${m}.${y}`
}
