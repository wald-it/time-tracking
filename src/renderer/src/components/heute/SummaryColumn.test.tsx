import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SummaryColumn } from './SummaryColumn'
import { I18nProvider } from '../../contexts/I18nContext'
import { uniformRoundingRule } from '../../../../shared/entryMoney'
import { useSettingsStore } from '../../store/settingsStore'
import type { Settings } from '../../../../shared/types'

afterEach(() => {
  cleanup()
  useSettingsStore.setState({ settings: null })
})

describe('SummaryColumn rounding label', () => {
  it.each([
    ['en', '16', '12:30 of 16 h target'],
    ['de', '16', '12:30 von 16 h Soll'],
    ['en', '16.5', '12:30 of 16.5 h target'],
    ['de', '16.5', '12:30 von 16,5 h Soll'],
    ['en', undefined, null],
    ['en', '', null],
    ['en', 'abc', null],
    ['en', '0', null]
  ])('weekly target sub-line (%s, %s)', (language, weekly, expected) => {
    useSettingsStore.setState({
      settings: { language, target_hours_week: weekly, target_rate_cent: '9500' } as Settings
    })
    render(
      <I18nProvider>
        <SummaryColumn
          todaySeconds={1800}
          weekSeconds={12.5 * 3600}
          weekDaySeconds={[1800, 0, 0, 0, 0, 0, 0]}
          weekNumber={43}
          todayIndex={0}
          roundingRule={null}
        />
      </I18nProvider>
    )
    if (expected) expect(screen.getByText(expected)).toBeTruthy()
    else expect(screen.queryByText(/target|Soll/)).toBeNull()
  })
  it.each([
    ['de', 'gerundet 1:30 h · mind. 30 Min'],
    ['en', 'rounded 1:30 h · min. 30 min']
  ])('names a pure minimum in %s', (language, label) => {
    useSettingsStore.setState({ settings: { language } as Settings })
    render(
      <I18nProvider>
        <SummaryColumn
          todaySeconds={1800}
          todayRoundedSeconds={5400}
          weekSeconds={1800}
          weekDaySeconds={[1800, 0, 0, 0, 0, 0, 0]}
          weekNumber={43}
          todayIndex={0}
          roundingRule={uniformRoundingRule([{ interval_min: 0, min_unit_min: 30 }])}
        />
      </I18nProvider>
    )
    expect(screen.getByText(label)).toBeTruthy()
  })
})
