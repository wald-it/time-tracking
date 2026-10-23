import { create } from 'zustand'
import { useTimerStore } from './timerStore'
import { lastStartPair, type StartPair } from '../../../shared/startPair'

/**
 * What the START dialog preselects. `projectId` left out (undefined): pick
 * the client and let the dialog choose its project as if the user had just
 * picked that client; `null`: explicitly "no project".
 */
export interface StartPrefill {
  clientId: number
  projectId?: number | null
}

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
  const projects =
    last.project_id == null ? null : await window.api.projects.getAll({ clientId: last.client_id })
  return lastStartPair(last, useTimerStore.getState().clients, projects?.ok ? projects.data : [])
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
    const pair = await readLastStartPair()
    // An archived last project is left out, not replaced by "no project", so
    // a client with a single active project still gets it preselected.
    const prefill: StartPrefill | null = !pair
      ? null
      : pair.droppedProject
        ? { clientId: pair.clientId }
        : { clientId: pair.clientId, projectId: pair.projectId }
    set({ open: true, prefill })
  },
  close: () => set({ open: false })
}))
