import { useTimer } from '../../hooks/useTimer'
import { useNow } from '../../contexts/NowContext'
import { useT } from '../../contexts/I18nContext'
import { LogoMark } from './LogoMark'

export type View = 'today' | 'calendar' | 'clients' | 'analytics' | 'export' | 'settings'

const VIEWS: readonly View[] = ['today', 'calendar', 'clients', 'analytics', 'export', 'settings']

/** 2 px `--focus` outline, offset 2 px (HANDOFF §2.4). */
const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]'

/**
 * Running duration as `H:MM:SS` — hours unpadded (HANDOFF §2.2), unlike the
 * zero-padded `formatDuration` used elsewhere.
 */
function formatRunning(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * AppHeader (HANDOFF §3.1): logo mark + wordmark, text navigation with a 3 px
 * `--sig` bar under the active view, and on the right either the
 * RunningReadout (while a timer runs) or the "▶ Timer starten" key.
 */
export function AppHeader({
  view,
  onNavigate,
  onStartTimer
}: {
  view: View
  onNavigate: (v: View) => void
  onStartTimer: () => void
}): React.JSX.Element {
  const t = useT()
  const { runningEntry, clients, stop } = useTimer()

  return (
    <header className="shrink-0 border-b border-[var(--line)] bg-[var(--bg)]">
      <div className="mi-column flex min-h-16 flex-wrap items-center gap-8">
        <div className="flex items-center gap-2.5 text-[var(--ink)]">
          <LogoMark />
          <span
            className="text-xs font-extrabold uppercase"
            style={{ letterSpacing: '.2em', fontStretch: '125%' }}
          >
            TimeTrack
          </span>
        </div>

        <nav aria-label={t('header.navAria')} className="flex flex-auto flex-wrap gap-0.5">
          {VIEWS.map((v) => {
            const active = view === v
            return (
              <button
                key={v}
                type="button"
                onClick={() => onNavigate(v)}
                aria-current={active ? 'page' : undefined}
                className={`relative flex min-h-11 items-center px-3.5 text-sm hover:text-[var(--ink)] ${FOCUS} ${
                  active ? 'font-semibold text-[var(--ink)]' : 'font-medium text-[var(--ink2)]'
                }`}
              >
                {t(`nav.${v}`)}
                {active && (
                  // Flush with the header's bottom edge: (64 − 44) / 2 = 10 px.
                  <span
                    aria-hidden="true"
                    className="absolute right-3.5 left-3.5 h-[3px] bg-[var(--sig)]"
                    style={{ bottom: -10 }}
                  />
                )}
              </button>
            )
          })}
        </nav>

        {runningEntry ? (
          <RunningReadout
            startedAt={runningEntry.started_at}
            clientName={clients.find((c) => c.id === runningEntry.client_id)?.name}
            stopLabel={t('header.stopTimer')}
            onStop={() => void stop()}
          />
        ) : (
          <button
            type="button"
            onClick={onStartTimer}
            className={`key-hover flex min-h-11 items-center gap-2 rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] px-4 text-[13px] font-semibold text-[var(--ink)] shadow-[var(--edge-key)] active:translate-y-px ${FOCUS}`}
          >
            <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true">
              <path d="M0 0l9 5-9 5z" fill="currentColor" />
            </svg>
            {t('timer.modal.start')}
          </button>
        )}
      </div>
    </header>
  )
}

function RunningReadout({
  startedAt,
  clientName,
  stopLabel,
  onStop
}: {
  startedAt: string
  clientName?: string
  stopLabel: string
  onStop: () => void
}): React.JSX.Element {
  const now = useNow()
  const seconds = (now - new Date(startedAt).getTime()) / 1000

  return (
    <div className="flex items-center gap-3">
      <span aria-hidden="true" className="tt-blink h-2 w-2 bg-[var(--sig)]" />
      {clientName && <span className="text-[13px] text-[var(--ink2)]">{clientName}</span>}
      <span className="font-num text-[15px] font-medium text-[var(--ink)]">
        {formatRunning(seconds)}
      </span>
      <button
        type="button"
        onClick={onStop}
        aria-label={stopLabel}
        className={`key-hover flex h-11 w-11 items-center justify-center rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] shadow-[var(--edge-key)] active:translate-y-px ${FOCUS}`}
      >
        <span aria-hidden="true" className="h-3 w-3 rounded-[1px] bg-[var(--ink)]" />
      </button>
    </div>
  )
}
