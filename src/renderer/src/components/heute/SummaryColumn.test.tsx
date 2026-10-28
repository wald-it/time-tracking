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
