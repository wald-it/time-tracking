import { create } from 'zustand'
import { useTimerStore } from './timerStore'

export interface StartPrefill {
  clientId: number
  projectId: number | null
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
    let prefill: StartPrefill | null = null
    const res = await window.api.dashboard.summary()
    const last = res.ok ? res.data.recentEntries[0] : undefined
    if (last) {
      const client = useTimerStore.getState().clients.find((c) => c.id === last.client_id)
      if (client?.active === 1) {
        prefill = { clientId: last.client_id, projectId: last.project_id ?? null }
      }
    }
    set({ open: true, prefill })
  },
  close: () => set({ open: false })
}))
