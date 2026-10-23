import { useEffect, useRef, type RefObject } from 'react'

/**
 * Focus handling shared by every modal surface — the Dialog shell and the
 * calendar drawer: a stack of open modals, a Tab trap for the top one, focus
 * into the modal on open and back out on close.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/**
 * Open modals, innermost last. Only the top one reacts to Tab (and Escape,
 * where the modal handles it here), so two open modals (e.g. the idle prompt
 * over the start modal) never fight over focus and one Escape closes one.
 */
interface StackEntry {
  /** Where focus goes back to when this modal closes. */
  restore: Element | null
  /** The panel, kept for the cleanup (the ref is gone by then). */
  root: HTMLElement | null
}
const openStack: StackEntry[] = []

/** How long a returned focus is watched for its target being removed. */
const RETURN_WATCH_MS = 5000

/**
 * Where focus lands when its target is gone: into the modal that is still
 * open (a delete confirmed over the calendar drawer — <main> would sit behind
 * it), else the view's main area (App gives it `tabIndex=-1`), so the next
 * Tab starts in the view instead of on <body>.
 */
function focusFallback(): void {
  const top = openStack[openStack.length - 1]?.root
  if (top?.isConnected) {
    const target = firstControl(top) ?? top
    if (target === top && !top.hasAttribute('tabindex')) top.tabIndex = -1
    target.focus()
    return
  }
  document.querySelector<HTMLElement>('main')?.focus()
}

/**
 * Give focus back to `target`, or to the fallback when it is gone. The target
 * may also go a moment later: a delete confirmed in a dialog closes the dialog
 * first and removes the row (with its delete key) only after the IPC round
 * trip. Until focus moves on by itself, a removal still sends it to the
 * fallback instead of <body>.
 */
function returnFocus(target: Element | null): void {
  if (!(target instanceof HTMLElement) || !target.isConnected) {
    focusFallback()
    return
  }
  target.focus()
  const stop = (): void => {
    observer.disconnect()
    clearTimeout(timer)
    document.removeEventListener('focusin', stop)
  }
  const observer = new MutationObserver(() => {
    if (target.isConnected) return
    stop()
    const active = document.activeElement
    if (active === null || active === document.body) focusFallback()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  const timer = setTimeout(stop, RETURN_WATCH_MS)
  document.addEventListener('focusin', stop)
}

/** The default first focus: the first form control, else the first button. */
function firstControl(root: HTMLElement): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
    ) ?? root.querySelector<HTMLElement>('button:not([disabled])')
  )
}

interface Options {
  /** Escape on the top modal. Absent: the modal handles Escape itself. */
  onEscape?: () => void
  /** What gets focus on opening. Default: the first form control, else the first button. */
  initialFocus?: () => HTMLElement | null | undefined
  /** Called once on opening with the modal's depth in the stack (0 = bottom). */
  onOpen?: (depth: number) => void
}

/**
 * Focus management for a modal whose panel is `containerRef`: on open it joins
 * the stack and moves focus inside; while it is the top one, Tab and
 * Shift+Tab stay inside; on close focus goes back to what was focused at
 * opening — only when this modal is the top one, and to the view's main area
 * when that element is gone.
 *
 * The element focused at opening is what comes back, so children must not
 * `autoFocus` (React focuses them before this effect reads it).
 *
 * The options are read through a ref, so a parent that re-renders every
 * second (Today's ticking timer) does not re-run the opening routine.
 */
export function useModalFocus(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  options: Options = {}
): void {
  const optionsRef = useRef(options)
  // eslint-disable-next-line react-hooks/refs -- #157: dauerhaft — hält die Optionen aktuell, ohne den Fokus-Effekt bei jedem Elternrender neu zu starten; der Compiler ist bewusst nicht aktiviert (Messung im Issue)
  optionsRef.current = options

  useEffect(() => {
    if (!open) return
    const entry: StackEntry = { restore: document.activeElement, root: containerRef.current }
    openStack.push(entry)
    optionsRef.current.onOpen?.(openStack.length - 1)

    const handler = (e: KeyboardEvent): void => {
      if (openStack[openStack.length - 1] !== entry) return
      if (e.key === 'Escape') {
        optionsRef.current.onEscape?.()
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
    // Move focus inside after mount so screen readers announce the modal.
    queueMicrotask(() => {
      const root = containerRef.current
      if (!root) return
      const wanted = optionsRef.current.initialFocus?.() ?? firstControl(root)
      wanted?.focus()
    })
    return () => {
      window.removeEventListener('keydown', handler)
      const at = openStack.indexOf(entry)
      if (at === -1) return
      const wasTop = at === openStack.length - 1
      openStack.splice(at, 1)
      if (!wasTop) {
        // A modal under another one closed (the quick note timing out under
        // the idle prompt): focus stays in the top one. A modal above that
        // would return focus into this one returns it to this one's origin.
        for (const above of openStack.slice(at)) {
          if (above.restore && entry.root?.contains(above.restore)) above.restore = entry.restore
        }
        return
      }
      returnFocus(entry.restore)
    }
  }, [open, containerRef])
}
