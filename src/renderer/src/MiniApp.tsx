import { useEffect, useState } from 'react'
import { formatDuration } from '../../shared/duration'
import { useT } from './contexts/I18nContext'

/**
 * v1.4 Mini-Widget — always-on-top 200x40 overlay showing the running timer.
 *
 * B3: subscribes to push-state-sync from main, ticks elapsed locally so the
 * UI stays smooth without IPC chatter, and forwards play/stop intents back
 * to the main window via the dedicated `mini:request-*` channels.
 */

interface MiniState {
  running: boolean
  label: string
  startedAt: string | null
}

export default function MiniApp(): React.JSX.Element {
  const t = useT()
  const [state, setState] = useState<MiniState>({
    running: false,
    label: '',
    startedAt: null
  })
  // `now` ticks once per second while running; elapsed is then derived in
  // render. Driving it this way (instead of `setElapsed` inside the effect
  // body) avoids the react-hooks/set-state-in-effect lint and keeps the
  // component a pure function of (state, now).
  const [now, setNow] = useState<number>(() => Date.now())

  // Subscribe to state pushes from main (fired on every tray:update + on
  // ready-to-show / did-finish-load so we render the latest state instantly).
  useEffect(() => {
    const off = window.api.mini.onState((next) => setState(next))
    return off
  }, [])

  // Drive the local 1s tick only while a timer is running.
  useEffect(() => {
    if (!state.running || !state.startedAt) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return (): void => clearInterval(id)
  }, [state.running, state.startedAt])

  const elapsed =
    state.running && state.startedAt
      ? Math.max(0, Math.floor((now - new Date(state.startedAt).getTime()) / 1000))
      : 0

  if (state.running) {
    return (
      <div
        className="
          drag-region
          flex h-10 w-[200px] items-center gap-2 px-3
          rounded-[var(--r-key)] bg-[var(--disp,#1b1b19)]
          text-sm text-[var(--disp-ink,#edebe4)]
          select-none
        "
      >
        <span className="h-2 w-2 rounded-[var(--r-fine,2px)] bg-[var(--sig,#e2551f)]" aria-hidden />
        <span className="flex-1 truncate" title={state.label}>
          {state.label || t('miniWidget.timerRunning')}
        </span>
        <span className="font-num text-xs" style={{ color: 'var(--text2)' }}>
          {formatDuration(elapsed)}
        </span>
        <button
          type="button"
          aria-label={t('miniWidget.stop')}
          onClick={() => window.api.mini.requestStop()}
          className="
            no-drag-region
            h-6 w-6 flex items-center justify-center
            rounded text-[var(--disp-ink,#edebe4)] hover:bg-[var(--danger,#a8261b)] hover:text-[var(--bg,#e8e6df)]
          "
        >
          ■
        </button>
      </div>
    )
  }

  return (
    <div
      className="
        drag-region
        flex h-10 w-[200px] items-center gap-2 px-3
        rounded-[var(--r-key)] bg-[var(--disp,#1b1b19)]
        text-sm text-[var(--disp-ink,#edebe4)]
        select-none
      "
    >
      <span
        className="h-2 w-2 rounded-[var(--r-fine,2px)] bg-[var(--disp-dim,#8f8c83)]"
        aria-hidden
      />
      <span className="flex-1 truncate text-[var(--disp-dim,#8f8c83)]">
        {t('miniWidget.noTimer')}
      </span>
      <button
        type="button"
        aria-label={t('miniWidget.start')}
        onClick={() => window.api.mini.requestStart()}
        className="
          no-drag-region
          h-6 w-6 flex items-center justify-center
          rounded text-[var(--disp-dim,#8f8c83)] hover:bg-[var(--disp-line,#3a3935)] hover:text-[var(--disp-ink,#edebe4)]
        "
      >
        ▶
      </button>
    </div>
  )
}
