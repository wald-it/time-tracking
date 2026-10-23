import { useEffect, useRef, useCallback } from 'react'
import type { Client, Entry, IpcResult } from '../../../shared/types'
import { useTimerStore } from '../store/timerStore'
import { useClientsStore } from '../store/clientsStore'
import { formatDuration as _formatDuration } from '../../../shared/duration'

/**
 * Shape returned by {@link useTimer}. Named explicitly (rather than inferred)
 * so the public hook contract is stated in one place and satisfies
 * `explicit-function-return-type`. Field types mirror `timerStore`.
 */
export interface UseTimerResult {
  clients: Client[]
  runningEntry: Entry | null
  selectedClientId: number | null
  selectedProjectId: number | null
  description: string
  elapsedSeconds: number
  isLoading: boolean
  idleEvent: { idleSince: string; idleSeconds: number } | null
  quickNoteEntry: Entry | null
  setSelectedClientId: (id: number | null) => void
  setSelectedProjectId: (id: number | null) => void
  setDescription: (desc: string) => void
  setQuickNoteEntry: (entry: Entry | null) => void
  /** Resolves to the error of a refused or failed start/switch, else null. */
  start: () => Promise<string | null>
  stop: () => Promise<void>
  /** Resolves to the error of a refused or failed start, else null. */
  startWithClient: (clientId: number, projectId?: number | null) => Promise<string | null>
  /** Resolves to the error of a refused or failed switch, else null. */
  switchTo: (clientId: number, projectId: number | null) => Promise<string | null>
  idleKeep: () => void
  idleStopAtIdle: () => Promise<void>
  idleMarkPause: () => Promise<void>
}

/**
 * Fetch today's total seconds from main and push it to the tray together with
 * the current running label. Centralised so every callsite (start, stop,
 * heartbeat, init, idle handlers) keeps the tray tooltip in sync — no second
 * polling interval is needed (E5 in v1.2 plan).
 */
async function pushTrayUpdate(running: boolean, label: string): Promise<void> {
  const totalRes = await window.api.dashboard.todayTotal()
  const seconds = totalRes.ok ? totalRes.data : 0
  // v1.4 PR B — also forward `started_at` so the mini-widget can tick the
  // elapsed time locally without round-trips. `null` when no timer is running.
  const startedAt = useTimerStore.getState().runningEntry?.started_at ?? null
  window.api.tray.update(running, label, seconds, startedAt)
}

/**
 * Run one timer IPC call with `isLoading` set, and clear it whatever happens.
 * A call that rejects (no answer from main) comes back as a failed result,
 * so callers report it like a refusal — used where the caller shows the
 * error (start, switch); the others clear the flag with try/finally. Before, a rejection left `isLoading`
 * set for good: the start dialog's start key stayed disabled and the switch
 * path ignored every later call until the window was reloaded.
 */
async function withLoading<T>(call: () => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  useTimerStore.getState().setIsLoading(true)
  try {
    return await call()
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    useTimerStore.getState().setIsLoading(false)
  }
}

// Refs shared across all useTimer() instances so listeners are registered ONCE
// globally and always invoke the latest callback.
const globalToggleRef: { current: () => void } = { current: () => {} }
const globalQuickStartRef: { current: (clientId: number, projectId?: number | null) => void } = {
  current: () => {}
}
const globalStopRef: { current: () => void } = { current: () => {} }
const globalResyncRef: { current: () => void } = { current: () => {} }
let listenersInstalled = false

function installGlobalListenersOnce(
  setIdleEvent: (e: { idleSince: string; idleSeconds: number } | null) => void
): void {
  if (listenersInstalled) return
  listenersInstalled = true
  window.api.onHotkeyToggle(() => globalToggleRef.current())
  window.api.onTrayQuickStart((clientId) => globalQuickStartRef.current(clientId))
  window.api.onTrayStop(() => globalStopRef.current())
  window.api.onDataChanged(() => globalResyncRef.current())
  window.api.onIdleDetected((data) => {
    if (useTimerStore.getState().runningEntry) {
      setIdleEvent(data)
    } else {
      window.api.idle.dismiss()
    }
  })
}

let initRan = false

/**
 * `engine: true` marks the one instance that runs the 1 s elapsed tick and
 * the 30 s heartbeat (+ tray refresh) — App, which is always mounted. Every
 * other caller only reads the shared store; before, each mounted view ran its
 * own pair of intervals and the heartbeat went out once per view.
 */
export function useTimer(opts: { engine?: boolean } = {}): UseTimerResult {
  const engine = opts.engine === true
  const {
    clients,
    runningEntry,
    selectedClientId,
    selectedProjectId,
    description,
    elapsedSeconds,
    isLoading,
    idleEvent,
    quickNoteEntry,
    setClients,
    setRunningEntry,
    setSelectedClientId,
    setSelectedProjectId,
    setDescription,
    setElapsedSeconds,
    setIsLoading,
    setIdleEvent,
    setQuickNoteEntry
  } = useTimerStore()

  const clientsVersion = useClientsStore((s) => s.version)

  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Re-fetch client list whenever clientsVersion is bumped (create/update/delete
  // in ClientsView). Skip version 0 — the init effect below handles the initial
  // load so we don't double-fetch on mount.
  useEffect(() => {
    if (clientsVersion === 0) return
    void window.api.clients.getAll().then((res) => {
      if (res.ok) setClients(res.data)
    })
  }, [clientsVersion])

  // Load clients + check for running entry on first mount only (idempotent).
  useEffect(() => {
    if (initRan) return
    initRan = true
    async function init(): Promise<void> {
      const [clientsRes, runningRes] = await Promise.all([
        window.api.clients.getAll(),
        window.api.entries.getRunning()
      ])
      if (clientsRes.ok) setClients(clientsRes.data)
      if (runningRes.ok && runningRes.data) {
        const entry = runningRes.data
        setRunningEntry(entry)
        setSelectedClientId(entry.client_id)
        setDescription(entry.description)
        const started = new Date(entry.started_at).getTime()
        setElapsedSeconds(Math.floor((Date.now() - started) / 1000))
        const allClients = clientsRes.ok ? clientsRes.data : []
        const clientName = allClients.find((c) => c.id === entry.client_id)?.name ?? ''
        await pushTrayUpdate(true, clientName)
      } else {
        // Idle on launch: still surface today's total in the tray tooltip.
        await pushTrayUpdate(false, '')
      }
    }
    init()
    installGlobalListenersOnce(setIdleEvent)
  }, [])

  // Heartbeat while running — engine instance only (see above). There is no
  // per-second tick any more: live times read the shared clock (NowContext),
  // and a 1 s store write re-rendered every useTimer consumer for a value
  // nobody reads. elapsedSeconds is set on start/resync and reset on stop.
  useEffect(() => {
    if (!engine) return
    if (runningEntry) {
      // Heartbeat every 30s — also refreshes the tray today-total so the
      // tooltip stays current without a second timer (v1.2 plan, E5).
      heartbeatRef.current = setInterval(() => {
        window.api.entries.heartbeat(runningEntry.id)
        const clientName =
          useTimerStore.getState().clients.find((c) => c.id === runningEntry.client_id)?.name ?? ''
        void pushTrayUpdate(true, clientName)
      }, 30_000)
    } else {
      if (!runningEntry) setElapsedSeconds(0)
    }

    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current)
    }
  }, [runningEntry, engine])

  /**
   * The switch path shared by switchTo() and start() while a timer runs
   * (#271): stop the running entry and start (client, project) at ONE
   * instant, in one main-process transaction (`entries:switch`). If that
   * fails, the old entry keeps running.
   *
   * Unlike startWithClient this must NOT dismiss the quick-note prompt: when
   * the stopped entry had no description, the prompt opens for it once the
   * new entry runs — the same prompt a manual stop() shows. A pending idle
   * event belongs to the stopped entry and is dropped, as in stop().
   * `onSwitched` runs after a successful switch, before the new entry is set.
   * Resolves to the error of a refused or failed switch, for the caller to
   * show; null after a switch, and for a call ignored as a double click.
   */
  const switchToEntry = useCallback(
    async (
      clientId: number,
      projectId: number | null,
      newDescription: string,
      onSwitched?: () => void
    ): Promise<string | null> => {
      // A double click would switch twice: the second call still sees the old
      // running entry and leaves a zero-length entry with its own prompt.
      if (useTimerStore.getState().isLoading) return null
      const res = await withLoading(() =>
        window.api.entries.switch({
          client_id: clientId,
          project_id: projectId,
          description: newDescription,
          started_at: new Date().toISOString()
        })
      )
      if (!res.ok) return res.error
      const { entry, stopped } = res.data
      onSwitched?.()
      setRunningEntry(entry)
      if (useTimerStore.getState().idleEvent) {
        setIdleEvent(null)
        window.api.idle.dismiss()
      }
      const clientName = clients.find((c) => c.id === clientId)?.name ?? ''
      await pushTrayUpdate(true, clientName)
      if (stopped && stopped.description.trim() === '') setQuickNoteEntry(stopped)
      return null
    },
    // The store setters are stable; listed so this callback adds no lint
    // warning (the older ones carry theirs in the baseline).
    [clients, setRunningEntry, setIdleEvent, setQuickNoteEntry]
  )

  const start = useCallback(async (): Promise<string | null> => {
    // Resolve which client to start. If the user hasn't picked one (e.g. the
    // hotkey fires from Today/Calendar where there is no selector at all),
    // fall back to the first active client so Alt+Shift+S always does
    // *something* instead of silently no-op'ing.
    let clientId = selectedClientId
    if (!clientId) {
      const fallback = clients.find((c) => c.active === 1)
      if (!fallback) return null
      clientId = fallback.id
      setSelectedClientId(clientId)
    }
    const projectId = useTimerStore.getState().selectedProjectId
    // A timer already runs (the start dialog was open while one started
    // elsewhere): take the same switch path as a quick-start key (owner
    // decision for 1.22) — one instant in the main process, the quick-note
    // prompt for the stopped entry if it had no description, and an open
    // prompt is NOT dismissed.
    if (useTimerStore.getState().runningEntry) {
      return switchToEntry(clientId, projectId ?? null, description)
    }
    const res = await withLoading(() =>
      window.api.entries.start({
        client_id: clientId,
        project_id: projectId ?? undefined,
        description,
        started_at: new Date().toISOString()
      })
    )
    if (!res.ok) return res.error
    setRunningEntry(res.data)
    // Dismiss quicknote modal if user starts a new timer before answering
    if (useTimerStore.getState().quickNoteEntry) setQuickNoteEntry(null)
    const clientName = clients.find((c) => c.id === clientId)?.name ?? ''
    await pushTrayUpdate(true, clientName)
    return null
  }, [selectedClientId, description, clients, switchToEntry])

  const stop = useCallback(async () => {
    if (!runningEntry) return
    const wasEmpty = runningEntry.description.trim() === ''
    // Not withLoading: nothing reports a failed stop yet, so a rejection
    // still reaches the caller as before; only the flag must not stick.
    setIsLoading(true)
    let res: IpcResult<Entry>
    try {
      res = await window.api.entries.stop(runningEntry.id)
    } finally {
      setIsLoading(false)
    }
    if (res.ok) {
      setRunningEntry(null)
      setDescription('')
      await pushTrayUpdate(false, '')
      // If user manually stops, dismiss any pending idle event.
      if (useTimerStore.getState().idleEvent) {
        setIdleEvent(null)
        window.api.idle.dismiss()
      }
      // Prompt for description if the entry had none.
      if (wasEmpty) {
        setQuickNoteEntry(res.data)
      }
    }
  }, [runningEntry])

  const startWithClient = useCallback(
    async (clientId: number, projectId?: number | null): Promise<string | null> => {
      if (useTimerStore.getState().runningEntry) return null
      // Client and project together: a stale project of the previous client
      // would otherwise travel into the next start() (global hotkey).
      setSelectedClientId(clientId)
      useTimerStore.getState().setSelectedProjectId(projectId ?? null)
      const res = await withLoading(() =>
        window.api.entries.start({
          client_id: clientId,
          project_id: projectId ?? null,
          description: '',
          started_at: new Date().toISOString()
        })
      )
      if (!res.ok) return res.error
      setRunningEntry(res.data)
      setDescription('')
      // Dismiss quicknote modal if user starts a new timer before answering
      if (useTimerStore.getState().quickNoteEntry) setQuickNoteEntry(null)
      const clientName = clients.find((c) => c.id === clientId)?.name ?? ''
      await pushTrayUpdate(true, clientName)
      return null
    },
    [clients]
  )

  /**
   * B1 — quick start while a timer runs, over the shared switch path (see
   * switchToEntry). The key did not go through the selector, so a successful
   * switch adopts its client and project as the selection and clears the
   * description.
   */
  const switchTo = useCallback(
    (clientId: number, projectId: number | null) =>
      switchToEntry(clientId, projectId, '', () => {
        // Client and project together, as in startWithClient (global hotkey).
        setSelectedClientId(clientId)
        useTimerStore.getState().setSelectedProjectId(projectId)
        setDescription('')
      }),
    [switchToEntry, setSelectedClientId, setDescription]
  )

  const dismissIdle = useCallback(() => {
    setIdleEvent(null)
    window.api.idle.dismiss()
  }, [])

  const idleKeep = useCallback(() => {
    dismissIdle()
  }, [dismissIdle])

  const idleStopAtIdle = useCallback(async () => {
    const ev = useTimerStore.getState().idleEvent
    const entry = useTimerStore.getState().runningEntry
    if (!ev || !entry) {
      dismissIdle()
      return
    }
    // Not withLoading: a rejection must keep the idle prompt open (it reaches
    // the caller before dismissIdle below), as it always did.
    setIsLoading(true)
    let res: IpcResult<Entry>
    try {
      res = await window.api.entries.update({
        id: entry.id,
        client_id: entry.client_id,
        description: entry.description,
        started_at: entry.started_at,
        stopped_at: ev.idleSince
      })
    } finally {
      setIsLoading(false)
    }
    if (res.ok) {
      setRunningEntry(null)
      setDescription('')
      await pushTrayUpdate(false, '')
    }
    dismissIdle()
  }, [dismissIdle])

  const idleMarkPause = useCallback(async () => {
    const ev = useTimerStore.getState().idleEvent
    const entry = useTimerStore.getState().runningEntry
    if (!ev || !entry) {
      dismissIdle()
      return
    }
    setIsLoading(true)
    // Two calls in a row, so not withLoading: the flag spans both, and a
    // rejection still reaches the caller, but never leaves it set.
    try {
      // 1. Stop the running entry at idleSince
      const stopRes = await window.api.entries.update({
        id: entry.id,
        client_id: entry.client_id,
        description: entry.description,
        started_at: entry.started_at,
        stopped_at: ev.idleSince
      })
      if (stopRes.ok) {
        // 2. Book the pause from idleSince to now in one step, closed and not
        // billable: it is time not worked and must stay off the client's
        // timesheet (#298). Starting it as a timer and closing it afterwards
        // left a running, billable "Pause" whenever the second call failed.
        await window.api.entries.create({
          client_id: entry.client_id,
          description: 'Pause',
          started_at: ev.idleSince,
          stopped_at: new Date().toISOString(),
          billable: 0
        })
        setRunningEntry(null)
        setDescription('')
        await pushTrayUpdate(false, '')
      }
    } finally {
      setIsLoading(false)
    }
    dismissIdle()
  }, [dismissIdle])

  // External writes (#133): the MCP bridge / hardware keys mutate the DB in
  // the main process and broadcast 'data:changed' — the renderer, which owns
  // the timer state machine, resyncs its running entry from the DB and pushes
  // the result to tray + mini-widget over the existing 'tray:update' path.
  const resyncFromExternal = useCallback(async () => {
    const res = await window.api.entries.getRunning()
    if (!res.ok) return
    const entry = res.data
    const current = useTimerStore.getState().runningEntry
    if (entry) {
      if (current && current.id === entry.id) return
      setRunningEntry(entry)
      setSelectedClientId(entry.client_id)
      setSelectedProjectId(entry.project_id ?? null)
      setDescription(entry.description)
      setElapsedSeconds(Math.floor((Date.now() - new Date(entry.started_at).getTime()) / 1000))
      const clientName =
        useTimerStore.getState().clients.find((c) => c.id === entry.client_id)?.name ?? ''
      await pushTrayUpdate(true, clientName)
    } else {
      if (current) {
        setRunningEntry(null)
        setDescription('')
      }
      // Refresh the tray today-total either way — an external write may have
      // added or edited entries without touching the running timer.
      await pushTrayUpdate(false, '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store setters are stable (zustand)
  }, [])

  // Keep refs current so listeners always call the latest fn
  // eslint-disable-next-line react-hooks/immutability -- #157: dauerhaft — modulweite Singletons, damit die IPC-Listener nur einmal registriert werden und trotzdem die neueste Closure treffen; der Compiler ist bewusst nicht aktiviert (Messung im Issue)
  globalToggleRef.current = runningEntry ? stop : start
  // eslint-disable-next-line react-hooks/immutability -- #157: dauerhaft — modulweite Singletons, damit die IPC-Listener nur einmal registriert werden und trotzdem die neueste Closure treffen; der Compiler ist bewusst nicht aktiviert (Messung im Issue)
  globalQuickStartRef.current = startWithClient
  // eslint-disable-next-line react-hooks/immutability -- #157: dauerhaft — modulweite Singletons, damit die IPC-Listener nur einmal registriert werden und trotzdem die neueste Closure treffen; der Compiler ist bewusst nicht aktiviert (Messung im Issue)
  globalStopRef.current = stop
  // eslint-disable-next-line react-hooks/immutability -- #157: dauerhaft — modulweite Singletons, damit die IPC-Listener nur einmal registriert werden und trotzdem die neueste Closure treffen; der Compiler ist bewusst nicht aktiviert (Messung im Issue)
  globalResyncRef.current = () => void resyncFromExternal()

  return {
    clients,
    runningEntry,
    selectedClientId,
    selectedProjectId,
    description,
    elapsedSeconds,
    isLoading,
    idleEvent,
    quickNoteEntry,
    setSelectedClientId,
    setSelectedProjectId,
    setDescription,
    setQuickNoteEntry,
    start,
    stop,
    startWithClient,
    switchTo,
    idleKeep,
    idleStopAtIdle,
    idleMarkPause
  }
}

export function formatDuration(seconds: number): string {
  // Re-export shared util for legacy import sites; new code should import from '@shared/duration'.
  return _formatDuration(seconds)
}
