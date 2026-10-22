/**
 * Verlauf (HANDOFF §3.15, B3): two bands, one cursor. Pins what the screen
 * promises: the cursor starts on the latest period, follows hover, focus and
 * the arrow keys, the running period says so, and the mode switch is a real
 * segmented control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { TrendBands } from './TrendBands'
import { I18nProvider } from '../../contexts/I18nContext'
import { NowProvider } from '../../contexts/NowContext'
import type { AnalyticsSummary } from '../../../../shared/types'

afterEach(cleanup)

const H = 3600
const MONTH_LBL = [
  'Nov',
  'Dez',
  'Jan',
  'Feb',
  'Mär',
  'Apr',
  'Mai',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Okt'
]

const months: AnalyticsSummary['months'] = MONTH_LBL.map((lbl, i) => ({
  lbl,
  b: (100 + i) * H,
  n: 10 * H,
  h: (110 + i) * H,
  r: (10_000 + i * 100) * 100
}))
// The mockup's October: 126:02 h, 112:32 billable, 13.078 €.
months[11] = {
  lbl: 'Okt',
  b: 112 * H + 32 * 60,
  n: 13 * H + 30 * 60,
  h: 126 * H + 2 * 60,
  r: 1_307_800
}

const weeks: AnalyticsSummary['weeks'] = Array.from({ length: 12 }, (_, i) => ({
  lbl: `KW${33 + i}`,
  b: 30 * H,
  n: 5 * H,
  r: 300_000
}))

function Harness({ initial = 'month' }: { initial?: 'week' | 'month' }): React.JSX.Element {
  const [mode, setMode] = useState<'week' | 'month'>(initial)
  return (
    <TrendBands
      weeks={weeks}
      months={months}
      mode={mode}
      onModeChange={setMode}
      anchor={{ year: 2026, month: 10 }}
    />
  )
}

function renderBands(initial?: 'week' | 'month'): void {
  render(
    <I18nProvider>
      <NowProvider running={false}>
        <Harness initial={initial} />
      </NowProvider>
    </I18nProvider>
  )
}

const cursor = (): HTMLElement => screen.getByTestId('trend-cursor')
const columns = (): HTMLElement[] =>
  screen.getAllByRole('button').filter((b) => b.hasAttribute('aria-current') || b.tabIndex === -1)

describe('TrendBands', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 22, 10, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts the cursor on the latest period and marks the running month', () => {
    renderBands()
    expect(cursor().getAttribute('aria-live')).toBe('polite')
    expect(within(cursor()).getByText('Oktober 2026 · laufend')).toBeTruthy()
    expect(within(cursor()).getByText('126:02')).toBeTruthy()
    expect(within(cursor()).getByText('112:32')).toBeTruthy()
    expect(within(cursor()).getByText('89 %')).toBeTruthy()
    expect(within(cursor()).getByText('13.078 €')).toBeTruthy()

    const cols = columns()
    expect(cols).toHaveLength(12)
    expect(cols[11].getAttribute('aria-current')).toBe('true')
    expect(cols[11].getAttribute('tabindex')).toBe('0')
    expect(cols[11].getAttribute('aria-label')).toBe(
      'Oktober 2026 · laufend: 126:02 h, davon 112:32 h abrechenbar, Umsatz 13.078 €'
    )
    expect(screen.getAllByTestId('cursor-line')).toHaveLength(1)
  })

  it('follows hover and focus, and the arrow keys move a roving tabindex', () => {
    renderBands()
    const cols = columns()
    fireEvent.mouseEnter(cols[0])
    expect(within(cursor()).getByText('November 2025')).toBeTruthy()
    expect(cols[0].getAttribute('tabindex')).toBe('0')
    expect(cols[11].getAttribute('tabindex')).toBe('-1')

    act(() => cols[3].focus())
    expect(within(cursor()).getByText('Februar 2026')).toBeTruthy()

    fireEvent.keyDown(cols[3], { key: 'ArrowRight' })
    expect(document.activeElement).toBe(cols[4])
    expect(within(cursor()).getByText('März 2026')).toBeTruthy()

    fireEvent.keyDown(cols[4], { key: 'End' })
    expect(document.activeElement).toBe(cols[11])
  })

  it('shows the year under the first column and under January', () => {
    renderBands()
    const cols = columns()
    expect(within(cols[0]).getByText('2025')).toBeTruthy()
    expect(within(cols[2]).getByText('2026')).toBeTruthy()
    expect(within(cols[1]).queryByText(/20\d\d/)).toBeNull()
  })

  it('switches to weeks: segmented control, KW labels, running week, cursor reset', () => {
    renderBands()
    fireEvent.mouseEnter(columns()[0])
    const weeksKey = screen.getByRole('button', { name: 'Wochen' })
    expect(weeksKey.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Monate' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('group', { name: 'Verlauf' })).toBeTruthy()

    fireEvent.click(weeksKey)
    expect(weeksKey.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('12 Wochen · Zeiger über eine Spalte bewegen')).toBeTruthy()
    // In the running month the cursor starts on the running week, not on the
    // last column — in week mode that one can lie ahead of today and be empty.
    expect(within(cursor()).getByText('KW43 2026 · laufend')).toBeTruthy()
    expect(columns()[10].getAttribute('aria-label')).toMatch(/^KW43 2026 · laufend: 35:00 h/)
  })

  it('draws both bands: stacked hours and one revenue dot per column', () => {
    renderBands()
    expect(screen.getAllByTestId('bar-billable')).toHaveLength(12)
    expect(screen.getAllByTestId('bar-nonbillable')).toHaveLength(12)
    expect(screen.getAllByTestId('revenue-dot')).toHaveLength(12)
    expect(screen.getByTestId('revenue-line').getAttribute('points')?.split(' ')).toHaveLength(12)
  })

  it('does not mark a past month as running', () => {
    vi.setSystemTime(new Date(2026, 11, 3, 10, 0))
    renderBands()
    expect(within(cursor()).getByText('Oktober 2026')).toBeTruthy()
    expect(within(cursor()).queryByText(/laufend/)).toBeNull()
  })
})
