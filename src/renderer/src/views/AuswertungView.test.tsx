/**
 * AuswertungView (Messinstrument PR 4, HANDOFF §4.3, §3.6, §3.15, B2).
 *
 * Pins the owner decisions of 2026-10-22: the hours KPI shows worked time
 * raw (no second rounding of the sum), the "gerundet" sub-line comes only
 * from `hoursRounded`, deltas compare raw with raw, and the header note says
 * which comparison applies.
 *
 * Only `Date` is faked so async loads and `waitFor` run on real timers.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import AuswertungView from './AuswertungView'
import { I18nProvider } from '../contexts/I18nContext'
import { NowProvider } from '../contexts/NowContext'
import { RoundingProvider } from '../contexts/RoundingContext'
import { useSettingsStore } from '../store/settingsStore'
import type { AnalyticsSummary, Settings } from '../../../shared/types'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useSettingsStore.setState({ settings: null })
})

const H = 3600

function summary(over: Partial<AnalyticsSummary['month']> = {}): AnalyticsSummary {
  return {
    month: {
      hours: 126 * H + 2 * 60 + 30, // 126:02:30 raw
      hoursRounded: 127 * H,
      roundingRule: { kind: 'interval', minutes: 15 },
      hoursPrev: 118 * H + 45 * 60,
      revenue: 1_307_800,
      revenuePrev: 1_214_000,
      billable: 0.89,
      billablePrev: 0.91,
      daysElapsed: 22,
      daysInMonth: 31,
      comparison: 'samePeriod',
      prevPeriodDays: 22,
      hasData: true,
      hasRateConfigured: true,
      ...over
    },
    weeks: [],
    months: [],
    byClient: [
      {
        client_id: 1,
        name: 'Nordlicht',
        color: '#1f4fa8',
        h: 59 * H + 7 * 60,
        b: 59 * H + 7 * 60,
        rev: 679_800
      },
      {
        client_id: 2,
        name: 'Brandt',
        color: '#d4a017',
        h: 26 * H + 55 * 60,
        b: 26 * H + 55 * 60,
        rev: 336_400
      },
      { client_id: 3, name: 'wald-it intern', color: '#e07aa8', h: 13 * H + 30 * 60, b: 0, rev: 0 }
    ],
    weekday: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d, i) => ({
      d,
      h: i < 5 ? 8 * H : 30 * 60
    }))
  }
}

async function setup(
  opts: {
    now?: Date
    data?: (q: { year: number; month: number }) => AnalyticsSummary
    roundMinutes?: number
    settings?: Partial<Settings>
  } = {}
): Promise<{ getSummary: ReturnType<typeof vi.fn> }> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(opts.now ?? new Date(2026, 9, 22, 10, 0))
  if (opts.roundMinutes) {
    useSettingsStore.setState({
      settings: { pdf_round_minutes: String(opts.roundMinutes) } as unknown as Settings
    })
  }
  if (opts.settings) {
    useSettingsStore.setState({ settings: opts.settings as Settings })
  }
  const getSummary = vi.fn(async (q: { year: number; month: number }) => ({
    ok: true as const,
    data: (opts.data ?? (() => summary()))(q)
  }))
  ;(window as unknown as { api: unknown }).api = { analytics: { getSummary } }

  render(
    <I18nProvider>
      <RoundingProvider>
        <NowProvider running={false}>
          <AuswertungView />
        </NowProvider>
      </RoundingProvider>
    </I18nProvider>
  )
  await waitFor(() => expect(getSummary).toHaveBeenCalled())
  await waitFor(() =>
    expect(screen.queryAllByRole('heading', { level: 2 }).length).toBeGreaterThan(0)
  )
  return { getSummary }
}

/** The KPI block whose legend is `legend`. */
function kpi(legend: string): HTMLElement {
  const el = screen.getByText(legend, { selector: 'div' }).parentElement
  if (!el) throw new Error(`no KPI ${legend}`)
  return el
}

describe('AuswertungView — KPI row', () => {
  it('shows worked time raw, not the rounded sum, with the rounded sub-line from hoursRounded', async () => {
    await setup({ roundMinutes: 30 })
    const hours = kpi('Stunden')
    expect(within(hours).getByText('126:02')).toBeTruthy()
    expect(within(hours).queryByText('126:15')).toBeNull()
    await waitFor(() =>
      expect(within(hours).getByText('gerundet 127:00 h · 15-min-Takt')).toBeTruthy()
    )
  })

  it('names the minimum from the month instead of the global interval', async () => {
    await setup({
      roundMinutes: 15,
      data: () => summary({ roundingRule: { kind: 'minimum', minutes: 30 } })
    })
    expect(within(kpi('Stunden')).getByText('gerundet 127:00 h · mind. 30 Min')).toBeTruthy()
  })

  it('names no rule for mixed month profiles', async () => {
    await setup({ roundMinutes: 15, data: () => summary({ roundingRule: null }) })
    expect(within(kpi('Stunden')).getByText('gerundet 127:00 h')).toBeTruthy()
    expect(within(kpi('Stunden')).queryByText(/Takt/)).toBeNull()
  })

  it('has no rounded sub-line when hoursRounded is null', async () => {
    await setup({ data: () => summary({ hoursRounded: null }) })
    expect(within(kpi('Stunden')).queryByText(/gerundet/)).toBeNull()
  })

  it('deltas compare raw with raw and stay ink-coloured with a triangle', async () => {
    await setup()
    const hours = kpi('Stunden')
    expect(within(hours).getByText('+6,1 %')).toBeTruthy()
    expect(within(hours).getByText('vs. 118:45 h')).toBeTruthy()
    expect(within(hours).getByText('gestiegen')).toBeTruthy()

    const revenue = kpi('Umsatz')
    expect(within(revenue).getByText('13.078')).toBeTruthy()
    expect(within(revenue).getByText('+7,7 %')).toBeTruthy()
    expect(within(revenue).getByText('vs. 12.140 €')).toBeTruthy()

    const billable = kpi('Abrechenbar')
    expect(within(billable).getByText('89')).toBeTruthy()
    expect(within(billable).getByText('−2 pp')).toBeTruthy()
    expect(within(billable).getByText('vs. 91 %')).toBeTruthy()
    expect(within(billable).getByText('gesunken')).toBeTruthy()
    const triangle = billable.querySelector('svg')
    expect(triangle?.getAttribute('style')).toContain('rotate(180deg)')
  })

  it('no change reads "±0" without a triangle', async () => {
    await setup({
      data: () => summary({ billable: 1, billablePrev: 1, hoursPrev: 126 * H + 2 * 60 })
    })
    const billable = kpi('Abrechenbar')
    expect(within(billable).getByText('±0 pp')).toBeTruthy()
    expect(billable.querySelector('svg')).toBeNull()
    expect(within(billable).queryByText(/gestiegen|gesunken/)).toBeNull()
    // 30 s more than the comparison: shown as ±0,0 %, so no triangle either.
    const hours = kpi('Stunden')
    expect(within(hours).getByText('±0,0 %')).toBeTruthy()
    expect(hours.querySelector('svg')).toBeNull()
  })

  it('ABRECHENBAR shows no change when the comparison period is empty', async () => {
    await setup({ data: () => summary({ hoursPrev: 0, billablePrev: 0 }) })
    const billable = kpi('Abrechenbar')
    expect(within(billable).getByText('vs. 0 %')).toBeTruthy()
    expect(within(billable).queryByText(/pp/)).toBeNull()
    expect(billable.querySelector('svg')).toBeNull()
  })

  it('shows no percentage when the comparison period is empty', async () => {
    await setup({ data: () => summary({ hoursPrev: 0 }) })
    const hours = kpi('Stunden')
    expect(within(hours).queryByText(/%/)).toBeNull()
    expect(within(hours).getByText('vs. 0:00 h')).toBeTruthy()
  })

  it('keeps the no-rate state', async () => {
    await setup({ data: () => summary({ hasRateConfigured: false }) })
    const revenue = kpi('Umsatz')
    expect(within(revenue).getByText('—')).toBeTruthy()
    expect(within(revenue).getByText('Kein Satz konfiguriert')).toBeTruthy()
  })
})

describe('AuswertungView — targets', () => {
  const fixture = (): AnalyticsSummary =>
    summary({
      hours: 33.6 * H,
      revenue: 292320,
      billable: 0.5,
      daysElapsed: 16,
      daysInMonth: 31
    })
  const options = {
    now: new Date(2026, 7, 16, 10),
    data: fixture,
    settings: { language: 'en', target_hours_week: '16', target_rate_cent: '9500' }
  }

  it.each([
    ['en', 'Target', 'no target set'],
    ['de', 'Soll', 'kein Soll gesetzt']
  ])('without targets shows only the unset readout (%s)', async (language, title, unset) => {
    await setup({ settings: { language } })
    const target = kpi(title)
    expect(within(target).getByText('—')).toBeTruthy()
    expect(within(target).getByText(unset)).toBeTruthy()
    expect(target.textContent).not.toMatch(/%|≈|€/)
    expect(target.querySelector('svg')).toBeNull()
  })

  it.each([
    [
      'en',
      'Target',
      '33:36 h of 67:12 h target',
      '≈ 65:06 h at the current pace · 5.664 €',
      'effective rate 87 €/h · target 95 €/h'
    ],
    [
      'de',
      'Soll',
      '33:36 h von 67:12 h Soll',
      '≈ 65:06 h bei bisherigem Tempo · 5.664 €',
      'Effektiver Satz 87 €/h · Ziel 95 €/h'
    ]
  ])(
    'shows weekday-based utilisation, calendar projection and all-hours rate (%s)',
    async (language, title, hours, projection, rate) => {
      await setup({ ...options, settings: { ...options.settings, language } })
      const target = kpi(title)
      expect(within(target).getByText('50')).toBeTruthy()
      expect(within(target).getByText('%')).toBeTruthy()
      expect(within(target).getByText(hours)).toBeTruthy()
      expect(within(target).getByText(projection)).toBeTruthy()
      expect(within(target).getByText(rate)).toBeTruthy()
      expect(target.querySelector('svg')).toBeNull()
    }
  )

  it('a past month has its own weekday target and no projection', async () => {
    const { getSummary } = await setup(options)
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    await waitFor(() => expect(getSummary).toHaveBeenLastCalledWith({ year: 2026, month: 7 }))
    await waitFor(() =>
      expect(within(kpi('Target')).getByText('33:36 h of 73:36 h target')).toBeTruthy()
    )
    expect(kpi('Target').textContent).not.toMatch(/≈|current pace/)
    expect(within(kpi('Target')).getByText('effective rate 87 €/h · target 95 €/h')).toBeTruthy()
  })

  it('only a rate target shows the achieved rate without utilisation or projection', async () => {
    await setup({ ...options, settings: { language: 'en', target_rate_cent: '9500' } })
    const target = kpi('Target')
    expect(within(target).getByText('—')).toBeTruthy()
    expect(within(target).getByText('effective rate 87 €/h · target 95 €/h')).toBeTruthy()
    expect(target.textContent).not.toMatch(/%|≈|no target set/)
  })

  it('weekly target alone shows the effective rate when a billing rate exists', async () => {
    await setup({ ...options, settings: { language: 'en', target_hours_week: '16' } })
    expect(within(kpi('Target')).getByText('effective rate 87 €/h')).toBeTruthy()
    expect(kpi('Target').textContent).not.toContain('target 95')
  })

  it('weekly target without any rate shows hours and projection without money', async () => {
    await setup({
      ...options,
      data: () => ({
        ...fixture(),
        month: { ...fixture().month, hasRateConfigured: false, revenue: 0 }
      }),
      settings: { language: 'en', target_hours_week: '16' }
    })
    const target = kpi('Target')
    expect(within(target).getByText('50')).toBeTruthy()
    expect(within(target).getByText('≈ 65:06 h at the current pace')).toBeTruthy()
    expect(target.textContent).not.toMatch(/€|effective rate/)
  })

  it('zero hours show an unknown effective rate without dividing by zero', async () => {
    await setup({ ...options, data: () => summary({ hours: 0, revenue: 1 }) })
    expect(within(kpi('Target')).getByText('effective rate — €/h · target 95 €/h')).toBeTruthy()
    expect(kpi('Target').textContent).not.toMatch(/NaN|Infinity/)
  })
})

describe('AuswertungView — header (B2)', () => {
  it('"Stand" is the day the data was computed for, not the running clock', async () => {
    // The clock already says 23 October; the loaded data is for the 22nd.
    await setup({ now: new Date(2026, 9, 23, 0, 5), data: () => summary({ daysElapsed: 22 }) })
    await waitFor(() =>
      expect(screen.getByTestId('compare-note').textContent).toContain('Stand Do 22.10.')
    )
  })

  it('current month: same-period note and next month disabled', async () => {
    await setup()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Oktober 2026')
    expect(screen.getByTestId('compare-note').textContent).toBe(
      'Stand Do 22.10. · verglichen mit dem gleichen Zeitraum im Vormonat (1.–22. September)'
    )
    expect(screen.getByRole('button', { name: 'Nächster Monat' })).toHaveProperty('disabled', true)
  })

  it('past month: full-month note and the whole-month client period', async () => {
    const { getSummary } = await setup({
      data: (q) =>
        q.month === 10 ? summary() : summary({ comparison: 'fullMonth', prevPeriodDays: 31 })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Vorheriger Monat' }))
    await waitFor(() => expect(getSummary).toHaveBeenLastCalledWith({ year: 2026, month: 9 }))
    await waitFor(() =>
      expect(screen.getByTestId('compare-note').textContent).toBe('verglichen mit dem Vormonat')
    )
    expect(screen.getByText('ganzer Monat · Umsatz rechts')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Nächster Monat' })).toHaveProperty('disabled', false)
  })
})

describe('AuswertungView — Stunden nach Kunde', () => {
  it('a goodwill client shows "—", only a client without billable time "intern"', async () => {
    const base = summary()
    await setup({
      data: () => ({
        ...base,
        byClient: [
          ...base.byClient,
          // billable time on a goodwill project: no revenue, but not internal
          { client_id: 7, name: 'Kulanz GmbH', color: '#444', h: 2 * H, b: 2 * H, rev: 0 }
        ]
      })
    })
    const row = (name: string): HTMLElement =>
      screen.getByText(name).closest('[data-client-row]') as HTMLElement
    expect(within(row('Kulanz GmbH')).getByText('—')).toBeTruthy()
    expect(within(row('Kulanz GmbH')).queryByText('intern')).toBeNull()
    expect(within(row('wald-it intern')).getByText('intern')).toBeTruthy()
  })

  it('without any rate there is no revenue column and no revenue band', async () => {
    const base = summary()
    await setup({
      data: () => ({ ...base, month: { ...base.month, hasRateConfigured: false } })
    })
    expect(screen.getByText('laufender Monat')).toBeTruthy()
    expect(screen.queryByText('Umsatz rechts', { exact: false })).toBeNull()
    expect(screen.queryByText('6.798 €')).toBeNull()
    expect(screen.queryByText('intern')).toBeNull()
    expect(screen.queryByTestId('revenue-line')).toBeNull()
    expect(screen.queryAllByTestId('revenue-dot')).toHaveLength(0)
  })

  it('rows with raw hours, revenue in whole euros, "intern" without revenue', async () => {
    await setup()
    expect(screen.getByText('laufender Monat · Umsatz rechts')).toBeTruthy()
    expect(screen.getByText('59:07')).toBeTruthy()
    expect(screen.getByText('6.798 €')).toBeTruthy()
    expect(screen.getByText('intern')).toBeTruthy()
    // Ruler: max = next multiple of 10 h above 59:07 → labels 0…60.
    const ruler = screen.getByTestId('client-ruler')
    expect(within(ruler).getByText('60')).toBeTruthy()
    expect(within(ruler).queryByText('70')).toBeNull()
  })

  it('sums clients beyond the fourth into one "Sonstige" row', async () => {
    const base = summary()
    await setup({
      data: () => ({
        ...base,
        byClient: [
          ...base.byClient,
          { client_id: 4, name: 'Vier', color: '#111', h: 5 * H, b: 5 * H, rev: 50_000 },
          { client_id: 5, name: 'Fünf', color: '#222', h: 2 * H, b: 2 * H, rev: 20_000 },
          { client_id: 6, name: 'Sechs', color: '#333', h: 1 * H, b: 1 * H, rev: 10_000 }
        ]
      })
    })
    expect(screen.getByText('Sonstige')).toBeTruthy()
    expect(screen.queryByText('Fünf')).toBeNull()
    expect(screen.getByText('3:00')).toBeTruthy()
    expect(screen.getByText('300 €')).toBeTruthy()
  })
})

describe('AuswertungView — empty state', () => {
  it('keeps the existing strings and shows no KPIs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 22, 10, 0))
    const getSummary = vi.fn(async () => ({
      ok: true as const,
      data: summary({ hasData: false })
    }))
    ;(window as unknown as { api: unknown }).api = { analytics: { getSummary } }
    render(
      <I18nProvider>
        <RoundingProvider>
          <NowProvider running={false}>
            <AuswertungView />
          </NowProvider>
        </RoundingProvider>
      </I18nProvider>
    )
    await waitFor(() => expect(screen.getByText('Noch keine Einträge')).toBeTruthy())
    expect(screen.getByText('Starte einen Timer oder trage Stunden nach.')).toBeTruthy()
    expect(screen.queryByText('Stunden', { selector: 'div' })).toBeNull()
    expect(screen.queryByTestId('compare-note')).toBeNull()
  })
})
