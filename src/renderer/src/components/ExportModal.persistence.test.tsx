/**
 * Component-level regression tests for export-pref persistence (v1.13.2).
 *
 * Pins the behaviors the localStorage → DB move introduced:
 *  1. Opening the modal must NOT write prefs — a mounting instance must
 *     never clobber the stored value. Rendered under <StrictMode> on
 *     purpose: effect-based persistence with a didMount ref passes without
 *     StrictMode but clobbers with it (the original v1.13.2 review finding).
 *  2. Changing an option must write the full pref blob to the settings DB.
 *  3. Legacy localStorage prefs are migrated into the DB once, and the
 *     legacy key is removed afterwards.
 *  4. A failed DB write must not crash and must keep the legacy key so the
 *     migration retries on the next mount.
 *
 * Uses the real settings store (useSettingsStore) + I18nProvider with a
 * mocked window.api, mirroring CalendarView's key-remount pattern (fresh
 * mount per open).
 */
import { StrictMode } from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { ExportModal } from './ExportModal'
import { useSettingsStore } from '../store/settingsStore'
import { I18nProvider } from '../contexts/I18nContext'
import { LS_PREFS_KEY } from './exportPrefs'

type Store = Record<string, string>

interface ApiMock {
  store: Store
  set: ReturnType<typeof vi.fn>
}

function mockApi(initial: Store): ApiMock {
  const store: Store = { ...initial }
  const set = vi.fn(async (key: string, value: string) => {
    store[key] = value
    return { ok: true as const, data: undefined }
  })
  const api = {
    settings: {
      getAll: async () => ({ ok: true as const, data: { ...store } }),
      set
    },
    clients: {
      getAll: async () => ({ ok: true as const, data: [] })
    },
    projects: {
      getAll: async () => ({ ok: true as const, data: [] })
    }
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { store, set }
}

/** Mirrors CalendarView: the modal remounts (key) whenever it opens. */
function Harness({ open }: { open: boolean }): React.JSX.Element {
  return (
    <StrictMode>
      <I18nProvider>
        <ExportModal key={open ? 'open' : 'closed'} open={open} onClose={() => {}} />
      </I18nProvider>
    </StrictMode>
  )
}

function findGroupBySelect(container: HTMLElement): HTMLSelectElement {
  const select = Array.from(container.querySelectorAll('select')).find((s) =>
    s.querySelector('option[value="tag"]')
  )
  if (!select) throw new Error('groupBy select not found')
  return select
}

interface Setup {
  api: ApiMock
  container: HTMLElement
  rerender: (ui: React.ReactElement) => void
}

function setup(initialStore: Store): Setup {
  const api = mockApi(initialStore)
  const { container, rerender } = render(<Harness open={false} />)
  return { api, container, rerender }
}

async function openModal(rerender: (ui: React.ReactElement) => void): Promise<void> {
  // Load the settings store before the modal (re)mounts — mirrors real
  // usage, where the entry point kicked off load() long before the user
  // opens the export dialog.
  await act(async () => {
    await useSettingsStore.getState().load()
  })
  rerender(<Harness open={true} />)
  await act(async () => {})
}

describe('ExportModal pref persistence (DB-backed, v1.13.2)', () => {
  beforeEach(() => {
    localStorage.clear()
    // The zustand store is module-global — reset between tests.
    useSettingsStore.setState({ settings: null })
  })

  it('ignores grouping stored in the settings DB', async () => {
    const { container, rerender } = setup({
      export_prefs: JSON.stringify({ tab: 'pdf', groupBy: 'reference' })
    })
    await openModal(rerender)
    await waitFor(() => {
      expect(findGroupBySelect(container).value).toBe('none')
    })
  })

  it('does not write prefs on mount, even under StrictMode double-effects', async () => {
    const { api, container, rerender } = setup({
      export_prefs: JSON.stringify({ tab: 'pdf', hideFeeColumn: true })
    })
    await openModal(rerender)
    // Positive signal first: the stored pref is visible, so mount effects ran.
    await waitFor(() => {
      expect(container.querySelector('[role="switch"]')).toHaveAttribute('aria-checked', 'true')
    })
    expect(api.set).not.toHaveBeenCalled()
  })

  it('persists a changed option to the settings DB', async () => {
    const { api, container, rerender } = setup({
      export_prefs: JSON.stringify({ tab: 'pdf' })
    })
    await openModal(rerender)
    fireEvent.click(container.querySelector('[role="switch"]')!)
    await waitFor(() => {
      expect(api.set).toHaveBeenCalledWith(
        'export_prefs',
        expect.stringContaining('"hideFeeColumn":true')
      )
    })
    expect(JSON.parse(api.store.export_prefs)).not.toHaveProperty('groupBy')
  })

  it('migrates legacy localStorage prefs into the DB once and removes the key', async () => {
    localStorage.setItem(LS_PREFS_KEY, JSON.stringify({ tab: 'csv', csvFormat: 'us' }))
    const { api, rerender } = setup({})
    await openModal(rerender)
    await waitFor(() => {
      expect(api.set).toHaveBeenCalledWith(
        'export_prefs',
        expect.stringContaining('"csvFormat":"us"')
      )
      expect(localStorage.getItem(LS_PREFS_KEY)).toBeNull()
    })
  })

  it('keeps the legacy key and does not crash when the migration write fails', async () => {
    localStorage.setItem(LS_PREFS_KEY, JSON.stringify({ tab: 'csv' }))
    const { api, rerender } = setup({})
    api.set.mockRejectedValue(new Error('db locked'))
    await openModal(rerender)
    await waitFor(() => {
      expect(api.set).toHaveBeenCalled()
    })
    // The failed write must not remove the legacy key — next mount retries.
    expect(localStorage.getItem(LS_PREFS_KEY)).not.toBeNull()
  })

  it('the tab keys say which one is chosen (aria-pressed)', async () => {
    const { container, rerender } = setup({})
    await openModal(rerender)
    const csv = Array.from(container.ownerDocument.querySelectorAll('button')).find(
      (b) => b.textContent === 'CSV — Tabelle'
    )
    await act(async () => {
      fireEvent.click(csv!)
    })
    // The tab bar is the first group of segments in the dialog.
    const pressed = Array.from(container.ownerDocument.querySelectorAll('[aria-pressed]'))
      .slice(0, 3)
      .map((b) => [b.textContent, b.getAttribute('aria-pressed')])
    expect(pressed).toEqual([
      ['PDF — Stundennachweis', 'false'],
      ['CSV — Tabelle', 'true'],
      ['iCal — Kalender', 'false']
    ])
    // The CSV format choices are labels of at least 44 px (HANDOFF §8).
    const radio = container.ownerDocument.querySelector('input[name="csvFormat"]')
    expect(radio?.closest('label')?.className).toContain('min-h-11')
  })
})
