/**
 * Characterization tests for the export entry points (#153).
 *
 * Written against the PRE-move implementation, where the export toolbar lives
 * inside `CalendarView`, and kept green through the move into its own
 * `ExportView`. The move preserved every assertion. Since #433, case 6 uses
 * the fee preference because grouping is no longer remembered.
 *
 * Case 6 is the one that matters, and it took two attempts to get right. The
 * host renders the modal with `key={pdfRange ? ... : 'closed'}` so it REMOUNTS
 * per open. The obvious guard — "reopening with another range updates the date
 * inputs" (case 5) — does NOT protect that `key`: ExportModal also syncs
 * `prefilledRange` into state from an effect (ExportModal.tsx:149-154), so the
 * range arrives with or without a remount. Case 5 was verified to still pass
 * with the `key` prop deleted, i.e. it confirms rather than distinguishes.
 *
 * What the remount actually protects is `initialPrefs` (ExportModal.tsx:46): a
 * LAZY `useState`, evaluated once per mount. Without the remount the modal
 * keeps whichever prefs existed at first mount — at app start that is before
 * the settings load has finished, so the user's stored prefs would never
 * appear. Case 6 pins that by changing the stored prefs between two opens; it
 * was verified to FAIL with the `key` deleted and pass with it in place.
 *
 * Expected dates are computed here from `getQuickRange` + a local formatter
 * instead of being read back from the component, so the test is an oracle and
 * not a mirror.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, cleanup, render, waitFor, within } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import ExportView from './ExportView'
import { I18nProvider } from '../contexts/I18nContext'
import { useSettingsStore } from '../store/settingsStore'
import { DEFAULT_PREFS } from '../components/exportPrefs'
import { getQuickRange, type QuickRangeKind } from '../../../shared/dateRanges'

// `globals` is off in vitest.config.ts, so Testing Library's auto-cleanup
// afterEach is never registered — unmount explicitly or the queries see every
// previous render.
afterEach(cleanup)

it('uses the shared width and an adaptive grid for all export sections (#420)', async () => {
  const { container } = await renderHost()
  const root = container.firstElementChild as HTMLElement
  expect(root.classList.contains('max-w-[920px]')).toBe(false)
  expect(root.classList.contains('w-full')).toBe(true)
  const grid = root.querySelector<HTMLElement>(':scope > .grid')!
  expect(grid).not.toBeNull()
  expect(grid.style.gridTemplateColumns).toBe('repeat(auto-fit, minmax(min(440px, 100%), 1fr))')
  expect(grid.querySelectorAll(':scope > section')).toHaveLength(3)
  expect(grid.classList.contains('[&_p]:max-w-[65ch]')).toBe(true)
})

/** Same local-day formatting the view applies before handing the range over. */
function isoDay(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function expectedRange(kind: QuickRangeKind): { fromIso: string; toIso: string } {
  const r = getQuickRange(kind, new Date())
  return { fromIso: isoDay(r.from), toIso: isoDay(r.to) }
}

// Button labels as the user sees them, spelled out rather than looked up by
// i18n key: the key names move in this refactor, the visible text must not.
const LABEL = {
  lastMonth: '📄 Letzter Monat als PDF',
  thisWeek: 'Diese Woche',
  lastWeek: 'Letzte Woche',
  thisMonth: 'Dieser Monat',
  merge: 'PDFs zusammenführen'
} as const

const EXPORT_DIALOG_TITLE = 'Exportieren'
const MERGE_DIALOG_TITLE = 'PDFs zusammenführen'

type Store = Record<string, string>

/** Mutable settings store so a test can change prefs between two opens. */
function mockApi(initial: Store = {}): Store {
  const store: Store = { ...initial }
  const unsubscribe = (): void => {}
  const api = {
    entries: {
      getByMonth: async () => ({ ok: true as const, data: [] }),
      getRunning: async () => ({ ok: true as const, data: null }),
      heartbeat: async () => ({ ok: true as const, data: undefined })
    },
    projects: { getAll: async () => ({ ok: true as const, data: [] }) },
    clients: { getAll: async () => ({ ok: true as const, data: [] }) },
    billingRuns: { list: async () => ({ ok: true as const, data: [] }) },
    settings: {
      getAll: async () => ({ ok: true as const, data: { ...store } }),
      set: async (key: string, value: string) => {
        store[key] = value
        return { ok: true as const, data: undefined }
      }
    },
    dashboard: { todayTotal: async () => ({ ok: true as const, data: 0 }) },
    tray: { update: () => {} },
    idle: { dismiss: async () => ({ ok: true as const, data: undefined }) },
    onHotkeyToggle: () => unsubscribe,
    onIdleDetected: () => unsubscribe,
    onTrayQuickStart: () => unsubscribe,
    onTrayStop: () => unsubscribe
  }
  ;(window as unknown as { api: typeof api }).api = api
  return store
}

function prefsWith(hideFeeColumn: boolean): string {
  return JSON.stringify({ ...DEFAULT_PREFS, hideFeeColumn })
}

/** The remembered fee switch inside the open export dialog (PDF tab). */
function hideFeeSwitch(): HTMLElement {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!dialog) throw new Error('no dialog open')
  return within(dialog).getByRole('switch', { name: 'Honorar-Spalte ausblenden' })
}

async function loadSettings(): Promise<void> {
  await act(async () => {
    await useSettingsStore.getState().load()
  })
}

interface Rendered {
  container: HTMLElement
}

async function renderHost(): Promise<Rendered> {
  const view = render(
    <I18nProvider>
      <ExportView />
    </I18nProvider>
  )
  // Let any mount effects settle so the toolbar is past its loading state
  // before the first click.
  await act(async () => {})
  return { container: view.container }
}

function clickButton(container: HTMLElement, label: string): void {
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label
  )
  if (!button) throw new Error(`button not found: ${label}`)
  fireEvent.click(button)
}

/** The open dialog's heading, or null when no dialog is mounted. */
function dialogTitle(): string | null {
  // The title id is generated per dialog since PR 5 — follow aria-labelledby.
  const id = document.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')
  return (id && document.getElementById(id)?.textContent?.trim()) || null
}

/** `[from, to]` as currently shown in the export dialog's two date inputs. */
function dateInputValues(): [string, string] {
  const dialog = document.querySelector('[role="dialog"]')
  if (!dialog) throw new Error('no dialog open')
  const inputs = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="date"]'))
  if (inputs.length < 2) throw new Error(`expected 2 date inputs, found ${inputs.length}`)
  return [inputs[0].value, inputs[1].value]
}

function closeDialog(): void {
  fireEvent.keyDown(window, { key: 'Escape' })
}

beforeEach(() => {
  vi.restoreAllMocks()
  mockApi()
})

describe('export entry points (#153 characterization)', () => {
  it('1. no dialog is open before any trigger is clicked', async () => {
    await renderHost()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('2. the hero button opens the export dialog prefilled with last month', async () => {
    const { container } = await renderHost()
    clickButton(container, LABEL.lastMonth)
    await waitFor(() => expect(dialogTitle()).toBe(EXPORT_DIALOG_TITLE))

    const { fromIso, toIso } = expectedRange('lastMonth')
    expect(dateInputValues()).toEqual([fromIso, toIso])
  })

  it.each([
    ['thisWeek', LABEL.thisWeek],
    ['lastWeek', LABEL.lastWeek],
    ['thisMonth', LABEL.thisMonth]
  ] as const)('3. the %s pill opens the export dialog with that range', async (kind, label) => {
    const { container } = await renderHost()
    clickButton(container, label)
    await waitFor(() => expect(dialogTitle()).toBe(EXPORT_DIALOG_TITLE))

    const { fromIso, toIso } = expectedRange(kind)
    expect(dateInputValues()).toEqual([fromIso, toIso])
  })

  it('4. the merge button opens the merge dialog, not the export dialog', async () => {
    const { container } = await renderHost()
    clickButton(container, LABEL.merge)
    await waitFor(() => expect(dialogTitle()).toBe(MERGE_DIALOG_TITLE))

    // The merge dialog has no from/to range — proves we opened the other one.
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.querySelectorAll('input[type="date"]').length).toBe(0)
  })

  it('5. reopening with a different range replaces the prefill', async () => {
    const { container } = await renderHost()

    clickButton(container, LABEL.lastMonth)
    await waitFor(() => expect(dialogTitle()).toBe(EXPORT_DIALOG_TITLE))
    expect(dateInputValues()).toEqual(Object.values(expectedRange('lastMonth')))

    closeDialog()
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())

    clickButton(container, LABEL.thisWeek)
    await waitFor(() => expect(dialogTitle()).toBe(EXPORT_DIALOG_TITLE))

    const thisWeek = expectedRange('thisWeek')
    expect(dateInputValues()).toEqual([thisWeek.fromIso, thisWeek.toIso])
    expect(dateInputValues()).not.toEqual(Object.values(expectedRange('lastMonth')))
  })

  it('6. reopening re-reads stored prefs — the remount contract', async () => {
    // Prefs stored BEFORE the first render, so open #1 proves the modal reads
    // the store at all (hideFeeColumn true is not the false default).
    const store = mockApi({ export_prefs: prefsWith(true) })
    await loadSettings()
    const { container } = await renderHost()

    clickButton(container, LABEL.lastMonth)
    await waitFor(() => expect(dialogTitle()).toBe(EXPORT_DIALOG_TITLE))
    expect(hideFeeSwitch()).toHaveAttribute('aria-checked', 'true')

    closeDialog()
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())

    // A second writer changes the stored prefs while the modal is closed —
    // stands in for the real case, where the settings load simply finishes
    // after the modal's first mount.
    store.export_prefs = prefsWith(false)
    await loadSettings()

    clickButton(container, LABEL.thisWeek)
    await waitFor(() => expect(dialogTitle()).toBe(EXPORT_DIALOG_TITLE))

    // Fails without the remount `key`: the lazy initialPrefs from open #1
    // would still be in state and the switch would remain checked.
    expect(hideFeeSwitch()).toHaveAttribute('aria-checked', 'false')
  })
})
