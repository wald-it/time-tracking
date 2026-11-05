/**
 * Characterization tests for CalendarView (#167): selection and navigation
 * interactions — day click → drawer, roving-tabindex arrow keys, Enter,
 * month paging, "Heute". Written against the implementation to pin
 * observable behavior, not as a spec. Messinstrument PR 3 (HANDOFF §4.2, B4)
 * added the selection state (default = today, `aria-pressed`), the wide
 * layout without drawer, week totals, the month total and the MiniDayScale.
 *
 * jsdom has no `matchMedia`, so the view runs in its NARROW layout (drawer
 * fallback) unless a test installs one.
 *
 * Only `Date` is faked (system time pinned per test) so async loads and
 * `waitFor` run on real timers. Entry timestamps are mid-day UTC, which maps
 * to the same LOCAL day for any timezone between UTC-9 and UTC+11 — the
 * grouping key is the local date.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import CalendarView, { DAY_PANEL_MEDIA_QUERY } from './CalendarView'
import { I18nProvider } from '../contexts/I18nContext'
import { NowProvider } from '../contexts/NowContext'
import { RoundingProvider } from '../contexts/RoundingContext'
import { useTimerStore } from '../store/timerStore'
import { useSettingsStore } from '../store/settingsStore'
import type { Client, Entry, Project } from '../../../shared/types'

// `globals` is off in vitest.config.ts — unmount explicitly (see TagInput test).
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { matchMedia?: unknown }).matchMedia
  useSettingsStore.setState({ settings: null })
})

/** Pretend the window is (not) wide enough for the day panel (DAY_PANEL_MEDIA_QUERY). */
function installMatchMedia(wide: boolean): void {
  ;(window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: wide && query === DAY_PANEL_MEDIA_QUERY,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  })
}

const CLIENTS: Client[] = [
  {
    short_code: null,
    id: 1,
    name: 'Acme',
    color: '#6366f1',
    active: 1,
    rate_cent: 0,
    created_at: '2026-01-01T00:00:00.000Z'
  }
]

function makeEntry(over: Partial<Entry> & Pick<Entry, 'id' | 'started_at'>): Entry {
  return {
    client_id: 1,
    description: '',
    stopped_at: null,
    heartbeat_at: null,
    rounded_min: null,
    deleted_at: null,
    created_at: over.started_at,
    link_id: null,
    tags: '',
    reference: '',
    billable: 1,
    private_note: '',
    project_id: null,
    ...over
  }
}

const AUGUST_ENTRIES: Entry[] = [
  makeEntry({
    id: 1,
    description: 'Standup prep',
    started_at: '2026-08-10T09:00:00.000Z',
    stopped_at: '2026-08-10T10:30:00.000Z'
  }),
  makeEntry({
    id: 2,
    description: 'Review',
    started_at: '2026-08-10T11:00:00.000Z',
    stopped_at: '2026-08-10T12:00:00.000Z'
  }),
  makeEntry({
    id: 3,
    description: 'Deep work',
    started_at: '2026-08-12T09:00:00.000Z',
    stopped_at: '2026-08-12T11:00:00.000Z'
  })
]

/**
 * A row as the view `entries` delivers it with money (2.0 #374): the numbers
 * the calendar shows come with the row, hand-set here, not worked out from a
 * client rate in the test.
 */
function priced(
  e: Entry,
  minutes: number,
  rateCent: number,
  profile: { interval_min?: number; min_unit_min?: number } = {}
): Entry {
  return {
    ...e,
    billed_minutes: minutes,
    rate_cent: rateCent,
    fee_cent: Math.round((rateCent * minutes) / 60),
    interval_min: 0,
    min_unit_min: 0,
    ...profile
  }
}

// AUGUST_ENTRIES at 100 EUR/h: 1:30, 1:00 and 2:00.
const AUGUST_PRICED: Entry[] = [
  priced(AUGUST_ENTRIES[0], 90, 10000),
  priced(AUGUST_ENTRIES[1], 60, 10000),
  priced(AUGUST_ENTRIES[2], 120, 10000)
]

interface Setup {
  getByMonth: ReturnType<typeof vi.fn>
}

/**
 * Pins the clock, mocks the api surface CalendarView + its useTimer() call
 * reach on mount, renders, and waits for the month load to settle.
 */
async function setup(
  opts: {
    now?: string
    byMonth?: Record<string, Entry[]>
    carryovers?: Record<string, Entry[]>
    carryoverFailure?: 'error' | 'reject' | 'throw'
    clients?: Client[]
    projects?: Project[]
    /** The NowProvider ticks every second (as App does while a timer runs). */
    clock?: boolean
    /** Months (`YYYY-M`) whose load answers with an error. */
    failMonths?: string[]
    /** Months (`YYYY-M`) whose load never answers. */
    pendingMonths?: string[]
    /** projects.getAll answers only once this settles. */
    projectsGate?: Promise<void>
    /** projects.getAll answers with an error. */
    projectsFail?: boolean
  } = {}
): Promise<Setup> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(opts.now ?? '2026-08-15T12:00:00.000Z'))
  const clients = opts.clients ?? CLIENTS

  const getByMonth = vi.fn(async ({ year, month }: { year: number; month: number }) => {
    const key = `${year}-${month}`
    if (opts.pendingMonths?.includes(key)) return new Promise<never>(() => {})
    if (opts.failMonths?.includes(key)) return { ok: false as const, error: 'boom' }
    return { ok: true as const, data: opts.byMonth?.[key] ?? [] }
  })
  const api = {
    entries: {
      getByMonth,
      getMonthCarryover: vi.fn(({ year, month }: { year: number; month: number }) => {
        if (opts.carryoverFailure === 'throw') throw new Error('carryovers unavailable')
        if (opts.carryoverFailure === 'reject')
          return Promise.reject(new Error('carryovers unavailable'))
        if (opts.carryoverFailure === 'error')
          return Promise.resolve({ ok: false, error: 'carryovers unavailable' })
        return Promise.resolve({ ok: true, data: opts.carryovers?.[`${year}-${month}`] ?? [] })
      }),
      getRunning: async () => ({ ok: true as const, data: null })
    },
    clients: {
      getAll: async () => ({ ok: true as const, data: clients })
    },
    projects: {
      getAll: async () => {
        await opts.projectsGate
        if (opts.projectsFail) return { ok: false as const, error: 'projects down' }
        return { ok: true as const, data: opts.projects ?? [] }
      }
    },
    dashboard: {
      todayTotal: async () => ({ ok: true as const, data: 0 })
    },
    // The entry form's tag input asks for the known tags.
    tags: {
      getAllWithCount: async () => ({ ok: true as const, data: [] })
    },
    tray: { update: vi.fn() },
    idle: { dismiss: vi.fn() },
    onHotkeyToggle: () => {},
    onTrayQuickStart: () => {},
    onTrayStop: () => {},
    onDataChanged: () => {},
    onIdleDetected: () => {}
  }
  ;(window as unknown as { api: typeof api }).api = api

  // useTimer's module-level init runs only once per test FILE; seed the
  // shared store directly so every test sees the same clients regardless of
  // execution order.
  useTimerStore.setState({ clients })

  // App always wraps the views in these providers; the view reads "now" and
  // the rounding step from them.
  render(
    <I18nProvider>
      <RoundingProvider>
        <NowProvider running={opts.clock ?? false}>
          <CalendarView />
        </NowProvider>
      </RoundingProvider>
    </I18nProvider>
  )
  await waitFor(() => expect(getByMonth).toHaveBeenCalled())
  await waitFor(() => expect(screen.queryByText('Lade…')).toBeNull())
  return { getByMonth }
}

/** The month title (month name + year in one heading). */
function monthHeading(): string | null {
  return screen.getByRole('heading', { level: 1 }).textContent
}

function cell(dayKey: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-day="${dayKey}"]`)
  if (!el) throw new Error(`no grid cell for ${dayKey}`)
  return el
}

describe('CalendarView — day selection', () => {
  it('marks only billed days and entries with a lock chip', async () => {
    await setup({
      byMonth: { '2026-8': AUGUST_ENTRIES.map((e) => ({ ...e, billed: e.id === 1 ? 1 : 0 })) }
    })
    expect(
      within(cell('2026-08-10')).getByText('abgerechnet').parentElement!.querySelector('svg')
    ).not.toBeNull()
    expect(within(cell('2026-08-12')).queryByText('abgerechnet')).toBeNull()
    fireEvent.click(cell('2026-08-10'))
    const drawer = screen.getByRole('dialog', { name: 'Einträge für 10.08.2026' })
    expect(within(drawer).getAllByText('abgerechnet')).toHaveLength(1)
  })
  it("a click on a day opens the drawer with exactly that day's entries", async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })

    fireEvent.click(cell('2026-08-10'))

    const drawer = screen.getByRole('dialog', { name: 'Einträge für 10.08.2026' })
    // Count and day total of exactly this day (1:30 + 1:00; no single entry
    // lasts 2:30, so the total cannot be matched by accident).
    expect(within(drawer).getByText('2 Einträge')).not.toBeNull()
    expect(within(drawer).getByText('2:30')).not.toBeNull()
    expect(within(drawer).getByText('Standup prep')).not.toBeNull()
    expect(within(drawer).getByText('Review')).not.toBeNull()
    // The neighbouring day's entry stays out.
    expect(within(drawer).queryByText('Deep work')).toBeNull()
  })

  it('Escape closes the drawer', async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    fireEvent.click(cell('2026-08-10'))
    expect(screen.queryByRole('dialog')).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Enter opens the drawer for the KEYBOARD-focused day', async () => {
    await setup()
    // Today (15th) starts focused; move one day right, then commit.
    fireEvent.keyDown(cell('2026-08-15'), { key: 'ArrowRight' })
    fireEvent.keyDown(cell('2026-08-16'), { key: 'Enter' })

    const drawer = screen.getByRole('dialog', { name: 'Einträge für 16.08.2026' })
    expect(within(drawer).getByText('Kein Eintrag an diesem Tag.')).not.toBeNull()
  })
})

describe('CalendarView — keyboard navigation', () => {
  it('arrow keys move the focused day; the tabindex roves with it', async () => {
    await setup()
    expect(document.activeElement).toBe(cell('2026-08-15'))

    fireEvent.keyDown(cell('2026-08-15'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(cell('2026-08-16'))
    expect(cell('2026-08-16').tabIndex).toBe(0)
    expect(cell('2026-08-15').tabIndex).toBe(-1)

    fireEvent.keyDown(cell('2026-08-16'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(cell('2026-08-23'))

    fireEvent.keyDown(cell('2026-08-23'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(cell('2026-08-16'))

    fireEvent.keyDown(cell('2026-08-16'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(cell('2026-08-15'))
  })

  it('stepping past the month boundary flips the grid to the next month', async () => {
    const { getByMonth } = await setup({ now: '2026-08-31T12:00:00.000Z' })
    expect(document.activeElement).toBe(cell('2026-08-31'))

    fireEvent.keyDown(cell('2026-08-31'), { key: 'ArrowRight' })

    expect(monthHeading()).toBe('September 2026')
    expect(document.activeElement).toBe(cell('2026-09-01'))
    await waitFor(() => expect(getByMonth).toHaveBeenLastCalledWith({ year: 2026, month: 9 }))
  })
})

describe('CalendarView — month paging', () => {
  it('next/prev buttons page through months and refetch each one', async () => {
    const { getByMonth } = await setup()
    expect(monthHeading()).toBe('August 2026')
    expect(getByMonth).toHaveBeenLastCalledWith({ year: 2026, month: 8 })

    fireEvent.click(screen.getByRole('button', { name: 'Nächster Monat' }))
    expect(monthHeading()).toBe('September 2026')
    await waitFor(() => expect(getByMonth).toHaveBeenLastCalledWith({ year: 2026, month: 9 }))

    fireEvent.click(screen.getByRole('button', { name: 'Vorheriger Monat' }))
    expect(monthHeading()).toBe('August 2026')
    await waitFor(() => expect(getByMonth).toHaveBeenLastCalledWith({ year: 2026, month: 8 }))
  })

  it('"Heute" returns to the current month and refocuses today', async () => {
    await setup()
    fireEvent.click(screen.getByRole('button', { name: 'Nächster Monat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Nächster Monat' }))
    expect(monthHeading()).toBe('Oktober 2026')

    fireEvent.click(screen.getByRole('button', { name: 'Heute' }))

    expect(monthHeading()).toBe('August 2026')
    expect(document.activeElement).toBe(cell('2026-08-15'))
  })
})

describe('CalendarView — day revenue', () => {
  const RATED: Client[] = [{ ...CLIENTS[0], rate_cent: 10000 }]

  it('shows no amount while no client or project has a rate', async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    expect(within(cell('2026-08-10')).queryByTestId('day-revenue')).toBeNull()
  })

  it('sums the fee of the billable rows per day', async () => {
    await setup({ byMonth: { '2026-8': AUGUST_PRICED }, clients: RATED })
    // 1:30 + 1:00 at 100 €/h
    expect(within(cell('2026-08-10')).getByTestId('day-revenue').textContent).toBe('250,00 €')
    expect(within(cell('2026-08-12')).getByTestId('day-revenue').textContent).toBe('200,00 €')
    expect(within(cell('2026-08-11')).queryByTestId('day-revenue')).toBeNull()
  })

  it('shows the fee of the row, not a figure worked out from the client rate', async () => {
    // A rate rise since the day: the client list says 100 €/h, the row says 60 €/h.
    const old = [priced(AUGUST_ENTRIES[1], 60, 6000)]
    await setup({ byMonth: { '2026-8': old }, clients: RATED })
    expect(within(cell('2026-08-10')).getByTestId('day-revenue').textContent).toBe('60,00 €')
  })

  it('leaves non-billable entries out and lets a project rate win', async () => {
    const project: Project = {
      id: 7,
      client_id: 1,
      name: 'Audit',
      color: '',
      rate_cent: 15000,
      active: 1,
      created_at: '2026-01-01T00:00:00.000Z'
    }
    const entries = [
      { ...priced(AUGUST_ENTRIES[0], 90, 15000), project_id: 7 }, // 1:30 at 150 €/h = 225 €
      { ...priced(AUGUST_ENTRIES[1], 60, 10000), billable: 0 } // excluded
    ]
    await setup({ byMonth: { '2026-8': entries }, clients: RATED, projects: [project] })
    await waitFor(() =>
      expect(within(cell('2026-08-10')).getByTestId('day-revenue').textContent).toBe('225,00 €')
    )
  })
})

describe('CalendarView — live running entry', () => {
  // The cell recomputes a running entry's duration at render time. It used to
  // be re-rendered by the timer store's 1 s tick; with that tick gone it must
  // follow the shared clock (NowContext), or the day total freezes.
  it("today's total keeps counting while a timer runs", async () => {
    const running = makeEntry({ id: 9, started_at: '2026-08-15T11:00:00.000Z', stopped_at: null })
    await setup({ byMonth: { '2026-8': [running] }, clock: true })
    const before = within(cell('2026-08-15')).getByTestId('day-total').textContent
    expect(before).toBe('1:00')

    vi.setSystemTime(new Date('2026-08-15T12:02:00.000Z'))
    await waitFor(
      () => expect(within(cell('2026-08-15')).getByTestId('day-total').textContent).toBe('1:02'),
      { timeout: 2500 }
    )
  })
})

/** Local wall-clock timestamp in August 2026, as ISO (the app stores UTC). */
const local = (day: number, h: number, m = 0, s = 0): string =>
  new Date(2026, 7, day, h, m, s, 0).toISOString()

describe('CalendarView — selection state (§4.2.3)', () => {
  it('selects today on open', async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    expect(cell('2026-08-15').getAttribute('aria-pressed')).toBe('true')
    expect(cell('2026-08-10').getAttribute('aria-pressed')).toBe('false')
    // Opening the view does not open the drawer.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a click moves the selection', async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    fireEvent.click(cell('2026-08-10'))
    expect(cell('2026-08-10').getAttribute('aria-pressed')).toBe('true')
    expect(cell('2026-08-15').getAttribute('aria-pressed')).toBe('false')
  })

  it('"Heute" selects today again', async () => {
    installMatchMedia(true)
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    fireEvent.click(cell('2026-08-10'))
    fireEvent.click(screen.getByRole('button', { name: 'Heute' }))
    expect(cell('2026-08-15').getAttribute('aria-pressed')).toBe('true')
    expect(cell('2026-08-10').getAttribute('aria-pressed')).toBe('false')
  })

  it('days outside the month are disabled and carry no scale', async () => {
    await setup()
    // August 2026 starts on a Saturday; the Monday-based grid opens with 27 July.
    const outside = cell('2026-07-27')
    expect((outside as HTMLButtonElement).disabled).toBe(true)
    expect(outside.querySelector('[aria-hidden="true"]')).toBeNull()
    expect((cell('2026-08-03') as HTMLButtonElement).disabled).toBe(false)
    expect(cell('2026-08-03').querySelector('[aria-hidden="true"]')).not.toBeNull()
  })

  it('labels a cell with weekday, date and hours', async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    // AUGUST_ENTRIES are UTC, so the unexplained duration depends on the test
    // zone; its value is pinned with local times in the #482 block below.
    expect(cell('2026-08-10').getAttribute('aria-label')).toMatch(
      /^Montag, 10\. August, 2:30 Stunden · ungeklärt \d+:\d{2}$/
    )
    expect(cell('2026-08-11').getAttribute('aria-label')).toBe(
      'Dienstag, 11. August, keine Einträge'
    )
  })
})

describe('CalendarView — wide layout (B4)', () => {
  it('from the panel width on, a click selects the day but opens no drawer', async () => {
    installMatchMedia(true)
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })

    fireEvent.click(cell('2026-08-10'))

    expect(cell('2026-08-10').getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Enter selects the keyboard-focused day without a drawer', async () => {
    installMatchMedia(true)
    await setup()
    fireEvent.keyDown(cell('2026-08-15'), { key: 'ArrowRight' })
    fireEvent.keyDown(cell('2026-08-16'), { key: 'Enter' })

    expect(cell('2026-08-16').getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('below the panel width the drawer stays the fallback', async () => {
    installMatchMedia(false)
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    fireEvent.click(cell('2026-08-10'))
    expect(screen.getByRole('dialog', { name: 'Einträge für 10.08.2026' })).not.toBeNull()
  })
})

describe('CalendarView — totals', () => {
  it('shows the raw month total in the header', async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    // 1:30 + 1:00 + 2:00
    expect(screen.getByTestId('month-total').textContent).toBe('4:30')
    expect(screen.getByText('Summe August')).not.toBeNull()
  })

  it('sums each week in the KW column and shows "–" for an empty week', async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    const weeks = screen.getAllByTestId('week-total').map((el) => el.textContent)
    // Rows start 27.7., 3.8., 10.8., 17.8., 24.8., 31.8.
    expect(weeks).toEqual(['–', '–', '4:30', '–', '–', '–'])
  })

  it('shows the day total raw, not rounded', async () => {
    useSettingsStore.setState({ settings: { pdf_round_minutes: '15' } as unknown as never })
    // The row carries the billed 15 minutes of its 15-minute profile.
    const odd = [
      priced(
        makeEntry({ id: 21, started_at: local(10, 9, 0), stopped_at: local(10, 9, 7) }),
        15,
        0,
        {
          interval_min: 15
        }
      )
    ]
    await setup({ byMonth: { '2026-8': odd } })
    const total = within(cell('2026-08-10')).getByTestId('day-total')
    expect(total.textContent).toBe('0:07')
    // The rounded value is only an addition (tooltip).
    expect(total.getAttribute('title')).toBe('gerundet 0:15 h · 15-min-Takt')
  })

  it('names the minimum in the tooltip when a minimum unit lifts the day', async () => {
    useSettingsStore.setState({ settings: { pdf_round_minutes: '15' } as unknown as never })
    const lifted = [
      priced(
        makeEntry({ id: 22, started_at: local(10, 9, 0), stopped_at: local(10, 9, 3) }),
        15,
        0,
        { interval_min: 0, min_unit_min: 15 }
      )
    ]
    await setup({ byMonth: { '2026-8': lifted } })
    const total = within(cell('2026-08-10')).getByTestId('day-total')
    expect(total.getAttribute('title')).toBe('gerundet 0:15 h · mind. 15 Min')
  })

  it('a mixed day sums billed minutes throughout and names no step', async () => {
    useSettingsStore.setState({ settings: { pdf_round_minutes: '15' } as unknown as never })
    // 3:01 raw without a profile (billed 4) next to a 15-minute-step row (billed 15): 19, not 18.
    const mixed = [
      priced(
        makeEntry({ id: 23, started_at: local(10, 9, 0), stopped_at: local(10, 9, 3, 1) }),
        4,
        0
      ),
      priced(
        makeEntry({ id: 24, started_at: local(10, 10, 0), stopped_at: local(10, 10, 5) }),
        15,
        0,
        { interval_min: 15 }
      )
    ]
    await setup({ byMonth: { '2026-8': mixed } })
    const total = within(cell('2026-08-10')).getByTestId('day-total')
    expect(total.getAttribute('title')).toBe('gerundet 0:19 h')
  })
})

describe('CalendarView — MiniDayScale (§3.9)', () => {
  it('draws one bar per entry of the day', async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    expect(within(cell('2026-08-10')).getAllByTestId('mini-bar')).toHaveLength(2)
    expect(within(cell('2026-08-12')).getAllByTestId('mini-bar')).toHaveLength(1)
    expect(within(cell('2026-08-11')).queryAllByTestId('mini-bar')).toHaveLength(0)
  })

  it("puts the needle only into today's cell and hatches the running entry", async () => {
    const running = makeEntry({ id: 9, started_at: '2026-08-15T11:00:00.000Z', stopped_at: null })
    await setup({ byMonth: { '2026-8': [...AUGUST_ENTRIES, running] } })
    expect(document.querySelectorAll('[data-testid="mini-needle"]')).toHaveLength(1)
    expect(within(cell('2026-08-15')).getByTestId('mini-needle')).not.toBeNull()
    expect(within(cell('2026-08-15')).getByTestId('mini-bar').dataset.running).toBe('true')
    expect(within(cell('2026-08-10')).getAllByTestId('mini-bar')[0].dataset.running).toBeUndefined()
  })

  it('uses one range for the whole month and names it in the footnote', async () => {
    const early = makeEntry({ id: 30, started_at: local(3, 5, 30), stopped_at: local(3, 6, 30) })
    const late = makeEntry({ id: 31, started_at: local(20, 9, 0), stopped_at: local(20, 10, 0) })
    await setup({ byMonth: { '2026-8': [early, late] } })
    // An early start on the 3rd widens the scale of EVERY cell.
    expect(screen.getByText('Skala je Tag 05–20 Uhr · schraffiert = läuft')).not.toBeNull()
    // 09:00 on the 20th sits at 4/15 of the shared 05–20 range, not at 2/13.
    const bar = within(cell('2026-08-20')).getByTestId('mini-bar')
    expect(parseFloat(bar.style.left)).toBeCloseTo((4 / 15) * 100, 2)
  })

  it('keeps the default 07–20 range when everything fits', async () => {
    const fits = [makeEntry({ id: 40, started_at: local(3, 9, 0), stopped_at: local(3, 19, 30) })]
    await setup({ byMonth: { '2026-8': fits } })
    expect(screen.getByText('Skala je Tag 07–20 Uhr · schraffiert = läuft')).not.toBeNull()
  })
})

describe('CalendarView — header follows week_start', () => {
  it('starts the weekday header on Sunday when the week does', async () => {
    useSettingsStore.setState({ settings: { week_start: 'sunday' } as unknown as never })
    await setup()
    const heads = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'].map((h) => screen.getByText(h))
    for (let i = 1; i < heads.length; i++) {
      expect(
        heads[i - 1].compareDocumentPosition(heads[i]) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    }
    // …and the first grid row starts on a Sunday (26 July).
    expect(document.querySelector('[data-day]')?.getAttribute('data-day')).toBe('2026-07-26')
  })
})

describe('CalendarView — selection follows the shown month', () => {
  // The panel shows the selected day; after paging away from it, a day of the
  // shown month must stand in (the 1st, or today in the current month) —
  // otherwise the panel would show an unloaded, seemingly empty day.
  it('paging to the next month selects its 1st; back again selects today', async () => {
    await setup()
    expect(cell('2026-08-15').getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Nächster Monat' }))
    await waitFor(() => expect(cell('2026-09-01').getAttribute('aria-pressed')).toBe('true'))

    fireEvent.click(screen.getByRole('button', { name: 'Vorheriger Monat' }))
    await waitFor(() => expect(cell('2026-08-15').getAttribute('aria-pressed')).toBe('true'))
  })
})

describe('CalendarView — review fixes (PR 3)', () => {
  it('an entry of the next local month in the response counts nowhere', async () => {
    // getByMonth cuts at local boundaries now; should it ever return an entry
    // of the next month again, it has no cell and must not count.
    const stray = makeEntry({
      id: 99,
      started_at: new Date(2026, 8, 1, 0, 30).toISOString(),
      stopped_at: new Date(2026, 8, 1, 2, 30).toISOString()
    })
    await setup({ byMonth: { '2026-8': [...AUGUST_ENTRIES, stray] } })
    // 1:30 + 1:00 + 2:00 — the stray two hours stay out.
    expect(screen.getByTestId('month-total').textContent).toBe('4:30')
  })

  it('widening to the panel closes the drawer for good', async () => {
    let wide = false
    const listeners = new Set<() => void>()
    ;(window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
      get matches() {
        return wide && query === DAY_PANEL_MEDIA_QUERY
      },
      media: query,
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb)
    })
    const flip = (w: boolean): void => {
      wide = w
      act(() => listeners.forEach((cb) => cb()))
    }
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    fireEvent.click(cell('2026-08-10'))
    expect(screen.queryByRole('dialog')).not.toBeNull()

    flip(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    flip(false)
    // Not reopened by itself.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it("the cell's accessible name carries the amount (narrow cells hide the euro line)", async () => {
    await setup({
      byMonth: { '2026-8': AUGUST_PRICED },
      clients: [{ ...CLIENTS[0], rate_cent: 10000 }]
    })
    expect(cell('2026-08-10').getAttribute('aria-label')).toContain('250,00 €')
  })
})

describe('CalendarView — day details', () => {
  it("shows the day's amount in the details (narrow cells hide it)", async () => {
    await setup({
      byMonth: { '2026-8': AUGUST_PRICED },
      clients: [{ ...CLIENTS[0], rate_cent: 10000 }]
    })
    fireEvent.click(cell('2026-08-10'))
    const drawer = screen.getByRole('dialog', { name: 'Einträge für 10.08.2026' })
    expect(within(drawer).getByTestId('details-revenue').textContent).toBe('250,00 €')
  })

  it('Escape belongs to a dialog on top, not to the day details underneath', async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    fireEvent.click(cell('2026-08-10'))
    const foreign = document.createElement('div')
    foreign.setAttribute('role', 'dialog')
    document.body.appendChild(foreign)
    try {
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.queryByRole('dialog', { name: 'Einträge für 10.08.2026' })).not.toBeNull()
    } finally {
      foreign.remove()
    }
  })
})

describe('CalendarView — final review fixes (PR 3)', () => {
  const RATED: Client[] = [{ ...CLIENTS[0], rate_cent: 10000 }]
  const GOODWILL: Project = {
    id: 8,
    client_id: 1,
    name: 'Kulanz',
    color: '',
    rate_cent: 0,
    active: 1,
    created_at: '2026-01-01T00:00:00.000Z'
  }
  // 10 Aug on the goodwill project (no amount), 12 Aug at the client rate.
  const MIXED = [
    { ...priced(AUGUST_ENTRIES[0], 90, 0), project_id: 8 },
    { ...priced(AUGUST_ENTRIES[1], 60, 0), project_id: 8 },
    AUGUST_PRICED[2]
  ]

  function breakdown(): HTMLElement {
    return screen.getByRole('region', { name: /nach Kunde/ })
  }

  it("a failed load of the next month does not show the old month's figures under its name", async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES }, failMonths: ['2026-9'] })
    expect(screen.getByTestId('month-total').textContent).toBe('4:30')

    fireEvent.click(screen.getByRole('button', { name: 'Nächster Monat' }))
    await waitFor(() => expect(monthHeading()).toContain('September'))
    await waitFor(() => expect(screen.getByTestId('month-total').textContent).toBe('0:00'))
    expect(within(breakdown()).queryByText('Acme')).toBeNull()
  })

  it("while the next month loads, the old month's figures are gone already", async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES }, pendingMonths: ['2026-9'] })
    fireEvent.click(screen.getByRole('button', { name: 'Nächster Monat' }))
    expect(monthHeading()).toContain('September')
    expect(screen.getByTestId('month-total').textContent).toBe('0:00')
  })

  it('prices a day from its rows, without waiting for the project rates', async () => {
    let release!: () => void
    const projectsGate = new Promise<void>((r) => (release = r))
    await setup({
      byMonth: { '2026-8': MIXED },
      clients: RATED,
      projects: [GOODWILL],
      projectsGate
    })
    // The goodwill day carries a fee of 0 in its rows, so the order of the
    // loads cannot price it at the client rate (before 2.0 it could).
    expect(within(cell('2026-08-10')).queryByTestId('day-revenue')).toBeNull()
    expect(within(cell('2026-08-12')).getByTestId('day-revenue').textContent).toBe('200,00 €')
    expect(within(cell('2026-08-10')).getByTestId('day-total').textContent).toBe('2:30')
    expect(screen.getByTestId('month-total').textContent).toBe('4:30')

    await act(async () => release())
    await waitFor(() =>
      expect(within(cell('2026-08-12')).getByTestId('day-revenue').textContent).toBe('200,00 €')
    )
    expect(within(cell('2026-08-10')).queryByTestId('day-revenue')).toBeNull()
  })

  it('a failed project load keeps the hours and the amounts of the rows and says so', async () => {
    await setup({ byMonth: { '2026-8': MIXED }, clients: RATED, projectsFail: true })
    await waitFor(() => expect(screen.getByText('Fehler beim Laden')).toBeTruthy())
    expect(screen.getByTestId('month-total').textContent).toBe('4:30')
    expect(within(cell('2026-08-12')).getByTestId('day-total').textContent).toBe('2:00')
    // The amount comes with the rows (2.0), it no longer depends on the project rates.
    expect(within(cell('2026-08-12')).getByTestId('day-revenue').textContent).toBe('200,00 €')
    expect(cell('2026-08-12').getAttribute('aria-label')).toContain('200,00 €')

    fireEvent.click(cell('2026-08-12'))
    const drawer = screen.getByRole('dialog', { name: 'Einträge für 12.08.2026' })
    expect(within(drawer).getByTestId('details-revenue').textContent).toBe('200,00 €')
  })

  it('the day panel prices a goodwill day right from the first render', async () => {
    installMatchMedia(true)
    await setup({ byMonth: { '2026-8': MIXED }, clients: RATED, projects: [GOODWILL] })
    await waitFor(() =>
      expect(within(cell('2026-08-12')).getByTestId('day-revenue').textContent).toBe('200,00 €')
    )
    fireEvent.click(cell('2026-08-10'))
    // Synchronously after the click: the panel must not start at client rates.
    expect(screen.queryByTestId('details-revenue')).toBeNull()
  })

  it('under a tag filter the amount covers the same entries as the hours', async () => {
    const tagged = [
      { ...AUGUST_PRICED[0], tags: ',konzept,' }, // 1:30 = 150 €
      AUGUST_PRICED[1] // 1:00 = 100 €
    ]
    await setup({ byMonth: { '2026-8': tagged }, clients: RATED })
    fireEvent.click(cell('2026-08-10'))
    const drawer = screen.getByRole('dialog', { name: 'Einträge für 10.08.2026' })
    expect(within(drawer).getByTestId('details-revenue').textContent).toBe('250,00 €')

    fireEvent.click(within(drawer).getByRole('button', { name: '#konzept' }))
    expect(within(drawer).getByTestId('details-revenue').textContent).toBe('150,00 €')
  })
})

describe('CalendarView — open form holds back the panel/drawer switch (PR 3)', () => {
  /** matchMedia whose answer can be flipped, with change listeners. */
  function flippableMatchMedia(initialWide: boolean): (wide: boolean) => void {
    let wide = initialWide
    const listeners = new Set<() => void>()
    ;(window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
      get matches() {
        return wide && query === DAY_PANEL_MEDIA_QUERY
      },
      media: query,
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb)
    })
    return (w: boolean) => {
      wide = w
      act(() => listeners.forEach((cb) => cb()))
    }
  }

  function textarea(): HTMLTextAreaElement | null {
    return document.querySelector('textarea')
  }

  it('narrowing keeps the panel and the typed input while an edit is open', async () => {
    const flip = flippableMatchMedia(true)
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    fireEvent.click(cell('2026-08-10'))
    fireEvent.click(screen.getAllByRole('button', { name: 'Bearbeiten' })[0])
    fireEvent.change(textarea()!, { target: { value: 'half typed' } })

    flip(false)
    expect(textarea()?.value).toBe('half typed')
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }))
    // Back to what the width says: no panel, and no drawer either.
    expect(screen.queryByText('Ausgewählter Tag')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('widening keeps the drawer and the typed input while an edit is open', async () => {
    const flip = flippableMatchMedia(false)
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    fireEvent.click(cell('2026-08-10'))
    const drawer = screen.getByRole('dialog', { name: 'Einträge für 10.08.2026' })
    fireEvent.click(within(drawer).getAllByRole('button', { name: 'Bearbeiten' })[0])
    fireEvent.change(drawer.querySelector('textarea')!, { target: { value: 'half typed' } })

    flip(true)
    const still = screen.getByRole('dialog', { name: 'Einträge für 10.08.2026' })
    expect(still.querySelector('textarea')?.value).toBe('half typed')

    fireEvent.click(within(still).getByRole('button', { name: 'Abbrechen' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closing an edit with Escape hands focus back to its edit key in the drawer', async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    fireEvent.click(cell('2026-08-10'))
    const drawer = screen.getByRole('dialog', { name: 'Einträge für 10.08.2026' })
    fireEvent.click(within(drawer).getAllByRole('button', { name: 'Bearbeiten' })[0])
    drawer.querySelector('textarea')!.focus()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(drawer.querySelector('textarea')).toBeNull()
    // The first entry's edit key again (re-rendered after the form closed).
    expect(document.activeElement).toBe(
      within(drawer).getAllByRole('button', { name: 'Bearbeiten' })[0]
    )
  })

  it('closing the backfill form hands focus back to the backfill key', async () => {
    await setup({ byMonth: { '2026-8': AUGUST_ENTRIES } })
    fireEvent.click(cell('2026-08-10'))
    const drawer = screen.getByRole('dialog', { name: 'Einträge für 10.08.2026' })
    fireEvent.click(within(drawer).getByRole('button', { name: /Eintrag für .* nachtragen/ }))
    drawer.querySelector('textarea')!.focus()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.activeElement).toBe(
      within(drawer).getByRole('button', { name: /Eintrag für .* nachtragen/ })
    )
  })
})

describe('CalendarView — unexplained time (#482)', () => {
  const localTime = (day: number, hour: number): string =>
    new Date(2026, 7, day, hour).toISOString()
  const row = (day: number, start: number, end: number): Entry =>
    makeEntry({ id: day, started_at: localTime(day, start), stopped_at: localTime(day, end) })

  it.each([
    ['de', 'ungeklärt 9:00'],
    ['en', 'unexplained 9:00']
  ])(
    'marks only past in-month workdays with gaps in %s, with duration in aria and title',
    async (language, label) => {
      useSettingsStore.setState({ settings: { language } as unknown as never })
      await setup({
        now: localTime(17, 12),
        byMonth: {
          '2026-8': [
            row(10, 9, 10), // past workday, nine hours uncovered
            row(11, 8, 18), // covered workday
            row(15, 9, 10), // Saturday
            row(17, 9, 10), // today, a Monday
            row(18, 9, 10) // future workday
          ]
        }
      })
      const past = cell('2026-08-10')
      const tick = within(past).getByTestId('unexplained-tick')
      expect(tick.getAttribute('aria-hidden')).toBe('true')
      expect(tick.textContent).toBe('')
      expect(past.getAttribute('aria-label')).toMatch(new RegExp(` · ${label}$`))
      expect(past.getAttribute('title')).toBe(label)
      expect(past.textContent).not.toContain(label)
      for (const day of [
        '2026-07-27',
        '2026-08-11',
        '2026-08-12',
        '2026-08-15',
        '2026-08-17',
        '2026-08-18'
      ]) {
        expect(within(cell(day)).queryByTestId('unexplained-tick')).toBeNull()
        expect(cell(day).getAttribute('aria-label')).not.toMatch(/ungeklärt|unexplained/)
        expect(cell(day).getAttribute('title')).toBeNull()
      }
    }
  )

  it('appends the duration to the existing revenue title and retains billed status', async () => {
    await setup({ byMonth: { '2026-8': [{ ...priced(row(10, 9, 10), 60, 10000), billed: 1 }] } })
    const day = cell('2026-08-10')
    expect(day.getAttribute('aria-label')).toBe(
      'Montag, 10. August, 1:00 Stunden · 100,00 € · abgerechnet · ungeklärt 9:00'
    )
    expect(within(day).getByTestId('day-number').parentElement?.getAttribute('title')).toBe(
      '100,00 € · ungeklärt 9:00'
    )
  })

  it('uses working_hours from the settings store, including configured weekend workdays', async () => {
    useSettingsStore.setState({
      settings: {
        working_hours: JSON.stringify({ start: '09:00', end: '12:00', days: [6] })
      } as unknown as never
    })
    await setup({
      now: localTime(17, 12),
      byMonth: { '2026-8': [row(10, 9, 10), row(15, 9, 10)] }
    })
    expect(within(cell('2026-08-10')).queryByTestId('unexplained-tick')).toBeNull()
    expect(cell('2026-08-15').getAttribute('aria-label')).toContain(' · ungeklärt 2:00')
  })

  it.each([false, true])(
    'clips a previous-day carryover for coverage without adding it to cell hours (running: %s)',
    async (running) => {
      const carryover = makeEntry({
        id: 90,
        started_at: localTime(9, 23),
        stopped_at: running ? null : localTime(10, 9)
      })
      await setup({ byMonth: { '2026-8': [carryover, row(10, 9, 18)] } })
      const day = cell('2026-08-10')
      expect(within(day).getByTestId('day-total').textContent).toBe('9:00')
      expect(within(day).queryByTestId('unexplained-tick')).toBeNull()
      expect(day.getAttribute('aria-label')).toBe('Montag, 10. August, 9:00 Stunden')
    }
  )

  it('does not let carryover alone qualify a day, and retains a genuine remaining gap', async () => {
    const carryover = makeEntry({
      id: 90,
      started_at: localTime(9, 23),
      stopped_at: localTime(10, 9)
    })
    const nextCarryover = makeEntry({
      id: 91,
      started_at: localTime(11, 23),
      stopped_at: localTime(12, 9)
    })
    await setup({ byMonth: { '2026-8': [carryover, row(10, 10, 18), nextCarryover] } })
    expect(cell('2026-08-10').getAttribute('aria-label')).toContain(' · ungeklärt 1:00')
    expect(within(cell('2026-08-12')).queryByTestId('unexplained-tick')).toBeNull()
    expect(cell('2026-08-12').getAttribute('aria-label')).toBe(
      'Mittwoch, 12. August, keine Einträge'
    )
  })

  it('keeps the month guard: a prior-month carryover cannot cover day 1', async () => {
    const own = makeEntry({
      id: 1,
      started_at: new Date(2026, 8, 1, 9).toISOString(),
      stopped_at: new Date(2026, 8, 1, 18).toISOString()
    })
    const outside = makeEntry({
      id: 2,
      started_at: localTime(31, 23),
      stopped_at: new Date(2026, 8, 1, 9).toISOString()
    })
    await setup({
      now: new Date(2026, 8, 2, 12).toISOString(),
      byMonth: { '2026-9': [outside, own] }
    })
    expect(cell('2026-09-01').getAttribute('aria-label')).toContain(' · ungeklärt 1:00')
    expect(screen.getByTestId('month-total').textContent).toBe('9:00')
    expect(within(cell('2026-08-31')).queryByTestId('unexplained-tick')).toBeNull()
  })
})

describe('CalendarView — month carryover (#489)', () => {
  const own = makeEntry({
    id: 489,
    description: 'November work',
    started_at: new Date(2026, 10, 1, 10).toISOString(),
    stopped_at: new Date(2026, 10, 1, 12).toISOString()
  })
  const carryover = makeEntry({
    id: 490,
    description: 'October carryover',
    started_at: new Date(2026, 9, 31, 22).toISOString(),
    stopped_at: new Date(2026, 10, 1, 9).toISOString()
  })

  async function mount(
    carryovers: Entry[],
    carryoverFailure?: 'error' | 'reject' | 'throw'
  ): Promise<void> {
    // November 1 is a Sunday: explicitly configure it as a workday.
    useSettingsStore.setState({
      settings: {
        working_hours: JSON.stringify({ start: '08:00', end: '18:00', days: [0] })
      } as unknown as never
    })
    await setup({
      now: new Date(2026, 10, 5, 12).toISOString(),
      byMonth: { '2026-11': [own] },
      carryovers: { '2026-11': carryovers },
      carryoverFailure
    })
  }

  it.each([false, true])('covers day 1 in the cell and selected day (wide=%s)', async (wide) => {
    installMatchMedia(wide)
    await mount([carryover])
    const day = cell('2026-11-01')
    expect(day.getAttribute('title')).toBe('ungeklärt 7:00')
    expect(day.getAttribute('aria-label')).toContain(' · ungeklärt 7:00')
    expect(within(day).getByTestId('unexplained-tick')).toBeInTheDocument()
    expect(within(day).getByTestId('day-total')).toHaveTextContent('2:00')
    expect(screen.getByTestId('month-total')).toHaveTextContent('2:00')
    expect(screen.getAllByTestId('week-total').map((el) => el.textContent)).toEqual([
      '2:00',
      '–',
      '–',
      '–',
      '–',
      '–'
    ])
    fireEvent.click(day)
    expect(
      screen.getByRole('button', { name: 'Lücke 09:00–10:00 · ungeklärt 1:00 · nachtragen' })
    ).toBeInTheDocument()
    expect(screen.queryByText('October carryover')).toBeNull()
    expect(screen.getByText('November work')).toBeInTheDocument()
  })

  it.each([undefined, 'error', 'reject', 'throw'] as const)(
    'keeps the calendar and unchanged totals without carryover coverage (%s)',
    async (failure) => {
      await mount(failure ? [carryover] : [], failure)
      expect(cell('2026-11-01').getAttribute('title')).toBe('ungeklärt 8:00')
      expect(within(cell('2026-11-01')).getByTestId('unexplained-tick')).toBeInTheDocument()
      expect(screen.getByTestId('month-total')).toHaveTextContent('2:00')
      expect(screen.getAllByTestId('week-total').map((el) => el.textContent)).toEqual([
        '2:00',
        '–',
        '–',
        '–',
        '–',
        '–'
      ])
    }
  )
})

describe('CalendarView — gap backfill (#483)', () => {
  const localTime = (day: number, hour: number, minute = 0, second = 0): string =>
    new Date(2026, 7, day, hour, minute, second).toISOString()
  const rows = [
    makeEntry({
      id: 101,
      started_at: localTime(10, 9),
      stopped_at: localTime(10, 10, 0, 37),
      tags: ',alpha,'
    }),
    makeEntry({
      id: 102,
      started_at: localTime(10, 11, 0, 42),
      stopped_at: localTime(10, 18),
      tags: ',beta,'
    })
  ]
  const gapLabel = 'Lücke 10:00–11:00 · ungeklärt 1:00 · nachtragen'
  const value = (label: string): string => (screen.getByLabelText(label) as HTMLInputElement).value

  it.each([true, false])(
    'shows ordered gap buttons and opens a minute-safe form (wide=%s)',
    async (wide) => {
      installMatchMedia(wide)
      await setup({ now: localTime(17, 12), byMonth: { '2026-8': rows } })
      fireEvent.click(cell('2026-08-10'))
      expect(screen.getByText('Lücken')).not.toBeNull()
      const buttons = screen.getAllByRole('button', { name: /^Lücke / })
      expect(buttons.map((button) => button.textContent)).toEqual([
        '08:00–09:00 · 1:00',
        '10:00–11:00 · 1:00'
      ])
      expect(buttons[1].getAttribute('title')).toBe(gapLabel)
      fireEvent.click(buttons[1])
      expect(value('Datum')).toBe('2026-08-10')
      expect(value('Start')).toBe('10:01')
      expect(value('Ende')).toBe('11:00')
      expect((buttons[0] as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(buttons[0])
      expect(document.querySelectorAll('form')).toHaveLength(1)
      expect(value('Start')).toBe('10:01')
    }
  )

  it('opens the latest gap from the backfill key, even with a tag filter', async () => {
    installMatchMedia(true)
    await setup({ now: localTime(17, 12), byMonth: { '2026-8': rows } })
    fireEvent.click(cell('2026-08-10'))
    fireEvent.click(screen.getByRole('button', { name: '#alpha' }))
    expect(screen.getAllByRole('button', { name: /^Lücke / })).toHaveLength(2)
    expect(screen.getByRole('button', { name: gapLabel })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Eintrag für .* nachtragen/ }))
    expect(value('Start')).toBe('10:01')
    expect(value('Ende')).toBe('11:00')
  })

  it.each([
    { label: 'empty day', entries: [] },
    {
      label: 'covered day',
      entries: [makeEntry({ id: 103, started_at: localTime(10, 8), stopped_at: localTime(10, 18) })]
    }
  ])('keeps the 09:00 default and has no gap row without gaps ($label)', async ({ entries }) => {
    installMatchMedia(true)
    await setup({ now: localTime(17, 12), byMonth: { '2026-8': entries } })
    fireEvent.click(cell('2026-08-10'))
    expect(screen.queryByText('Lücken')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Lücke / })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Eintrag für .* nachtragen/ }))
    expect(value('Datum')).toBe('2026-08-10')
    expect(value('Start')).toBe('09:00')
    expect(value('Ende')).toBe('10:00')
  })

  it('shows today gaps capped at now but no future gaps', async () => {
    installMatchMedia(true)
    await setup({
      now: localTime(10, 12),
      byMonth: {
        '2026-8': [
          rows[0],
          makeEntry({ id: 104, started_at: localTime(11, 9), stopped_at: localTime(11, 10) })
        ]
      }
    })
    expect(
      screen.getByRole('button', { name: 'Lücke 10:00–12:00 · ungeklärt 1:59 · nachtragen' })
    ).not.toBeNull()
    fireEvent.click(cell('2026-08-11'))
    expect(screen.queryByText('Lücken')).toBeNull()
  })

  it('uses carryovers for panel coverage without making carryover-only days eligible', async () => {
    installMatchMedia(true)
    await setup({
      now: localTime(17, 12),
      byMonth: {
        '2026-8': [
          makeEntry({ id: 105, started_at: localTime(9, 23), stopped_at: localTime(10, 9) }),
          rows[1],
          makeEntry({ id: 106, started_at: localTime(11, 23), stopped_at: localTime(12, 9) })
        ]
      }
    })
    fireEvent.click(cell('2026-08-10'))
    expect(screen.getAllByRole('button', { name: /^Lücke / })).toHaveLength(1)
    expect(
      screen.getByRole('button', { name: 'Lücke 09:00–11:00 · ungeklärt 2:00 · nachtragen' })
    ).not.toBeNull()
    fireEvent.click(cell('2026-08-12'))
    expect(screen.queryByText('Lücken')).toBeNull()
  })

  it('translates the row and gap labels into English', async () => {
    installMatchMedia(true)
    useSettingsStore.setState({ settings: { language: 'en' } as unknown as never })
    await setup({ now: localTime(17, 12), byMonth: { '2026-8': rows } })
    fireEvent.click(cell('2026-08-10'))
    expect(screen.getByText('Gaps')).not.toBeNull()
    expect(
      screen
        .getByRole('button', { name: 'Gap 10:00–11:00 · unexplained 1:00 · add entry' })
        .getAttribute('title')
    ).toBe('Gap 10:00–11:00 · unexplained 1:00 · add entry')
  })
})
