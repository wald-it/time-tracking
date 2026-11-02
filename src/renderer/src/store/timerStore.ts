import { create } from 'zustand'
import type { Client, Entry } from '../../../shared/types'

interface TimerState {
  // Data
  clients: Client[]
  runningEntry: Entry | null

  // UI
  selectedClientId: number | null
  selectedProjectId: number | null
  description: string
  elapsedSeconds: number
  isLoading: boolean

  // Idle modal
  idleEvent: { idleSince: string; idleSeconds: number } | null
  longRun: { entryId: number } | null

  // Quicknote modal — shown after stop when description was empty
  quickNoteEntry: Entry | null

  // Actions
  setClients: (clients: Client[]) => void
  setRunningEntry: (entry: Entry | null) => void
  setSelectedClientId: (id: number | null) => void
  setSelectedProjectId: (id: number | null) => void
  setDescription: (desc: string) => void
  setElapsedSeconds: (s: number) => void
  setIsLoading: (v: boolean) => void
  setIdleEvent: (e: { idleSince: string; idleSeconds: number } | null) => void
  setQuickNoteEntry: (entry: Entry | null) => void
  setLongRun: (prompt: { entryId: number } | null) => void
}

export const useTimerStore = create<TimerState>((set) => ({
  clients: [],
  runningEntry: null,
  selectedClientId: null,
  selectedProjectId: null,
  description: '',
  elapsedSeconds: 0,
  isLoading: false,
  idleEvent: null,
  longRun: null,
  quickNoteEntry: null,

  setClients: (clients) => set({ clients }),
  setRunningEntry: (runningEntry) => set({ runningEntry }),
  setSelectedClientId: (selectedClientId) => set({ selectedClientId }),
  setSelectedProjectId: (selectedProjectId) => set({ selectedProjectId }),
  setDescription: (description) => set({ description }),
  setElapsedSeconds: (elapsedSeconds) => set({ elapsedSeconds }),
  setIsLoading: (isLoading) => set({ isLoading }),
  setIdleEvent: (idleEvent) => set({ idleEvent }),
  setLongRun: (longRun) => set({ longRun }),
  setQuickNoteEntry: (quickNoteEntry) => set({ quickNoteEntry })
}))
