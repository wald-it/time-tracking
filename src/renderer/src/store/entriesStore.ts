import { create } from 'zustand'

/**
 * Mutation-version store (E1).
 *
 * Pattern: any IPC call that mutates entry data (`entries:start`, `:stop`,
 * `:create`, `:update`, `:delete`, `:undelete`) must call `bumpVersion()`
 * after success. The global useTimer data:changed listener also bumps for
 * external writes (MCP, Stream Deck). Views (TodayView, CalendarView, Drawer,
 * monthly review) re-fetch via `useEffect([version])`. This replaces 60s polling and keeps every visible
 * surface in sync without per-view subscriptions or manual refresh buttons.
 *
 * Keep this store deliberately tiny — version-only — so re-renders are cheap
 * and any view can subscribe with `useEntriesStore((s) => s.version)`.
 */
interface EntriesState {
  version: number
  bumpVersion: () => void
}

export const useEntriesStore = create<EntriesState>((set) => ({
  version: 0,
  bumpVersion: (): void => set((s) => ({ version: s.version + 1 }))
}))
