/**
 * The UI language follows the stored `language` setting in both directions
 * (#296: the provider used to switch only to English, never back).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import { I18nProvider, useLocale } from './I18nContext'
import { useSettingsStore } from '../store/settingsStore'
import type { Settings } from '../../../shared/types'

function Probe(): React.JSX.Element {
  const { locale } = useLocale()
  return <span data-testid="locale">{locale}</span>
}

function setLanguage(language: string | undefined): void {
  act(() => {
    useSettingsStore.setState({
      settings: language === undefined ? null : ({ language } as unknown as Settings)
    })
  })
}

describe('I18nProvider', () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: null })
  })

  it('German until the settings load, then the stored language, back and forth', () => {
    const { getByTestId } = render(
      <I18nProvider>
        <Probe />
      </I18nProvider>
    )
    expect(getByTestId('locale').textContent).toBe('de')
    setLanguage('en')
    expect(getByTestId('locale').textContent).toBe('en')
    setLanguage('de')
    expect(getByTestId('locale').textContent).toBe('de')
    setLanguage('fr')
    expect(getByTestId('locale').textContent).toBe('de')
  })
})
