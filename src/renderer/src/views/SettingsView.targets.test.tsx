import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import SettingsView from './SettingsView'
import { I18nProvider } from '../contexts/I18nContext'
import { useSettingsStore } from '../store/settingsStore'
import type { Settings } from '../../../shared/types'
import { de } from '../../../shared/locales/de'
import { en } from '../../../shared/locales/en'

afterEach(() => {
  cleanup()
  useSettingsStore.setState({ settings: null })
})

async function setup(
  language: 'de' | 'en' = 'en',
  targets: Partial<Settings> = {},
  reject = false
): Promise<{
  set: ReturnType<typeof vi.fn>
  strings: typeof en
  hours: HTMLElement
  rate: HTMLElement
}> {
  const settings = { language, company_name: '', ...targets } as Settings
  const set = vi.fn(async () =>
    reject ? { ok: false, error: 'Write failed' } : { ok: true, data: undefined }
  )
  useSettingsStore.setState({ settings })
  ;(window as unknown as { api: unknown }).api = {
    settings: { getAll: async () => ({ ok: true, data: settings }), set },
    paths: {
      get: async () => ({
        ok: true,
        data: {
          db: '',
          backups: '',
          logs: '',
          logFile: '',
          mcp: { command: '', args: [], env: {}, available: false }
        }
      })
    },
    app: { getVersion: async () => ({ ok: true, data: '2.2.0' }) },
    backups: {
      list: async () => ({ ok: true, data: [] }),
      getPathInfo: async () => ({ ok: true, data: { dir: '', isCustom: false, isReachable: true } })
    }
  }
  render(
    <I18nProvider>
      <SettingsView />
    </I18nProvider>
  )
  const strings = language === 'de' ? de : en
  const hours = await screen.findByLabelText(strings['settings.targets.weeklyHours'])
  const rate = screen.getByLabelText(strings['settings.targets.rate'])
  return { set, strings, hours, rate }
}

describe('Settings targets', () => {
  it.each(['de', 'en'] as const)(
    'shows optional inputs with hints and saves canonical strings (%s)',
    async (language) => {
      const { set, strings, hours, rate } = await setup(language)
      expect(
        screen.getByRole('heading', { name: strings['settings.targets.title'] })
      ).toBeInTheDocument()
      expect(screen.getByText(strings['settings.targets.weeklyHint'])).toBeInTheDocument()
      expect(screen.getByText(strings['settings.targets.rateHint'])).toBeInTheDocument()
      expect(hours).toHaveValue('')
      expect(rate).toHaveValue('')
      fireEvent.change(hours, { target: { value: '16,5' } })
      await waitFor(() => expect(set).toHaveBeenLastCalledWith('target_hours_week', '16.5'))
      expect(hours).toHaveValue('16,5')
      fireEvent.change(rate, { target: { value: '95,50' } })
      await waitFor(() => expect(set).toHaveBeenLastCalledWith('target_rate_cent', '9550'))
      expect(rate).toHaveValue('95,50')
      expect(useSettingsStore.getState().settings).toMatchObject({
        target_hours_week: '16.5',
        target_rate_cent: '9550'
      })
      fireEvent.change(rate, { target: { value: '1.005' } })
      await waitFor(() => expect(set).toHaveBeenLastCalledWith('target_rate_cent', '101'))
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    }
  )

  it('shows stored values with a decimal comma in German', async () => {
    const { hours, rate } = await setup('de', {
      target_hours_week: '16.5',
      target_rate_cent: '9550'
    })
    expect(hours).toHaveValue('16,5')
    expect(rate).toHaveValue('95,50')
  })

  it('loads decimal hours and cent settings, and empties each independently', async () => {
    const { set, hours, rate } = await setup('en', {
      target_hours_week: '16.5',
      target_rate_cent: '9550'
    })
    expect(hours).toHaveValue('16.5')
    expect(rate).toHaveValue('95.50')
    fireEvent.change(hours, { target: { value: '' } })
    await waitFor(() => expect(set).toHaveBeenLastCalledWith('target_hours_week', ''))
    expect(useSettingsStore.getState().settings?.target_rate_cent).toBe('9550')
    fireEvent.change(rate, { target: { value: '' } })
    await waitFor(() => expect(set).toHaveBeenLastCalledWith('target_rate_cent', ''))
    expect(useSettingsStore.getState().settings).toMatchObject({
      target_hours_week: '',
      target_rate_cent: ''
    })
  })

  it('keeps invalid input visible and unsaved, then recovers on valid input', async () => {
    const { set, hours, rate } = await setup()
    for (const value of ['abc', '0', '-1', '168.01', 'Infinity', '1,2.3']) {
      fireEvent.change(hours, { target: { value } })
      expect(hours).toHaveValue(value)
      expect(hours).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(set).not.toHaveBeenCalled()
    }
    fireEvent.change(hours, { target: { value: '16.5' } })
    await waitFor(() => expect(set).toHaveBeenLastCalledWith('target_hours_week', '16.5'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    set.mockClear()
    for (const value of ['abc', '0', '-1', '0.004', '1,2.3']) {
      fireEvent.change(rate, { target: { value } })
      expect(rate).toHaveValue(value)
      expect(rate).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(set).not.toHaveBeenCalled()
    }
    fireEvent.change(rate, { target: { value: '95.50' } })
    await waitFor(() => expect(set).toHaveBeenLastCalledWith('target_rate_cent', '9550'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    ['target_hours_week', 'hours', '20', '16.5'],
    ['target_rate_cent', 'rate', '100', '95.50']
  ] as const)('restores %s after a rejected save', async (key, field, value, restored) => {
    const controls = await setup(
      'en',
      { target_hours_week: '16.5', target_rate_cent: '9550' },
      true
    )
    fireEvent.change(controls[field], { target: { value } })
    expect(await screen.findByText(/Write failed/)).toBeInTheDocument()
    await waitFor(() => expect(controls[field]).toHaveValue(restored))
    expect(useSettingsStore.getState().settings?.[key]).toBe(
      key === 'target_hours_week' ? '16.5' : '9550'
    )
  })
})
