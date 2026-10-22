import { useState, useEffect } from 'react'
import TodayView from './views/TodayView'
import CalendarView from './views/CalendarView'
import ClientsView from './views/ClientsView'
import SettingsView from './views/SettingsView'
import AuswertungView from './views/AuswertungView'
import ExportView from './views/ExportView'
import { IdleModal } from './components/IdleModal'
import { QuickNoteModal } from './components/QuickNoteModal'
import { StartTimerModal } from './components/StartTimerModal'
import { ToastTray } from './components/Toast'
import { UpdateBanner } from './components/UpdateBanner'
import { OnboardingWizard } from './components/OnboardingWizard'
import { useTimer } from './hooks/useTimer'
import { useT } from './contexts/I18nContext'
import { useSettingsStore } from './store/settingsStore'
import { useProjectsStore } from './store/projectsStore'
import { useUiPrefsStore } from './store/uiPrefsStore'

type View = 'today' | 'calendar' | 'clients' | 'analytics' | 'export' | 'settings'

function App(): React.JSX.Element {
  const t = useT()
  // Selector: re-renders only when the onboarding flag changes (v1.13.2 PR 2).
  const onboardingCompleted = useSettingsStore((s) => s.settings?.onboarding_completed)
  const [view, setView] = useState<View>('today')
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [showTimerModal, setShowTimerModal] = useState(false)
  const {
    idleEvent,
    idleKeep,
    idleStopAtIdle,
    idleMarkPause,
    quickNoteEntry,
    setQuickNoteEntry,
    runningEntry,
    clients,
    stop
  } = useTimer()
  const projectsVersion = useProjectsStore((s) => s.version)
  const [runningProjectColor, setRunningProjectColor] = useState<string | undefined>(undefined)

  // Track the color of the currently running entry's project for the nav pill.
  useEffect(() => {
    if (runningEntry?.project_id == null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- #142: dauerhaft — Teilfix möglich (bedingtes Rendern), der asynchrone Zweig bleibt Effect
      setRunningProjectColor(undefined)
      return
    }
    void window.api.projects.getAll({}).then((res) => {
      if (!res.ok) return
      const p = res.data.find((proj) => proj.id === runningEntry.project_id)
      setRunningProjectColor(p?.color || undefined)
    })
  }, [runningEntry?.project_id, projectsVersion])

  // Check onboarding flag — show wizard only for fresh installs.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- #142: dauerhaft — zweiter Schreiber finishOnboarding(); Ableitung würde den Wizard nach Abschluss erneut öffnen
    if (onboardingCompleted === '0') setShowOnboarding(true)
    void useUiPrefsStore.getState().load()
  }, [onboardingCompleted])

  async function finishOnboarding(): Promise<void> {
    setShowOnboarding(false)
    await window.api.settings.set('onboarding_completed', '1')
  }

  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{ background: 'var(--page-bg)', color: 'var(--text)' }}
    >
      <UpdateBanner />
      {/* Nav */}
      <nav
        className="relative z-10 flex items-center gap-1 px-3 py-2 shrink-0 border-b"
        style={{
          background: 'var(--nav-bg)',
          borderColor: 'var(--card-border)'
        }}
      >
        {(['today', 'calendar', 'clients', 'analytics', 'export', 'settings'] as View[]).map(
          (v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-4 py-1.5 rounded-[var(--r-key)] text-sm font-medium transition-colors
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]
              ${view === v ? 'bg-[var(--inv)] text-[var(--inv-ink)]' : 'hover:bg-[var(--key)]'}`}
              style={view !== v ? { color: 'var(--text2)' } : undefined}
            >
              {t(('nav.' + v) as `nav.${View}`)}
            </button>
          )
        )}

        {/* Play button — only when no timer is running */}
        {!runningEntry && (
          <button
            type="button"
            onClick={() => setShowTimerModal(true)}
            className="ml-auto flex items-center gap-1.5 rounded-[var(--r-key)] border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--key)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
            style={{ borderColor: 'var(--card-border)', color: 'var(--text2)' }}
            aria-label={t('timer.modal.title')}
          >
            <PlayIcon />
            {t('timer.modal.start')}
          </button>
        )}

        {/* Running timer pill */}
        {runningEntry &&
          (() => {
            const client = clients.find((c) => c.id === runningEntry.client_id)
            return (
              <RunningPill
                startedAt={runningEntry.started_at}
                clientName={client?.name}
                clientColor={client?.color}
                projectColor={runningProjectColor}
                onStop={() => void stop()}
              />
            )
          })()}
      </nav>

      {/* Content */}
      <main className="relative z-10 flex-1 overflow-y-auto p-6 flex flex-col">
        <div key={view} className="view-enter flex-1 flex flex-col">
          {view === 'today' && <TodayView />}
          {view === 'calendar' && <CalendarView />}
          {view === 'clients' && <ClientsView />}
          {view === 'analytics' && <AuswertungView />}
          {view === 'export' && <ExportView />}
          {view === 'settings' && <SettingsView />}
        </div>
      </main>

      {idleEvent && (
        <IdleModal
          idleSince={idleEvent.idleSince}
          idleSeconds={idleEvent.idleSeconds}
          onKeep={idleKeep}
          onStopAtIdle={idleStopAtIdle}
          onMarkPause={idleMarkPause}
        />
      )}
      {quickNoteEntry && (
        <QuickNoteModal entry={quickNoteEntry} onDone={() => setQuickNoteEntry(null)} />
      )}

      <ToastTray />

      <OnboardingWizard open={showOnboarding} onFinish={() => void finishOnboarding()} />

      <StartTimerModal open={showTimerModal} onClose={() => setShowTimerModal(false)} />
    </div>
  )
}

export default App

// ── Running timer pill (nav bar, right side) ────────────────────────────────
function PlayIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
      <path d="M3 2.5l6 3.5-6 3.5V2.5z" />
    </svg>
  )
}

function StopIcon(): React.JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
      <rect x="1" y="1" width="8" height="8" rx="1.5" />
    </svg>
  )
}

function RunningPill({
  startedAt,
  clientName,
  clientColor,
  projectColor,
  onStop
}: {
  startedAt: string
  clientName?: string
  clientColor?: string
  projectColor?: string
  onStop: () => void
}): React.JSX.Element {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [startedAt])

  // eslint-disable-next-line react-hooks/purity -- #142: dauerhaft — tickende Uhr muss bei jedem Render „jetzt" lesen; das ist bereits die Ableitung
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const label = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`

  return (
    <div
      className="ml-auto flex items-center gap-2 rounded-[var(--r-key)] border pl-3 pr-1 py-1 text-xs"
      style={{ background: 'var(--key)', borderColor: 'var(--sig)', color: 'var(--ink)' }}
    >
      <span
        className="h-2 w-2 animate-pulse rounded-[var(--r-fine)]"
        style={{ backgroundColor: projectColor || (clientColor ?? 'var(--sig)') }}
      />
      {clientName && (
        <span className="font-medium" style={{ color: 'var(--text)' }}>
          {clientName}
        </span>
      )}
      <span className="tabular-nums" style={{ fontFamily: 'var(--font-num)' }}>
        {label}
      </span>
      <button
        type="button"
        onClick={onStop}
        className="ml-1 flex items-center justify-center rounded-[var(--r-key)] p-1.5 transition-colors hover:bg-[var(--danger-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        style={{ color: 'var(--danger)' }}
        aria-label="Timer stoppen"
      >
        <StopIcon />
      </button>
    </div>
  )
}
