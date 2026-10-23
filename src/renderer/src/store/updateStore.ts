import { create } from 'zustand'
import type { UpdateStatus } from '../../../shared/types'

/**
 * v1.5 PR B — auto-update store.
 *
 * Mirrors the main-process updater state. Subscribes to `update:status`
 * IPC events on first use; calls the imperative `update:check` /
 * `update:install` IPC handlers via the methods below.
 */
interface UpdateStore {
  status: UpdateStatus
  lastCheckedAt: string | null
  /** Whether the user has dismissed the current `ready` banner. */
  dismissed: boolean
  setStatus: (status: UpdateStatus) => void
  setLastCheckedAt: (iso: string | null) => void
  dismissReady: () => void
  /** Initialize the store: subscribe to events + fetch initial state. */
  init: () => Promise<void>
  /** Trigger a manual update check from Settings. */
  checkNow: () => Promise<void>
  /** Quit and run the installer. */
  installNow: () => Promise<void>
}

let unsubscribe: (() => void) | null = null

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: { status: 'idle' },
  lastCheckedAt: null,
  dismissed: false,

  setStatus: (status) => {
    // New `ready` event resets the dismissed flag so we show it again.
    set((prev) => ({
      status,
      dismissed:
        status.status === 'ready' && prev.status.status !== 'ready' ? false : prev.dismissed
    }))
  },
  setLastCheckedAt: (iso) => set({ lastCheckedAt: iso }),
  dismissReady: () => set({ dismissed: true }),

  init: async () => {
    if (unsubscribe) return
    unsubscribe = window.api.update.onStatus((status) => {
      get().setStatus(status)
      // Persist last-check timestamp on terminal events.
      if (status.status === 'not-available') {
        get().setLastCheckedAt(status.checkedAt)
      }
    })
    const [st, last] = await Promise.all([
      window.api.update.getStatus(),
      window.api.update.getLastCheck()
    ])
    if (st.ok) get().setStatus(st.data)
    if (last.ok) get().setLastCheckedAt(last.data)
  },

  checkNow: async () => {
    set({ status: { status: 'checking' } })
    const res = await window.api.update.check()
    if (!res.ok) {
      set({ status: { status: 'error', message: res.error } })
    }
  },

  installNow: async () => {
    await window.api.update.install()
  }
}))
