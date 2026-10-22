import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { Client, DashboardSummary, Project } from '../../../../shared/types'
import { useUiPrefsStore } from '../../store/uiPrefsStore'
import { useT } from '../../contexts/I18nContext'
import {
  buildRows,
  initialIndex,
  mainAction,
  moveIndex,
  openDirection,
  type QuickStartRow,
  type RunningPair
} from './quickStartList'

/**
 * B1 switch (HANDOFF §6): while a timer runs, a click on a preset key (or a
 * row of its project list) stops the running entry and starts the chosen
 * pair — one main-process switch (`useTimer.switchTo`). `false` brings back
 * the old lock: keys, ▾ segments and list rows are `disabled` while a timer
 * runs, and the hint stays the idle one.
 */
export const QUICKSTART_SWITCH_WHILE_RUNNING = true

/** How many preset keys the section shows (topClients30d delivers up to 5). */
const KEY_COUNT = 3
/** Press-and-hold on the main area opens the list after this long (#96). */
const HOLD_MS = 300
/** A pointer that wanders further than this while held is a drag, not a hold. */
const HOLD_SLOP_PX = 8

/**
 * Heute — "Schnellstart": the instrument's preset keys (HANDOFF §3.11, §4.1).
 *
 * One split key per frequent client: the main area starts (or, while a timer
 * runs, switches to) the client's last project; the ▾ segment, a 300 ms
 * press-and-hold or a right-click opens the project list underneath. Only one
 * list is open at a time.
 */
export function QuickStart({
  topClients,
  running,
  clientsById,
  projectsById,
  onStart,
  onSwitch,
  switchWhileRunning = QUICKSTART_SWITCH_WHILE_RUNNING
}: {
  topClients: DashboardSummary['topClients30d']
  /** The running timer's pair, or null when idle. */
  running: RunningPair | null
  clientsById: Map<number, Client>
  projectsById: Map<number, Project>
  /** Idle: start this pair. */
  onStart: (clientId: number, projectId: number | null) => void
  /** A timer runs: switch to this pair (stop + start at one instant). */
  onSwitch: (clientId: number, projectId: number | null) => void
  /**
   * The B1 switch. Callers leave it at its default, the constant above; it
   * is a prop only so the test can pin the `false` state.
   */
  switchWhileRunning?: boolean
}): React.JSX.Element | null {
  const t = useT()
  const headingId = useId()
  const [openClientId, setOpenClientId] = useState<number | null>(null)

  // Inactive clients never take a slot — skipped before the cut, so the
  // fourth client moves up instead of leaving a dead key. (The summary
  // already leaves them out; this catches a client deactivated since.)
  const keys = topClients
    .filter((c) => clientsById.get(c.client_id)?.active !== 0)
    .slice(0, KEY_COUNT)
  // No frequent clients → no section (HANDOFF §4.1).
  if (keys.length === 0) return null

  const locked = running !== null && !switchWhileRunning
  const hint =
    running !== null && switchWhileRunning
      ? t('today.quickstart.hintRunningSwitch')
      : t('today.quickstart.hintIdlePresets')

  return (
    // 32px under the hero: the view's section gap is 48px.
    <section aria-labelledby={headingId} className="-mt-4 border-t-2 border-[var(--ink)] pt-[14px]">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 id={headingId} className="m-0 text-[var(--ink2)]" style={LEGEND}>
            {t('today.quickstart.legend')}
          </h2>
          <span className="font-num text-[11px] text-[var(--ink3)]">
            {t('today.quickstart.meta')}
          </span>
        </div>
        <span className="text-xs text-[var(--ink3)]">{hint}</span>
      </div>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))' }}
      >
        {keys.map((c) => (
          <PresetKey
            key={c.client_id}
            clientId={c.client_id}
            name={c.name}
            color={c.color}
            seconds={c.seconds}
            lastProjectId={c.last_project_id}
            projectsById={projectsById}
            running={running}
            locked={locked}
            open={openClientId === c.client_id}
            onOpenChange={(next) =>
              setOpenClientId((cur) => (next ? c.client_id : cur === c.client_id ? null : cur))
            }
            onStart={onStart}
            onSwitch={onSwitch}
          />
        ))}
      </div>
    </section>
  )
}

function PresetKey({
  clientId,
  name,
  color,
  seconds,
  lastProjectId,
  projectsById,
  running,
  locked,
  open,
  onOpenChange,
  onStart,
  onSwitch
}: {
  clientId: number
  name: string
  /** Client colour — also the fallback for projects without one. */
  color: string
  seconds: number
  lastProjectId: number | null
  projectsById: Map<number, Project>
  running: RunningPair | null
  /** B1 switch off and a timer runs: everything disabled. */
  locked: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onStart: (clientId: number, projectId: number | null) => void
  onSwitch: (clientId: number, projectId: number | null) => void
}): React.JSX.Element {
  const t = useT()
  const showProjectNumber = useUiPrefsStore((s) => s.showProjectNumber)
  const listId = useId()
  const [holding, setHolding] = useState(false)
  const [direction, setDirection] = useState<'down' | 'up'>('down')
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdOriginRef = useRef<{ x: number; y: number } | null>(null)
  // Set when a hold opened the list: the release that follows is not a click.
  const holdOpenedRef = useRef(false)

  const rows = buildRows([...projectsById.values()], clientId, lastProjectId, running)
  const hasProjects = rows.length > 1
  const runsHere = running !== null && running.clientId === clientId
  const timerRuns = running !== null

  const projectLabel = (projectId: number | null): string => {
    if (projectId === null) return t('today.quickstart.noProject')
    const p = projectsById.get(projectId)
    if (!p) return ''
    return showProjectNumber && p.external_project_number
      ? `${p.name} [${p.external_project_number}]`
      : p.name
  }
  const squareColor = (projectId: number | null): string =>
    (projectId !== null && projectsById.get(projectId)?.color) || color

  // The sub-line shows what runs here, otherwise what a click starts.
  const shownProjectId = runsHere && running ? running.projectId : lastProjectId
  const subLine = shownProjectId === null && !runsHere ? '' : projectLabel(shownProjectId)

  const action = mainAction(clientId, lastProjectId, running)
  const mainLabel =
    action.kind === 'none'
      ? t('today.quickstart.alreadyRunning', { name: `${name}, ${projectLabel(lastProjectId)}` })
      : t(action.kind === 'switch' ? 'today.quickstart.switchTo' : 'today.quickstart.startFor', {
          name: lastProjectId === null ? name : `${name}, ${projectLabel(lastProjectId)}`
        })

  function cancelHold(): void {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
    holdOriginRef.current = null
    setHolding(false)
  }

  useEffect(() => cancelHold, [])

  function setOpen(next: boolean): void {
    if (next && (!hasProjects || locked)) return
    onOpenChange(next)
  }

  function handlePointerDown(e: React.PointerEvent): void {
    holdOpenedRef.current = false
    if (e.button !== 0 || locked || !hasProjects || open) return
    holdOriginRef.current = { x: e.clientX, y: e.clientY }
    setHolding(true)
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null
      holdOriginRef.current = null
      holdOpenedRef.current = true
      setHolding(false)
      setOpen(true)
    }, HOLD_MS)
  }

  function handlePointerMove(e: React.PointerEvent): void {
    const o = holdOriginRef.current
    if (!o) return
    if (Math.hypot(e.clientX - o.x, e.clientY - o.y) > HOLD_SLOP_PX) cancelHold()
  }

  function handleMainClick(): void {
    // The release after a hold that opened the list is not a click.
    if (holdOpenedRef.current) {
      holdOpenedRef.current = false
      return
    }
    cancelHold()
    if (locked) return
    if (action.kind === 'start') onStart(clientId, action.projectId)
    else if (action.kind === 'switch') onSwitch(clientId, action.projectId)
  }

  function pick(row: QuickStartRow): void {
    // The LÄUFT row has no action: no restart, no stop.
    if (row.isRunning || locked) return
    // Back to ▾, like Esc: the chosen row unmounts with the list, and focus
    // would otherwise fall to <body>.
    closeToToggle()
    if (timerRuns) onSwitch(clientId, row.projectId)
    else onStart(clientId, row.projectId)
  }

  function focusRow(i: number): void {
    rowRefs.current[i]?.focus()
  }

  function closeToToggle(): void {
    onOpenChange(false)
    toggleRef.current?.focus()
  }

  function handleListKeyDown(e: React.KeyboardEvent): void {
    const current = rowRefs.current.findIndex((el) => el === document.activeElement)
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault()
        focusRow(moveIndex(current < 0 ? 0 : current, e.key === 'ArrowDown' ? 1 : -1, rows.length))
        break
      case 'Home':
        e.preventDefault()
        focusRow(0)
        break
      case 'End':
        e.preventDefault()
        focusRow(rows.length - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (current >= 0) pick(rows[current])
        break
      case 'Escape':
        e.preventDefault()
        closeToToggle()
        break
      case 'Tab':
        // Tab leaves the menu and closes it; the focus moves on as usual.
        onOpenChange(false)
        break
    }
  }

  // On open: pick the direction (measured against the scroll container the
  // key sits in, not the window), then focus "ZULETZT".
  useLayoutEffect(() => {
    if (!open) return
    const root = rootRef.current
    const list = listRef.current
    if (root && list) {
      const key = root.getBoundingClientRect()
      const box = scrollContainerOf(root)?.getBoundingClientRect() ?? {
        top: 0,
        bottom: window.innerHeight
      }
      setDirection(openDirection(box.bottom - key.bottom, key.top - box.top, list.offsetHeight))
    }
    focusRow(initialIndex(rows))
    // Only on opening — re-measuring on every render would flip mid-use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // While open: a click outside or a window resize closes the list.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) onOpenChange(false)
    }
    const onResize = (): void => onOpenChange(false)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', onResize)
    }
  }, [open, onOpenChange])

  const up = direction === 'up'
  // Open: the key and the list share one 1px ink frame — the key's corners
  // on the list side square, no keycap edge (HANDOFF §3.11).
  const keyFrame: React.CSSProperties = open
    ? {
        borderColor: 'var(--ink)',
        borderRadius: up ? '0 0 4px 4px' : '4px 4px 0 0',
        boxShadow: 'none'
      }
    : { borderColor: 'var(--key-edge)', boxShadow: 'var(--edge-key)' }

  return (
    <div ref={rootRef} className="relative">
      <div
        className={`relative flex items-stretch border bg-[var(--key)] ${open ? 'z-30' : 'key-hover rounded-[var(--r-key)]'}`}
        style={keyFrame}
      >
        <button
          type="button"
          disabled={locked}
          aria-label={mainLabel}
          title={hasProjects ? t('today.quickstart.holdHint') : mainLabel}
          onClick={handleMainClick}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={() => {
            if (holdTimerRef.current) cancelHold()
            // The click that follows this release (same task) is swallowed by
            // handleMainClick; clear the flag after it, so a release that
            // produces no click cannot eat the next real one.
            if (holdOpenedRef.current) {
              setTimeout(() => {
                holdOpenedRef.current = false
              }, 0)
            }
          }}
          onPointerLeave={() => {
            holdOpenedRef.current = false
            cancelHold()
          }}
          onPointerCancel={() => {
            holdOpenedRef.current = false
            cancelHold()
          }}
          onContextMenu={(e) => {
            if (hasProjects && !locked) {
              e.preventDefault()
              cancelHold()
              setOpen(true)
            }
          }}
          className="flex min-h-[64px] min-w-0 flex-1 items-center gap-[14px] bg-transparent text-left text-[var(--ink)] select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
          style={{ padding: '0 12px 0 16px' }}
        >
          <span
            aria-hidden="true"
            className="h-3 w-3 flex-none"
            style={{ background: squareColor(shownProjectId) }}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-semibold">{name}</span>
            {subLine && <span className="truncate text-xs text-[var(--ink2)]">{subLine}</span>}
          </span>
          {runsHere ? (
            <span className="flex flex-none items-center gap-1.5">
              <span aria-hidden="true" className="tt-blink h-[7px] w-[7px] bg-[var(--sig)]" />
              <span className="text-[var(--ink)]" style={{ ...LEGEND, fontSize: 10 }}>
                {t('today.quickstart.running')}
              </span>
            </span>
          ) : (
            <span className="font-num flex-none text-xs text-[var(--ink2)]">
              {formatHMM(seconds)}
            </span>
          )}
        </button>
        {hasProjects && (
          <button
            ref={toggleRef}
            type="button"
            disabled={locked}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-label={t('today.quickstart.chooseProjectFor', { name })}
            onClick={() => setOpen(!open)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setOpen(true)
              } else if (e.key === 'Escape' && open) {
                e.preventDefault()
                onOpenChange(false)
              }
            }}
            className="flex w-12 flex-none items-center justify-center border-l border-[var(--key-edge)] bg-transparent text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg
              width="12"
              height="8"
              viewBox="0 0 12 8"
              fill="none"
              aria-hidden="true"
              style={{ transform: open ? 'rotate(180deg)' : undefined }}
            >
              <path d="M1 1.5l5 5 5-5" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </button>
        )}
        {/* Hold feedback: a 3px ink bar fills the key's bottom edge. */}
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute bottom-0 left-0 h-[3px] bg-[var(--ink)] ${holding ? 'transition-[width] duration-300 ease-linear motion-reduce:transition-none' : ''}`}
          style={{ width: holding ? '100%' : '0%' }}
        />
      </div>
      {open && (
        <div
          ref={listRef}
          id={listId}
          role="menu"
          aria-label={t('today.quickstart.chooseProjectFor', { name })}
          onKeyDown={handleListKeyDown}
          className={`absolute right-0 left-0 z-30 border border-[var(--ink)] bg-[var(--key)] ${up ? 'bottom-full rounded-t-[4px] border-b-0' : 'top-full rounded-b-[4px] border-t-0'}`}
        >
          <div
            className="border-t border-[var(--line)] text-[var(--ink3)]"
            style={{ ...LEGEND, fontSize: 10, padding: '10px 16px 8px' }}
          >
            {t('today.quickstart.chooseProject')}
          </div>
          {rows.map((row, i) => {
            const label = projectLabel(row.projectId)
            const pair = `${name}, ${label}`
            return (
              <button
                key={row.key}
                ref={(el) => {
                  rowRefs.current[i] = el
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={locked}
                aria-disabled={row.isRunning || undefined}
                aria-label={
                  row.isRunning
                    ? t('today.quickstart.alreadyRunning', { name: pair })
                    : t(timerRuns ? 'today.quickstart.switchTo' : 'today.quickstart.startFor', {
                        name: pair
                      })
                }
                onClick={() => pick(row)}
                className={`group flex min-h-[44px] w-full items-center gap-3 bg-transparent text-left hover:bg-[var(--bg)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50 ${row.isRunning ? 'cursor-default' : ''}`}
                style={{
                  padding: '0 14px 0 16px',
                  borderTop: row.isNoProject ? '1px dashed var(--line)' : '1px solid var(--line)'
                }}
              >
                <span
                  aria-hidden="true"
                  className="h-2 w-2 flex-none"
                  style={
                    row.isNoProject
                      ? { boxShadow: 'inset 0 0 0 1px var(--ink3)' }
                      : { background: squareColor(row.projectId) }
                  }
                />
                <span
                  className={`min-w-0 flex-1 truncate text-sm ${row.isRunning ? 'font-semibold' : ''} ${row.isNoProject ? 'text-[var(--ink2)]' : 'text-[var(--ink)]'}`}
                >
                  {label}
                </span>
                {row.isRunning ? (
                  <span className="flex flex-none items-center gap-1.5">
                    <span aria-hidden="true" className="tt-blink h-[7px] w-[7px] bg-[var(--sig)]" />
                    <span className="text-[var(--ink)]" style={{ ...LEGEND, fontSize: 10 }}>
                      {t('today.quickstart.running')}
                    </span>
                  </span>
                ) : row.isLast ? (
                  <span
                    className="flex-none border border-[var(--line)] text-[var(--ink2)]"
                    style={{ ...LEGEND, fontSize: 9, padding: '2px 5px' }}
                  >
                    {t('today.quickstart.lastUsed')}
                  </span>
                ) : (
                  <span
                    aria-hidden="true"
                    className="font-num flex-none text-[11px] text-[var(--ink3)] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                  >
                    {t(
                      timerRuns ? 'today.quickstart.actionSwitch' : 'today.quickstart.actionStart'
                    )}
                  </span>
                )}
              </button>
            )
          })}
          <div
            aria-hidden="true"
            className="font-num border-t border-[var(--line)] text-[11px] text-[var(--ink3)]"
            style={{ padding: '9px 16px 10px' }}
          >
            {t('today.quickstart.listHelp')}
          </div>
        </div>
      )}
    </div>
  )
}

/** The nearest ancestor that scrolls vertically, or null (then: the window). */
function scrollContainerOf(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement
  while (node) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
    node = node.parentElement
  }
  return null
}

/** Legend style (HANDOFF §2.2): Archivo 11/600, caps, .14em, expanded. */
const LEGEND: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  fontStretch: '118%'
}

/** `H:MM` — hours over 30 days, as in the mockup (`48:20`). */
function formatHMM(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}`
}
