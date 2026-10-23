/**
 * The UI language follows the stored `language` setting in both directions,
 * with the shared rule from shared/i18n (#296).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
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
  const originalApi = (window as unknown as { api?: unknown }).api
  beforeEach(() => {
    useSettingsStore.setState({ settings: null })
  })
  afterEach(() => {
    cleanup()
    ;(window as unknown as { api?: unknown }).api = originalApi
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

  // Onboarding on first run: the user picks English before load() resolves,
  // and load() then brings the snapshot from before the pick ('de').
  it('a late load does not undo the language the user just picked', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: { set: async () => ({ ok: true, data: undefined }) }
    }
    function Picker(): React.JSX.Element {
      const { locale, setLocale } = useLocale()
      return (
        <>
          <span data-testid="locale">{locale}</span>
          <button onClick={() => void setLocale('en')}>en</button>
        </>
      )
    }
    const { getByTestId, getByText } = render(
      <I18nProvider>
        <Picker />
      </I18nProvider>
    )
    await act(async () => {
      getByText('en').click()
    })
    expect(getByTestId('locale').textContent).toBe('en')
    setLanguage('de')
    expect(getByTestId('locale').textContent).toBe('en')
  })

  it('a pick also updates the store copy for other readers', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: { set: async () => ({ ok: true, data: undefined }) }
    }
    setLanguage('de')
    function Picker(): React.JSX.Element {
      const { setLocale } = useLocale()
      return <button onClick={() => void setLocale('en')}>en</button>
    }
    const { getByText } = render(
      <I18nProvider>
        <Picker />
      </I18nProvider>
    )
    await act(async () => {
      getByText('en').click()
    })
    expect(useSettingsStore.getState().settings?.language).toBe('en')
  })
})
