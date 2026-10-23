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
import { useStartTimerModalStore } from './store/startTimerModalStore'
import { ToastTray } from './components/Toast'
import { UpdateBanner } from './components/UpdateBanner'
import { OnboardingWizard } from './components/OnboardingWizard'
import { useTimer } from './hooks/useTimer'
import { useSettingsStore } from './store/settingsStore'
import { useUiPrefsStore } from './store/uiPrefsStore'
import { NowProvider } from './contexts/NowContext'
import { AppHeader, type View } from './components/heute/AppHeader'

function App(): React.JSX.Element {
  // Selector: re-renders only when the onboarding flag changes (v1.13.2 PR 2).
  const onboardingCompleted = useSettingsStore((s) => s.settings?.onboarding_completed)
  const [view, setView] = useState<View>('today')
  const [showOnboarding, setShowOnboarding] = useState(false)
  // The one start modal (header key + Heute's START key), prefilled (B6).
  const startModal = useStartTimerModalStore()
  const {
    idleEvent,
    idleKeep,
    idleStopAtIdle,
    idleMarkPause,
    quickNoteEntry,
    setQuickNoteEntry,
    runningEntry
  } = useTimer({ engine: true })
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
    <NowProvider running={runningEntry !== null}>
      <div
        className="h-screen flex flex-col overflow-hidden"
        style={{ background: 'var(--bg)', color: 'var(--ink)' }}
      >
        <UpdateBanner />
        <AppHeader
          view={view}
          onNavigate={setView}
          onStartTimer={() => void startModal.openStart()}
        />

        {/* Content */}
        {/* tabIndex -1: where a dialog returns focus when its opener is gone. */}
        <main
          tabIndex={-1}
          className="relative z-10 flex-1 overflow-y-auto flex flex-col outline-none"
        >
          <div key={view} className="view-enter mi-column flex-1 flex flex-col pt-9 pb-16">
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
          // Keyed by entry: after a switch the prompt for the stopped entry is
          // open while the next one runs; stopping that one replaces the
          // prompt, and its text must not carry over to the other entry.
          <QuickNoteModal
            key={quickNoteEntry.id}
            entry={quickNoteEntry}
            onDone={() => setQuickNoteEntry(null)}
          />
        )}

        <ToastTray />

        <OnboardingWizard open={showOnboarding} onFinish={() => void finishOnboarding()} />

        <StartTimerModal
          open={startModal.open}
          onClose={startModal.close}
          prefill={startModal.prefill}
        />
      </div>
    </NowProvider>
  )
}

export default App
