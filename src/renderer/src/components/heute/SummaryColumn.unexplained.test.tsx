import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { SummaryColumn } from './SummaryColumn'
import { I18nProvider } from '../../contexts/I18nContext'
import { NowProvider } from '../../contexts/NowContext'
import { useSettingsStore } from '../../store/settingsStore'
import type { Settings } from '../../../../shared/types'
import type { GapEntry } from '../../../../shared/gaps'

// Like CalendarView tests, use local timestamps and pin Date; no runtime TZ mutation.
const local = (day: number, hour: number, minute = 0): string =>
  new Date(2026, 7, day, hour, minute).toISOString()
const entry = (day: number, start: number, end: number | null): GapEntry => ({
  started_at: local(day, start),
  stopped_at: end === null ? null : local(day, end)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useSettingsStore.setState({ settings: null })
})

function content(entries: GapEntry[], running = false): React.JSX.Element {
  return (
    <I18nProvider>
      <NowProvider running={running}>
        <SummaryColumn
          todayEntries={entries}
          todaySeconds={3600}
          todayRoundedSeconds={4500}
          roundingRule={{ kind: 'interval', minutes: 15 }}
          weekSeconds={3600}
          weekDaySeconds={[3600, 0, 0, 0, 0, 0, 0]}
          weekNumber={33}
          todayIndex={0}
        />
      </NowProvider>
    </I18nProvider>
  )
}

function pin(day = 10): void {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(local(day, 12)))
}

describe('SummaryColumn unexplained time', () => {
  it.each([
    ['de', 'ungeklärt 3:00', 'gerundet 1:15 h · 15-min-Takt'],
    ['en', 'unexplained 3:00', 'rounded 1:15 h · 15-min step']
  ])('adds a separate ink3 line alongside unchanged rounding in %s', (language, label, rounded) => {
    pin()
    useSettingsStore.setState({ settings: { language } as Settings })
    render(content([entry(10, 9, 10)]))
    const line = screen.getByText(label)
    expect(line.className).toContain('text-[var(--ink3)]')
    expect(screen.getByText(rounded)).toBeTruthy()
    expect(line.previousElementSibling?.textContent).toBe(rounded)
  })

  it.each([
    ['fully covered', 10, [entry(10, 8, 12)]],
    ['weekend', 15, [entry(15, 9, 10)]],
    ['no entries', 10, []],
    ['only a running carryover', 10, [entry(9, 23, null)]]
  ])('omits the line for %s', (_label, day, entries) => {
    pin(day)
    render(content(entries))
    expect(screen.queryByText(/ungeklärt|unexplained/)).toBeNull()
    expect(screen.getByText('gerundet 1:15 h · 15-min-Takt')).toBeTruthy()
  })

  it('reads the configured working window', () => {
    pin()
    useSettingsStore.setState({
      settings: {
        working_hours: JSON.stringify({ start: '10:00', end: '16:00', days: [1] })
      } as Settings
    })
    render(content([entry(10, 10, 11)]))
    expect(screen.getByText('ungeklärt 1:00')).toBeTruthy()
  })

  it('uses an available carryover as coverage only when today has its own entry', () => {
    pin()
    render(content([{ started_at: local(9, 23), stopped_at: local(10, 9) }, entry(10, 10, 11)]))
    expect(screen.getByText('ungeklärt 2:00')).toBeTruthy()
  })

  it('counts a still-running carryover as coverage when today has an entry', () => {
    pin()
    render(content([entry(9, 23, null), entry(10, 10, 11)], true))
    expect(screen.queryByText(/ungeklärt|unexplained/)).toBeNull()
  })

  it('grows on the shared idle clock, holds while running, and grows again after stopping', () => {
    pin()
    const stopped = entry(10, 9, 10)
    const view = render(content([stopped]))
    expect(screen.getByText('ungeklärt 3:00')).toBeTruthy()
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByText('ungeklärt 3:01')).toBeTruthy()

    const running = { started_at: local(10, 12, 1), stopped_at: null }
    view.rerender(content([stopped, running], true))
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByText('ungeklärt 3:01')).toBeTruthy()

    view.rerender(content([stopped, { ...running, stopped_at: local(10, 12, 2) }]))
    act(() => vi.advanceTimersByTime(5 * 60_000))
    expect(screen.getByText('ungeklärt 3:06')).toBeTruthy()
  })
})
