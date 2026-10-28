import { create } from 'zustand'
import { useEntriesStore } from './entriesStore'

/**
 * Toast queue with action snapshots (E9).
 *
 * Why snapshot data into the store instead of capturing closures from the
 * originating component: undo for "Eintrag gelöscht" must still work after
 * the source component (e.g. CalendarDrawer) unmounts. We keep the minimal
 * data needed to replay the action (entry id and billed status), and the
 * store itself calls the IPC.
 */
export type ToastActionType = 'undo_delete' | 'undo_edit'

export interface ToastAction {
  label: string
  type: ToastActionType
  /** For undo_delete: { entryId: number, billed?: boolean }. */
  data: Record<string, unknown>
}

export interface Toast {
  id: number
  message: string
  action?: ToastAction
  /** Epoch ms; toast auto-dismisses at this time. */
  expiresAt: number
}

interface ToastState {
  toasts: Toast[]
  /** Snapshot survives toast expiry and the originating view's unmount. */
  pendingUndo: ToastAction | null
  cancelUndo: () => void
  confirmUndo: (reason: string) => Promise<void>
  show: (message: string, action?: ToastAction, ttlMs?: number) => number
  dismiss: (id: number) => void
  /** Execute the toast's action (if any) then dismiss it. */
  executeAction: (id: number) => Promise<void>
}

let nextId = 1

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  pendingUndo: null,
  cancelUndo: () => set({ pendingUndo: null }),
  confirmUndo: async (reason): Promise<void> => {
    const action = get().pendingUndo
    if (!action || !reason.trim()) return
    set({ pendingUndo: null })
    await restore(action, reason.trim())
  },

  show: (message, action, ttlMs = 5000): number => {
    const id = nextId++
    const toast: Toast = {
      id,
      message,
      action,
      expiresAt: Date.now() + ttlMs
    }
    set((s) => ({ toasts: [...s.toasts, toast] }))
    setTimeout(() => {
      // Only dismiss if still present (user may have clicked the action).
      if (get().toasts.some((t) => t.id === id)) {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      }
    }, ttlMs)
    return id
  },

  dismiss: (id): void => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  executeAction: async (id): Promise<void> => {
    const toast = get().toasts.find((t) => t.id === id)
    if (!toast?.action) return
    // Dismiss first so a slow IPC call doesn't leave the toast hanging.
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    if (toast.action.type === 'undo_delete') {
      if (toast.action.data.billed) set({ pendingUndo: toast.action })
      else await restore(toast.action)
    }
  }
}))

async function restore(action: ToastAction, reason?: string): Promise<void> {
  const res = await window.api.entries.undelete(action.data.entryId as number, reason)
  if (res.ok) useEntriesStore.getState().bumpVersion()
  else useToastStore.getState().show(res.error)
}
