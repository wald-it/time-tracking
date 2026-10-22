import { useEffect, useMemo, useRef, useState } from 'react'
import type { Client, DashboardSummary, Entry, Project } from '../../../shared/types'
import { useEntriesStore } from '../store/entriesStore'
import { useProjectsStore } from '../store/projectsStore'
import { useUiPrefsStore } from '../store/uiPrefsStore'
import { useToastStore } from '../store/toastStore'
import { useTimer, formatDuration } from '../hooks/useTimer'
import { Dialog } from '../components/Dialog'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { EntryEditForm } from '../components/EntryEditForm'
import * as Icons from '../components/Icons'
import type { TFunction } from '../contexts/I18nContext'
import { useT } from '../contexts/I18nContext'
import { useRounding } from '../contexts/RoundingContext'
import { roundDuration } from '../../../shared/duration'

/**
 * `Heute` view — the new default tab in v1.2 (D1).
 *
 * Layout:
 *   - Top: compact `Aktiver Timer` pill (or "Kein Timer läuft").
 *   - Two stat cards: today + this week (HH:MM, no seconds).
 *   - Quick-Start row: top-3 frequent clients of the last 30d.
 *   - Recent list: last 5 entries with edit / delete icons.
 *   - "+ Eintrag nachtragen" button → opens the edit form in a Dialog.
 *
 * Refresh strategy (E1): re-fetch on mount, on `entriesStore.version`
 * change (any mutation in the app bumps it), and when the running entry
 * starts/stops. No polling.
 */
export default function TodayView(): React.JSX.Element {
  const t = useT()
  const { roundMinutes } = useRounding()
  const { runningEntry, clients, startWithClient, stop } = useTimer()
  const version = useEntriesStore((s) => s.version)
  const projectsVersion = useProjectsStore((s) => s.version)
  const showToast = useToastStore((s) => s.show)

  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [projectsById, setProjectsById] = useState<Map<number, Project>>(new Map())

  // Edit / create / delete dialog state
  const [createOpen, setCreateOpen] = useState(false)
  const [editEntry, setEditEntry] = useState<Entry | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<Entry | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      setStatus((s) => (s === 'ready' ? s : 'loading'))
      const res = await window.api.dashboard.summary()
      if (cancelled) return
      if (res.ok) {
        setSummary(res.data)
        setStatus('ready')
        setErrorMsg(null)
      } else {
        setStatus('error')
        setErrorMsg(res.error)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [version, runningEntry?.id])

  const clientsById = useMemo(() => {
    const map = new Map<number, Client>()
    for (const c of clients) map.set(c.id, c)
    return map
  }, [clients])

  // Load all projects for name lookup — re-fetch when projects are added/edited
  useEffect(() => {
    void window.api.projects.getAll({}).then((res) => {
      if (res.ok) {
        const map = new Map<number, Project>()
        for (const p of res.data) map.set(p.id, p)
        setProjectsById(map)
      }
    })
  }, [projectsVersion])

  async function confirmDelete(entry: Entry): Promise<void> {
    setDeleteCandidate(null)
    const res = await window.api.entries.delete(entry.id)
    if (!res.ok) {
      showToast(t('common.entryDeleteFailed', { error: res.error }))
      return
    }
    useEntriesStore.getState().bumpVersion()
    showToast(t('common.entryDeleted'), {
      label: t('common.undo'),
      type: 'undo_delete',
      data: { entryId: entry.id }
    })
  }

  return (
    <div className="mx-auto w-full max-w-3xl flex flex-col gap-6">
      <ActiveTimerPill
        runningEntry={runningEntry}
        clientsById={clientsById}
        projectsById={projectsById}
        onStop={() => void stop()}
      />

      {status === 'loading' && <SummarySkeleton />}
      {status === 'error' && (
        <div className="rounded-[var(--r-disp)] border border-[var(--danger)] bg-[var(--danger-bg)] p-4 text-sm text-[var(--danger)]">
          <p className="mb-2 font-medium">{t('today.error.title')}</p>
          {errorMsg && <p className="mb-2 text-xs text-[var(--danger)]">{errorMsg}</p>}
          <button
            type="button"
            className="rounded bg-[var(--danger)] text-[var(--bg)] px-3 py-1 text-xs key-hover"
            onClick={() => useEntriesStore.getState().bumpVersion()}
          >
            {t('common.retry')}
          </button>
        </div>
      )}
      {status === 'ready' && summary && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <StatCard
              label={t('today.stats.today')}
              seconds={roundDuration(summary.todaySeconds, roundMinutes)}
              rawSeconds={summary.todaySeconds}
              accentColor="var(--accent)"
            />
            <StatCard
              label={t('today.stats.week')}
              seconds={roundDuration(summary.weekSeconds, roundMinutes)}
              rawSeconds={summary.weekSeconds}
              accentColor="var(--ink)"
            />
          </div>

          <QuickStartRow
            topClients={summary.topClients30d}
            disabled={!!runningEntry}
            clientsById={clientsById}
            projectsById={projectsById}
            onStart={(id, projectId) => void startWithClient(id, projectId)}
          />

          <RecentList
            entries={summary.recentEntries}
            clientsById={clientsById}
            projectsById={projectsById}
            roundMinutes={roundMinutes}
            onEdit={(e) => setEditEntry(e)}
            onDelete={(e) => setDeleteCandidate(e)}
          />
        </>
      )}

      <button
        type="button"
        onClick={() => setCreateOpen(true)}
        disabled={clients.length === 0}
        className="self-start flex items-center gap-2 rounded-[var(--r-key)] px-4 py-2 text-sm font-medium text-[var(--inv-ink)] hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50"
        style={{ background: 'var(--accent)' }}
      >
        <Icons.Plus />
        {t('today.addEntry')}
      </button>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('today.dialog.add')}
        widthClass="w-[520px]"
      >
        <EntryEditForm
          clients={clients}
          defaultDate={defaultBackfillStart()}
          onSaved={() => {
            setCreateOpen(false)
            showToast(t('common.entrySaved'))
          }}
          onCancel={() => setCreateOpen(false)}
        />
      </Dialog>

      <Dialog
        open={editEntry !== null}
        onClose={() => setEditEntry(null)}
        title={t('today.dialog.edit')}
        widthClass="w-[520px]"
      >
        {editEntry && (
          <EntryEditForm
            entry={editEntry}
            clients={clients}
            onSaved={() => {
              setEditEntry(null)
              showToast('Eintrag gespeichert')
            }}
            onCancel={() => setEditEntry(null)}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={deleteCandidate !== null}
        title={t('common.deleteEntryTitle')}
        message={
          deleteCandidate
            ? buildDeleteMessage(deleteCandidate, clientsById.get(deleteCandidate.client_id), t)
            : ''
        }
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        variant="danger"
        onConfirm={() => deleteCandidate && void confirmDelete(deleteCandidate)}
        onCancel={() => setDeleteCandidate(null)}
      />
    </div>
  )
}

function ActiveTimerPill({
  runningEntry,
  clientsById,
  projectsById,
  onStop
}: {
  runningEntry: Entry | null
  clientsById: Map<number, Client>
  projectsById: Map<number, Project>
  onStop: () => void
}): React.JSX.Element {
  const t = useT()
  const showProjectNumber = useUiPrefsStore((s) => s.showProjectNumber)
  // A `now` tick instead of derived `tickSeconds` so we don't call
  // setState synchronously when `runningEntry` changes (lint rule).
  const [, setNow] = useState(0)
  useEffect(() => {
    if (!runningEntry) return
    const id = setInterval(() => setNow((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [runningEntry])
  const tickSeconds = liveSeconds(runningEntry)

  if (!runningEntry) {
    return (
      <div
        className="rounded-[var(--r-disp)] border px-4 py-2 text-sm"
        style={{
          background: 'var(--card-bg)',
          borderColor: 'var(--card-border)',
          color: 'var(--text3)'
        }}
      >
        {t('today.noTimer')}
      </div>
    )
  }
  const client = clientsById.get(runningEntry.client_id)
  const runningProject =
    runningEntry.project_id != null ? projectsById.get(runningEntry.project_id) : undefined
  return (
    <div
      className="flex items-center gap-3 rounded-[var(--r-disp)] border px-4 py-2 text-sm"
      style={{
        background: 'var(--key)',
        borderColor: 'var(--sig)',
        color: 'var(--text)'
      }}
    >
      <span
        className="h-2.5 w-2.5 animate-pulse rounded-[var(--r-fine)]"
        style={{ backgroundColor: runningProject?.color || (client?.color ?? '#10b981') }}
      />
      <span className="font-medium" style={{ color: 'var(--text)' }}>
        {client?.name ?? t('common.unknown')}
      </span>
      {runningProject && (
        <span style={{ color: 'var(--text3)' }}>
          · {runningProject.name}
          {showProjectNumber && runningProject.external_project_number
            ? ` [${runningProject.external_project_number}]`
            : ''}
        </span>
      )}
      {runningEntry.description && (
        <span className="truncate" style={{ color: 'var(--text2)' }}>
          — {runningEntry.description}
        </span>
      )}
      <span
        className="ml-auto tabular-nums"
        style={{ color: 'var(--ink)', fontFamily: 'var(--font-num)' }}
      >
        {formatDuration(tickSeconds)}
      </span>
      <button
        type="button"
        onClick={onStop}
        className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--r-key)] transition-colors hover:bg-[var(--danger-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
        style={{ color: 'var(--danger)' }}
        title="Timer stoppen"
        aria-label="Timer stoppen"
      >
        <Icons.Stop width={14} height={14} />
      </button>
    </div>
  )
}

function StatCard({
  label,
  seconds,
  rawSeconds,
  accentColor
}: {
  label: string
  seconds: number
  rawSeconds?: number
  accentColor: string
}): React.JSX.Element {
  return (
    <div
      className="rounded-[var(--r-disp)] border p-4"
      style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
    >
      <p
        className="text-xs font-semibold uppercase tracking-wide"
        style={{ color: 'var(--text3)' }}
      >
        {label}
      </p>
      <p
        className="mt-2 tabular-nums"
        style={{
          fontFamily: 'var(--font-num)',
          fontSize: 40,
          fontWeight: 700,
          lineHeight: 1,
          letterSpacing: 2,
          color: accentColor
        }}
        title={
          rawSeconds !== undefined && rawSeconds !== seconds ? formatHHMM(rawSeconds) : undefined
        }
      >
        {formatHHMM(seconds)}
      </p>
    </div>
  )
}

function QuickStartRow({
  topClients,
  disabled,
  clientsById,
  projectsById,
  onStart
}: {
  topClients: DashboardSummary['topClients30d']
  disabled: boolean
  clientsById: Map<number, Client>
  projectsById: Map<number, Project>
  onStart: (clientId: number, projectId: number | null) => void
}): React.JSX.Element | null {
  const t = useT()
  if (topClients.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs uppercase tracking-wide" style={{ color: 'var(--text3)' }}>
        {t('today.quickstart.label')}
      </span>
      <div className="flex flex-wrap gap-2">
        {topClients.map((c) => (
          <QuickStartPill
            key={c.client_id}
            clientId={c.client_id}
            name={c.name}
            color={c.color}
            lastProjectId={c.last_project_id}
            projectsById={projectsById}
            clientsById={clientsById}
            disabled={disabled}
            onStart={onStart}
          />
        ))}
      </div>
    </div>
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

function QuickStartPill({
  clientId,
  name,
  color,
  lastProjectId,
  projectsById,
  clientsById,
  disabled,
  onStart
}: {
  clientId: number
  name: string
  color: string
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

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
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
                left: '50%',
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
                    left: `calc(50% + ${item.pos.x}px)`,
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
        className={`flex flex-col items-start rounded-[var(--r-disp)] border px-3 py-1.5 text-sm transition-colors hover:border-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50 ${fanOpen ? 'qs-pill-pulse-active' : ''}`}
        style={
          {
            background: 'var(--card-bg)',
            borderColor: fanOpen ? color : holdProgress > 0 ? color : 'var(--card-border)',
            color: 'var(--text)',
            transform:
              holdProgress > 0 ? `scale(${(1 - holdProgress * 0.04).toFixed(4)})` : undefined,
            boxShadow:
              !fanOpen && holdProgress > 0
                ? `0 0 0 ${(holdProgress * 3).toFixed(1)}px ${color}50`
                : undefined,
            userSelect: 'none',
            // When the fan is open, the backdrop sits at z-49.
            // Lift the pill above it so the pill itself stays crisp.
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
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 flex-shrink-0 rounded-[var(--r-fine)]"
            style={{ backgroundColor: color }}
          />
          <span className="font-medium">{name}</span>
          {hasProjects && (
            <Icons.ChevronDown
              width={10}
              height={10}
              style={{ color: 'var(--text3)', opacity: 0.6 }}
            />
          )}
          <Icons.Play width={11} height={11} style={{ color: 'var(--text3)' }} />
        </div>
        <div
          className="pl-4 text-xs leading-tight"
          style={{
            color: 'var(--text3)',
            marginTop: 2,
            visibility: lastProject ? 'visible' : 'hidden'
          }}
        >
          {lastProject
            ? `${lastProject.name}${showProjectNumber && lastProject.external_project_number ? ` [${lastProject.external_project_number}]` : ''}`
            : '\u00A0'}
        </div>
      </button>
    </div>
  )
}

function RecentList({
  entries,
  clientsById,
  projectsById,
  roundMinutes,
  onEdit,
  onDelete
}: {
  entries: Entry[]
  clientsById: Map<number, Client>
  projectsById: Map<number, Project>
  roundMinutes: number
  onEdit: (e: Entry) => void
  onDelete: (e: Entry) => void
}): React.JSX.Element {
  const t = useT()
  const showProjectNumber = useUiPrefsStore((s) => s.showProjectNumber)
  if (entries.length === 0) {
    return (
      <div
        className="rounded-[var(--r-disp)] border border-dashed px-4 py-8 text-center"
        style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
      >
        <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
          {t('today.recent.empty')}
        </p>
        <p className="mt-1 text-xs" style={{ color: 'var(--text3)' }}>
          {t('today.recent.emptyHint')}
        </p>
      </div>
    )
  }
  return (
    <div
      className="overflow-hidden rounded-[var(--r-disp)] border text-sm"
      style={{ borderColor: 'var(--card-border)', background: 'var(--card-bg)' }}
    >
      {/* Header */}
      <div
        className="grid px-3 py-2 text-xs font-medium uppercase tracking-wide"
        style={{
          gridTemplateColumns: '110px 1.5fr 1fr 70px 72px',
          background: 'var(--nav-bg)',
          color: 'var(--text2)'
        }}
      >
        <span>{t('today.table.time')}</span>
        <span>{t('today.table.client')}</span>
        <span>{t('today.table.description')}</span>
        <span className="text-right">{t('today.table.duration')}</span>
        <span />
      </div>
      {/* Rows */}
      {entries.map((e) => {
        const client = clientsById.get(e.client_id)
        const project = e.project_id != null ? projectsById.get(e.project_id) : undefined
        return (
          <div
            key={e.id}
            className="grid items-center px-3 py-2.5 border-t transition-colors hover:bg-[var(--key)]"
            style={{
              gridTemplateColumns: '110px 1.5fr 1fr 70px 72px',
              borderColor: 'var(--card-border)'
            }}
          >
            <span
              className="text-xs tabular-nums"
              style={{ color: 'var(--text2)', fontFamily: 'var(--font-num)' }}
            >
              {formatTimeRange(e)}
            </span>
            <span
              className="flex items-center gap-2 overflow-hidden"
              style={{ color: 'var(--text)' }}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-[var(--r-fine)] self-start mt-1.5"
                style={{ backgroundColor: project?.color || (client?.color ?? '#64748b') }}
              />
              <span className="flex flex-col min-w-0">
                <span className="truncate font-medium">{client?.name ?? t('common.unknown')}</span>
                {project && (
                  <span className="truncate text-xs" style={{ color: 'var(--text3)' }}>
                    {project.name}
                    {showProjectNumber && project.external_project_number
                      ? ` [${project.external_project_number}]`
                      : ''}
                  </span>
                )}
              </span>
            </span>
            <span className="truncate pr-2" style={{ color: 'var(--text2)' }} title={e.description}>
              {e.description || <span style={{ color: 'var(--text3)' }}>—</span>}
            </span>
            <span
              className="text-right text-xs tabular-nums"
              style={{ color: 'var(--text2)', fontFamily: 'var(--font-num)' }}
              title={(() => {
                const raw = durationSeconds(e)
                const disp = roundDuration(raw, roundMinutes)
                return disp !== raw ? formatHHMM(raw) : undefined
              })()}
            >
              {formatHHMM(roundDuration(durationSeconds(e), roundMinutes))}
            </span>
            <span className="flex justify-end gap-1">
              <button
                type="button"
                onClick={() => onEdit(e)}
                className="rounded p-1 hover:bg-[var(--key)] focus:outline-none focus:ring-2 focus:ring-[var(--focus)] transition-colors"
                style={{ color: 'var(--text2)' }}
                aria-label={t('common.edit')}
                title={t('common.edit')}
              >
                <Icons.Edit />
              </button>
              <button
                type="button"
                onClick={() => onDelete(e)}
                disabled={e.stopped_at === null}
                className="rounded p-1 hover:bg-[var(--key)] focus:outline-none focus:ring-2 focus:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
                style={{ color: 'var(--danger)' }}
                aria-label={t('common.delete')}
                title={e.stopped_at === null ? t('common.stopRunningFirst') : t('common.delete')}
              >
                <Icons.Trash />
              </button>
            </span>
          </div>
        )
      })}
    </div>
  )
}

function SummarySkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <div
          className="h-24 animate-pulse rounded-[var(--r-key)]"
          style={{ background: 'var(--card-bg)' }}
        />
        <div
          className="h-24 animate-pulse rounded-[var(--r-key)]"
          style={{ background: 'var(--card-bg)' }}
        />
      </div>
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-10 animate-pulse rounded"
            style={{ background: 'var(--card-bg)' }}
          />
        ))}
      </div>
    </div>
  )
}

// --- helpers ---

function liveSeconds(entry: Entry | null): number {
  if (!entry) return 0
  return Math.floor((Date.now() - new Date(entry.started_at).getTime()) / 1000)
}

function durationSeconds(entry: Entry): number {
  if (!entry.stopped_at) return liveSeconds(entry)
  return Math.floor(
    (new Date(entry.stopped_at).getTime() - new Date(entry.started_at).getTime()) / 1000
  )
}

/** Format seconds as HH:MM (no seconds, for stat cards / durations). */
function formatHHMM(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function formatTimeRange(e: Entry): string {
  const start = new Date(e.started_at)
  const startStr = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`
  if (!e.stopped_at) return `${startStr} – …`
  const stop = new Date(e.stopped_at)
  const stopStr = `${String(stop.getHours()).padStart(2, '0')}:${String(stop.getMinutes()).padStart(2, '0')}`
  return `${startStr} – ${stopStr}`
}

/** Default `defaultDate` for "+ Eintrag nachtragen": one hour ago. */
function defaultBackfillStart(): Date {
  return new Date(Date.now() - 60 * 60 * 1000)
}

function buildDeleteMessage(entry: Entry, client: Client | undefined, t: TFunction): string {
  const dur = formatHHMM(durationSeconds(entry))
  const date = new Date(entry.started_at)
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const name = client?.name ?? t('common.unknown')
  return t('common.deleteEntryMessage', { client: name, date: dateStr, duration: dur })
}
