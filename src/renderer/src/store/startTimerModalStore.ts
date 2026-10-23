import { create } from 'zustand'
import { useTimerStore } from './timerStore'
import { lastStartPair, type StartPair } from '../../../shared/startPair'

/**
 * What the START dialog preselects: the last pair as the shared rule gives
 * it. `projectId` left out: pick the client and let the dialog choose its
 * project as if the user had just picked that client; `null`: explicitly
 * "no project".
 */
export type StartPrefill = StartPair

/**
 * The pair a start without a selection uses and the dialog's prefill (#297,
 * B6): lastStartPair fed from the dashboard summary's newest entry, the
 * store's clients and that client's projects. Main feeds the same rule from
 * the database (startRequest.ts).
 */
export async function readLastStartPair(): Promise<StartPair | null> {
  const res = await window.api.dashboard.summary()
  const last = res.ok ? res.data.recentEntries[0] : undefined
  if (!last) return null
  // The store's list may not be loaded yet (right after launch); then the
  // database's list decides, as it does in main.
  let clients = useTimerStore.getState().clients
  if (clients.length === 0) {
    const res = await window.api.clients.getAll()
    clients = res.ok ? res.data : []
  }
  if (last.project_id == null) return lastStartPair(last, clients, [])
  const projects = await window.api.projects.getAll({ clientId: last.client_id })
  // A failed lookup is not "archived": the entry's project is kept as it
  // was (whatever its state now) rather than silently dropped — the one
  // case where this feed may name a project main's would leave out.
  const known = projects.ok ? projects.data : [{ id: last.project_id, active: 1 }]
  return lastStartPair(last, clients, known)
}

interface StartTimerModalState {
  open: boolean
  prefill: StartPrefill | null
  /**
   * Opens the one start modal (App) prefilled with the last used client +
   * project (B6), so Enter starts it. An archived client is not offered —
   * the modal only lists active ones.
   */
  openStart: () => Promise<void>
  close: () => void
}

/**
 * One start modal per window: the header's "Timer starten" and Heute's START
 * key both go through here, so there is no second, hidden instance writing
 * to the shared timer selection.
 */
export const useStartTimerModalStore = create<StartTimerModalState>((set) => ({
  open: false,
  prefill: null,
  openStart: async () => {
    set({ open: true, prefill: await readLastStartPair() })
  },
  close: () => set({ open: false })
}))
