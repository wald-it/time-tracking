import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Client, DashboardSummary, Project } from '../../../../shared/types'
import { useUiPrefsStore } from '../../store/uiPrefsStore'
import { useT } from '../../contexts/I18nContext'
import { fanShift } from './fanShift'

/**
 * Heute — "Schnellstart" side column (HANDOFF §3.11, §4.1).
 *
 * Moved out of `TodayView` (`QuickStartRow` / `QuickStartPill`) with the same
 * behaviour: a click starts the client with its last project, press-and-hold
 * (300 ms) or right-click opens the project fan (#96), and the keys stay
 * disabled while a timer runs. Switching on click while running is B1 and
 * not part of this PR; the fan keeps its current look until B1 as well.
 */
export function QuickStart({
  topClients,
  running,
  clientsById,
  projectsById,
  onStart
}: {
  topClients: DashboardSummary['topClients30d']
  running: boolean
  clientsById: Map<number, Client>
  projectsById: Map<number, Project>
  onStart: (clientId: number, projectId: number | null) => void
}): React.JSX.Element | null {
  const t = useT()
  const headingId = useId()
  // Same as the old QuickStartRow: no frequent clients, no section.
  if (topClients.length === 0) return null
  return (
    <aside
      aria-labelledby={headingId}
      className="border-t-2 border-[var(--ink)] pt-[14px]"
      style={{ flex: '1 1 300px' }}
    >
      <div className="mb-[10px] flex min-h-[44px] items-baseline justify-between gap-[10px]">
        <h2 id={headingId} className="m-0 text-[var(--ink2)]" style={LEGEND}>
          {t('today.quickstart.legend')}
        </h2>
        <span className="font-num text-[11px] text-[var(--ink3)]">
          {t('today.quickstart.meta')}
        </span>
      </div>
      <div className="flex flex-col gap-[10px]">
        {topClients.map((c) => (
          <QuickStartKey
            key={c.client_id}
            clientId={c.client_id}
            name={c.name}
            color={c.color}
            seconds={c.seconds}
            lastProjectId={c.last_project_id}
            projectsById={projectsById}
            clientsById={clientsById}
            disabled={running}
            onStart={onStart}
          />
        ))}
      </div>
      <p className="mt-3 text-xs leading-normal text-[var(--ink3)]">
        {running ? t('today.quickstart.hintRunningLocked') : t('today.quickstart.hintIdle')}
      </p>
    </aside>
  )
}

/**
 * Compute clock-face ring positions for N project items.
 * Convention: angle 0° = 12 o'clock, positive clockwise. "Kein Projekt" is
 * pinned at 180° (6 o'clock) by the caller — not included here.
 *
 *   N=1 → [0°]                           (12)
 *   N=2 → [-60°, +60°]                   (10, 2 — bewusst nicht ±90°)
 *   N=3 → [-90°, 0°, +90°]               (9, 12, 3)
 *   N≥3 → step = 180/(N-1), end-inclusive over upper half
 */
function getRingPositions(N: number, R: number): Array<{ x: number; y: number; angle: number }> {
  if (N <= 0) return []
  if (N === 1) return [{ x: 0, y: -R, angle: 0 }]
  const angles: number[] =
    N === 2 ? [-60, 60] : Array.from({ length: N }, (_, i) => -90 + i * (180 / (N - 1)))
  return angles.map((a) => {
    const rad = (a * Math.PI) / 180
    return { x: R * Math.sin(rad), y: -R * Math.cos(rad), angle: a }
  })
}

type RingItem = {
  key: string
  id: number | null
  name: string
  externalNumber: string | null
  color: string
  pos: { x: number; y: number; angle: number }
  isNoProject: boolean
}

function QuickStartKey({
  clientId,
  name,
  color,
  seconds,
  lastProjectId,
  projectsById,
  clientsById,
  disabled,
  onStart
}: {
  clientId: number
  name: string
  /** Client colour — also the fan's fallback for projects without one. */
  color: string
  seconds: number
  lastProjectId: number | null
  projectsById: Map<number, Project>
  clientsById: Map<number, Client>
  disabled: boolean
  onStart: (clientId: number, projectId: number | null) => void
}): React.JSX.Element {
  const t = useT()
  const showProjectNumber = useUiPrefsStore((s) => s.showProjectNumber)
  const [holdProgress, setHoldProgress] = useState(0)
  const [fanOpen, setFanOpen] = useState(false)
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  // Sideways shift that keeps the open fan inside the window — the key now
  // sits in the right-hand column (Messinstrument), and a 180 px ring around
  // it reaches past the edge at 1000–1200 px.
  const [shiftX, setShiftX] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isPressingRef = useRef(false)
  const startTimeRef = useRef(0)

  const stillActive = clientsById.get(clientId)?.active === 1
  const lastProject = lastProjectId != null ? projectsById.get(lastProjectId) : undefined

  const clientProjects = useMemo(
    () =>
      Array.from(projectsById.values()).filter((p) => p.client_id === clientId && p.active === 1),
    [projectsById, clientId]
  )
  const hasProjects = clientProjects.length > 0

  const ring = useMemo<{
    items: RingItem[]
    R: number
    projectCount: number
    delays: Map<string, number>
  } | null>(() => {
    const N = clientProjects.length
    if (N === 0) return null
    // Constant ring radius — gives every fan the generous spacing of the
    // N=8 case. Dynamic radii made small N (2, 3) feel cramped because items
    // ended up too close to the pill and overlapping adjacent UI cards.
    const R = 180
    // "Kein Projekt" sits on the 6-o'clock direction at a *fixed* short
    // distance — it's a secondary action, not part of the project ring.
    // Decoupling it from R keeps it close to the pill regardless of N
    // and prevents it from landing in the recent-list area.
    const NO_PROJECT_OFFSET = 60
    const positions = getRingPositions(N, R)
    const projectItems: RingItem[] = clientProjects.map((p, i) => ({
      key: `p${p.id}`,
      id: p.id,
      name: p.name,
      externalNumber: p.external_project_number ?? null,
      color: p.color || color,
      pos: positions[i],
      isNoProject: false
    }))
    const noProjectItem: RingItem = {
      key: 'none',
      id: null,
      name: t('today.quickstart.noProject'),
      externalNumber: null,
      color: 'var(--text3)',
      pos: { x: 0, y: NO_PROJECT_OFFSET, angle: 180 },
      isNoProject: true
    }
    const items: RingItem[] = [...projectItems, noProjectItem]
    // Stagger: items closest to 12 o'clock fade in first, edges + 6 o'clock last.
    const sorted = [...items].sort((a, b) => Math.abs(a.pos.angle) - Math.abs(b.pos.angle))
    const delays = new Map<string, number>(sorted.map((it, i) => [it.key, i * 30]))
    return { items, R, projectCount: N, delays }
  }, [clientProjects, color, t])

  function clearHoldTimer(): void {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current)
      progressIntervalRef.current = null
    }
  }

  function handlePointerDown(e: React.PointerEvent): void {
    if (disabled || !stillActive || fanOpen) return
    e.preventDefault()
    isPressingRef.current = true
    if (!ring) return
    startTimeRef.current = Date.now()
    const HOLD_MS = 300
    progressIntervalRef.current = setInterval(() => {
      setHoldProgress(Math.min((Date.now() - startTimeRef.current) / HOLD_MS, 0.999))
    }, 16)
    holdTimerRef.current = setTimeout(() => {
      clearHoldTimer()
      setHoldProgress(0)
      setFanOpen(true)
    }, HOLD_MS)
  }

  function handlePointerUp(): void {
    const wasPressing = isPressingRef.current
    isPressingRef.current = false
    clearHoldTimer()
    setHoldProgress(0)
    if (!wasPressing || fanOpen) return
    if (!disabled && stillActive) {
      onStart(clientId, lastProjectId ?? null)
    }
  }

  function handlePointerLeave(): void {
    if (!fanOpen) {
      isPressingRef.current = false
      clearHoldTimer()
      setHoldProgress(0)
    }
  }

  // Halo follows the outermost items — 120° arc (10→12→2) for N=2,
  // full 180° arc (9→12→3) for N≥3. Derived from actual item positions.
  const arcInfo = (() => {
    if (!ring || ring.projectCount < 2) return null
    const R = ring.R
    const projItems = ring.items.filter((it) => !it.isNoProject)
    const firstAngle = projItems[0].pos.angle
    const lastAngle = projItems[projItems.length - 1].pos.angle
    const arcLen = (R * ((lastAngle - firstAngle) * Math.PI)) / 180
    const x1 = (R * Math.sin((firstAngle * Math.PI) / 180)).toFixed(3)
    const y1 = (-R * Math.cos((firstAngle * Math.PI) / 180)).toFixed(3)
    const x2 = (R * Math.sin((lastAngle * Math.PI) / 180)).toFixed(3)
    const y2 = (-R * Math.cos((lastAngle * Math.PI) / 180)).toFixed(3)
    return { d: `M ${x1} ${y1} A ${R} ${R} 0 0 1 ${x2} ${y2}`, arcLen }
  })()
  const svgPad = 24

  // Keycap edge (§2.3) plus, while holding, the growing ring in the client
  // colour that the old pill drew (unchanged until B1).
  const keyShadow =
    !fanOpen && holdProgress > 0
      ? `inset 0 -2px 0 var(--key-edge), 0 0 0 ${(holdProgress * 3).toFixed(1)}px ${color}50`
      : 'inset 0 -2px 0 var(--key-edge)'

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!fanOpen || !root) {
      setShiftX(0)
      return
    }
    const rect = root.getBoundingClientRect()
    const items = [...root.querySelectorAll<HTMLElement>('[data-fan-x]')].map((el) => ({
      x: Number(el.dataset.fanX),
      width: el.offsetWidth
    }))
    setShiftX(fanShift(rect.left + rect.width / 2, items, window.innerWidth))
  }, [fanOpen, ring])

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      {fanOpen && (
        <div
          className="qs-backdrop"
          style={{ position: 'fixed', inset: 0, zIndex: 49 }}
          onPointerDown={() => {
            setFanOpen(false)
            setHoveredKey(null)
          }}
        />
      )}
      {fanOpen && ring && (
        <>
          <svg
            width={2 * (ring.R + svgPad)}
            height={2 * (ring.R + svgPad)}
            viewBox={`${-(ring.R + svgPad)} ${-(ring.R + svgPad)} ${2 * (ring.R + svgPad)} ${2 * (ring.R + svgPad)}`}
            style={
              {
                position: 'absolute',
                left: `calc(50% + ${shiftX}px)`,
                top: '50%',
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'none',
                zIndex: 50,
                overflow: 'visible',
                ['--qs-ring-circ' as string]: `${arcInfo ? arcInfo.arcLen.toFixed(2) : '0'}`
              } as React.CSSProperties
            }
            aria-hidden="true"
          >
            {arcInfo && (
              <path
                className="qs-ring-arc"
                d={arcInfo.d}
                stroke={color}
                strokeOpacity={0.35}
                style={{ strokeDasharray: arcInfo.arcLen }}
              />
            )}
            <defs>
              {ring.items.map((item) => {
                const strokeColor = item.isNoProject ? 'var(--text3)' : item.color
                return (
                  <linearGradient
                    key={`grad-${item.key}`}
                    id={`qs-beam-${item.key}`}
                    gradientUnits="userSpaceOnUse"
                    x1={0}
                    y1={0}
                    x2={item.pos.x}
                    y2={item.pos.y}
                  >
                    <stop offset="0%" stopColor={strokeColor} stopOpacity={0} />
                    <stop offset="100%" stopColor={strokeColor} stopOpacity={1} />
                  </linearGradient>
                )
              })}
            </defs>
            {ring.items.map((item) => {
              const isHovered = hoveredKey === item.key
              return (
                <line
                  key={item.key}
                  x1={0}
                  y1={0}
                  x2={item.pos.x}
                  y2={item.pos.y}
                  stroke={`url(#qs-beam-${item.key})`}
                  strokeWidth={1}
                  strokeOpacity={isHovered ? 0.5 : 0}
                  style={{ transition: 'stroke-opacity 120ms ease' }}
                />
              )
            })}
          </svg>
          {ring.items.map((item) => {
            const delay = ring.delays.get(item.key) ?? 0
            return (
              <button
                key={item.key}
                data-fan-x={item.pos.x}
                type="button"
                onClick={() => {
                  setFanOpen(false)
                  setHoveredKey(null)
                  onStart(clientId, item.id)
                }}
                onMouseEnter={() => setHoveredKey(item.key)}
                onMouseLeave={() => setHoveredKey(null)}
                className={`qs-fan-item flex items-center gap-1.5 rounded-[var(--r-key)] ${item.isNoProject ? 'border-dashed' : ''} border px-2.5 py-1 text-xs font-medium transition-colors hover:border-[var(--ink)]`}
                style={
                  {
                    position: 'absolute',
                    left: `calc(50% + ${item.pos.x + shiftX}px)`,
                    top: `calc(50% + ${item.pos.y}px)`,
                    zIndex: 51,
                    whiteSpace: 'nowrap',
                    background: 'var(--modal-bg)',
                    borderColor: item.isNoProject ? 'var(--text3)' : 'var(--card-border)',
                    color: item.isNoProject ? 'var(--text3)' : 'var(--text)',
                    animationDelay: `${delay}ms`,
                    ['--qs-dx' as string]: `${(-item.pos.x).toFixed(2)}px`,
                    ['--qs-dy' as string]: `${(-item.pos.y).toFixed(2)}px`
                  } as React.CSSProperties
                }
              >
                {!item.isNoProject && (
                  <span
                    className="h-1.5 w-1.5 flex-shrink-0 rounded-[var(--r-fine)]"
                    style={{ backgroundColor: item.color }}
                  />
                )}
                {item.name}
                {!item.isNoProject && showProjectNumber && item.externalNumber
                  ? ` [${item.externalNumber}]`
                  : ''}
              </button>
            )
          })}
        </>
      )}
      <button
        type="button"
        disabled={disabled || !stillActive}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onContextMenu={(e) => {
          if (hasProjects && !disabled && stillActive) {
            e.preventDefault()
            setFanOpen(true)
          }
        }}
        className={`key-hover flex min-h-[64px] w-full items-center gap-[14px] rounded-[var(--r-key)] border bg-[var(--key)] text-left text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 ${fanOpen ? 'qs-pill-pulse-active' : ''}`}
        style={
          {
            padding: '0 12px 0 16px',
            borderColor: fanOpen || holdProgress > 0 ? color : 'var(--key-edge)',
            boxShadow: fanOpen ? undefined : keyShadow,
            transform:
              holdProgress > 0 ? `scale(${(1 - holdProgress * 0.04).toFixed(4)})` : undefined,
            userSelect: 'none',
            // When the fan is open, the backdrop sits at z-49.
            // Lift the key above it so the key itself stays crisp.
            position: fanOpen ? 'relative' : undefined,
            zIndex: fanOpen ? 51 : undefined,
            ['--qs-pill-color' as string]: color
          } as React.CSSProperties
        }
        title={
          stillActive
            ? hasProjects
              ? t('today.quickstart.holdHint')
              : t('today.quickstart.startFor', { name })
            : t('today.quickstart.clientInactive')
        }
      >
        <span
          aria-hidden="true"
          className="h-3 w-3 flex-none"
          style={{
            // The key starts the last project, so its square shows that colour.
            background: (lastProjectId != null && projectsById.get(lastProjectId)?.color) || color
          }}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold">{name}</span>
          {lastProject && (
            <span className="truncate text-xs text-[var(--ink2)]">
              {lastProject.name}
              {showProjectNumber && lastProject.external_project_number
                ? ` [${lastProject.external_project_number}]`
                : ''}
            </span>
          )}
        </span>
        <span className="font-num text-xs text-[var(--ink2)]">{formatHMM(seconds)}</span>
        <span
          aria-hidden="true"
          className="flex h-8 w-8 flex-none items-center justify-center border border-[var(--key-edge)]"
          style={{ borderRadius: 3 }}
        >
          <svg width="9" height="10" viewBox="0 0 9 10">
            <path d="M0 0l9 5-9 5z" fill="currentColor" />
          </svg>
        </span>
      </button>
    </div>
  )
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
