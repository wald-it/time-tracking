import type { RendererSettingKey } from '../../../shared/settingKeys'
import { create } from 'zustand'
import type { Settings } from '../../../shared/types'

/**
 * Central settings store (v1.13.2 PR 2, replaces SettingsContext).
 *
 * Why a store instead of context: React context re-renders EVERY consumer
 * whenever any settings key changes — a `setSetting('export_prefs', …)`
 * from the export modal re-rendered the whole app subtree (I18n, Theme,
 * Rounding, App). Zustand subscriptions are selector-based: a component
 * subscribing to `s.settings?.language` only re-renders when that key
 * changes. Same pattern as uiPrefsStore / projectsStore.
 *
 * `load()` is called once per entry point (main.tsx, mini.tsx) at module
 * scope — components no longer need a provider, which also removes the
 * "forgot the provider" crash class that broke the mini widget in v1.13.0.
 */
interface SettingsState {
  /** All settings, or null while the initial load is in progress. */
  settings: Settings | null
  /**
   * Initial load from the DB. Call once per entry point; a later call
   * overwrites the store with a fresh DB snapshot.
   */
  load: () => Promise<void>
  /**
   * Update a single setting both in the store and the DB. The store update
   * is optimistic; rejects (or throws on an ok:false IPC result) after the
   * fact, so callers that care attach .catch.
   */
  setSetting: <K extends RendererSettingKey>(key: K, value: Settings[K]) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  load: async (): Promise<void> => {
    const res = await window.api.settings.getAll()
    if (res.ok) set({ settings: res.data })
  },
  setSetting: async <K extends RendererSettingKey>(key: K, value: Settings[K]): Promise<void> => {
    // Optimistic store update; the DB write follows. Selector equality means
    // only subscribers of `key` re-render.
    set((s) => (s.settings ? { settings: { ...s.settings, [key]: value } } : s))
    const res = await window.api.settings.set(key, String(value))
    // Surface result-envelope failures (e.g. rejected hotkey registration)
    // as a rejection so callers' .catch paths engage instead of silently
    // desyncing store and DB.
    if (!res.ok) throw new Error(res.error)
  }
}))
