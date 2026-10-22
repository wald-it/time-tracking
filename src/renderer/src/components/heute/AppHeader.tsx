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
 *
 * Narrow windows (§3.1, owner 2026-10-22) — one line from 760 px up, via
 * container queries on the header, no JS:
 *   always   client name max. 160 px, ellipsis
 *   < 1140   client name hidden (the stop key always names the client)
 *   < 960    logo mark only, wordmark visually hidden
 *   < 840    icon-only start key; gaps 32 → 16, nav padding 14 → 10
 *            (`.mi-column` side padding 40 → 24 lives in main.css)
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
    <header className="@container shrink-0 border-b border-[var(--line)] bg-[var(--bg)]">
      <div className="mi-column flex min-h-16 items-center gap-8 @max-[839px]:gap-4">
        <div className="flex items-center gap-2.5 text-[var(--ink)]">
          <LogoMark />
          <span
            className="text-xs font-extrabold uppercase @max-[959px]:sr-only"
            style={{ letterSpacing: '.2em', fontStretch: '125%' }}
          >
            TimeTrack
          </span>
        </div>

        <nav aria-label={t('header.navAria')} className="flex flex-auto gap-0.5">
          {VIEWS.map((v) => {
            const active = view === v
            return (
              <button
                key={v}
                type="button"
                onClick={() => onNavigate(v)}
                aria-current={active ? 'page' : undefined}
                className={`relative flex min-h-11 items-center px-3.5 text-sm whitespace-nowrap hover:text-[var(--ink)] @max-[839px]:px-2.5 ${FOCUS} ${
                  active ? 'font-semibold text-[var(--ink)]' : 'font-medium text-[var(--ink2)]'
                }`}
              >
                {t(`nav.${v}`)}
                {active && (
                  // Flush with the header's bottom edge: (64 − 44) / 2 = 10 px.
                  <span
                    aria-hidden="true"
                    className="absolute right-3.5 left-3.5 h-[3px] bg-[var(--sig)] @max-[839px]:right-2.5 @max-[839px]:left-2.5"
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
            stopLabel={(name) =>
              name ? t('header.stopTimerFor', { client: name }) : t('header.stopTimer')
            }
            onStop={() => void stop()}
          />
        ) : (
          <button
            type="button"
            onClick={onStartTimer}
            title={t('timer.modal.start')}
            className={`key-hover flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] px-4 text-[13px] font-semibold whitespace-nowrap text-[var(--ink)] shadow-[var(--edge-key)] active:translate-y-px @max-[839px]:w-11 @max-[839px]:px-0 ${FOCUS}`}
          >
            <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true">
              <path d="M0 0l9 5-9 5z" fill="currentColor" />
            </svg>
            {/* Below 840 px only the glyph shows; the text stays the accessible name. */}
            <span className="@max-[839px]:sr-only">{t('timer.modal.start')}</span>
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
  stopLabel: (clientName?: string) => string
  onStop: () => void
}): React.JSX.Element {
  const now = useNow()
  const seconds = (now - new Date(startedAt).getTime()) / 1000

  return (
    <div className="flex shrink-0 items-center gap-3">
      <span aria-hidden="true" className="tt-blink h-2 w-2 bg-[var(--sig)]" />
      {clientName && (
        <span
          className="max-w-[160px] truncate text-[13px] text-[var(--ink2)] @max-[1139px]:hidden"
          title={clientName}
        >
          {clientName}
        </span>
      )}
      <span className="font-num text-[15px] font-medium whitespace-nowrap text-[var(--ink)]">
        {formatRunning(seconds)}
      </span>
      <button
        type="button"
        onClick={onStop}
        aria-label={stopLabel(clientName)}
        title={stopLabel(clientName)}
        className={`key-hover flex h-11 w-11 items-center justify-center rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] shadow-[var(--edge-key)] active:translate-y-px ${FOCUS}`}
      >
        <span aria-hidden="true" className="h-3 w-3 rounded-[1px] bg-[var(--ink)]" />
      </button>
    </div>
  )
}
