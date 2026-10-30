import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import SettingsView from './SettingsView'
import { I18nProvider } from '../contexts/I18nContext'
import { useSettingsStore } from '../store/settingsStore'
import type { Settings } from '../../../shared/types'
import { DEFAULT_RULE_CHECK } from '../../../shared/ruleCheck'
import { de } from '../../../shared/locales/de'
import { en } from '../../../shared/locales/en'

afterEach(() => {
  cleanup()
  useSettingsStore.setState({ settings: null })
})

async function setup(
  locale: 'de' | 'en' = 'en',
  raw?: string,
  reject = false
): Promise<{ set: ReturnType<typeof vi.fn>; strings: typeof en }> {
  const settings = {
    language: locale,
    company_name: '',
    pdf_sender_address: '',
    pdf_tax_id: '',
    pdf_footer_text: '',
    pdf_accent_color: '#123456',
    rule_check: raw
  } as unknown as Settings
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
    },
    feedbackRules: { names: async () => ({ ok: true, data: [] }) }
  }
  render(
    <I18nProvider>
      <SettingsView />
    </I18nProvider>
  )
  const strings = locale === 'de' ? de : en
  fireEvent.click(await screen.findByRole('button', { name: strings['settings.nav.export'] }))
  return { set, strings }
}

describe('Settings rule check', () => {
  it.each(['de', 'en'] as const)(
    'shows defaults below feedback rules and saves all fields (%s)',
    async (locale) => {
      const { set, strings } = await setup(locale)
      const section = (
        await screen.findByRole('heading', { name: strings['settings.ruleCheck.title'] })
      ).closest('section')!
      expect(section.previousElementSibling).toContainElement(
        screen.getByRole('heading', { name: strings['settings.feedback.title'] })
      )
      expect(screen.getByText(strings['settings.ruleCheck.dayHint'])).toBeInTheDocument()
      expect(screen.getByLabelText(strings['settings.ruleCheck.entryMaxHours'])).toHaveValue(10)
      expect(screen.getByLabelText(strings['settings.ruleCheck.dayMaxHours'])).toHaveValue(10)
      expect(screen.getByLabelText(strings['settings.ruleCheck.windowStart'])).toHaveValue('06:00')
      expect(screen.getByLabelText(strings['settings.ruleCheck.windowEnd'])).toHaveValue('22:00')
      expect(screen.getByLabelText(strings['settings.ruleCheck.maxDescriptionLength'])).toHaveValue(
        300
      )
      for (const [key, value] of Object.entries({
        entryMaxHours: '8.5',
        dayMaxHours: '9',
        windowStart: '07:00',
        windowEnd: '21:00',
        maxDescriptionLength: '250'
      })) {
        fireEvent.change(
          screen.getByLabelText(strings[`settings.ruleCheck.${key}` as keyof typeof strings]),
          { target: { value } }
        )
      }
      fireEvent.click(screen.getByRole('switch', { name: strings['settings.ruleCheck.weekend'] }))
      await waitFor(() =>
        expect(set).toHaveBeenLastCalledWith(
          'rule_check',
          JSON.stringify({
            entryMaxHours: 8.5,
            dayMaxHours: 9,
            windowStart: '07:00',
            windowEnd: '21:00',
            weekend: false,
            maxDescriptionLength: 250
          })
        )
      )
    }
  )

  it('keeps invalid drafts unsaved and saves once every field is valid', async () => {
    const { set } = await setup()
    const hours = await screen.findByLabelText('Maximum hours per entry')
    for (const value of ['', '0', '-1']) {
      fireEvent.change(hours, { target: { value } })
      expect(set).not.toHaveBeenCalled()
      expect(screen.getByRole('alert')).toBeInTheDocument()
    }
    fireEvent.change(screen.getByLabelText('Maximum description length'), {
      target: { value: '1.5' }
    })
    fireEvent.change(hours, { target: { value: '8' } })
    expect(set).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Maximum description length'), {
      target: { value: '250' }
    })
    await waitFor(() =>
      expect(set).toHaveBeenLastCalledWith(
        'rule_check',
        JSON.stringify({ ...DEFAULT_RULE_CHECK, entryMaxHours: 8, maxDescriptionLength: 250 })
      )
    )
    set.mockClear()
    fireEvent.change(screen.getByLabelText('Working hours from'), { target: { value: '23:00' } })
    fireEvent.change(screen.getByLabelText('Working hours until'), { target: { value: '23:00' } })
    expect(set).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('loads saved values and restores them when saving fails', async () => {
    const { set } = await setup(
      'en',
      JSON.stringify({ ...DEFAULT_RULE_CHECK, entryMaxHours: 7 }),
      true
    )
    const hours = await screen.findByLabelText('Maximum hours per entry')
    expect(hours).toHaveValue(7)
    fireEvent.change(hours, { target: { value: '8' } })
    expect(await screen.findByText(/Write failed/)).toBeInTheDocument()
    await waitFor(() => expect(hours).toHaveValue(7))
    expect(set).toHaveBeenCalledWith(
      'rule_check',
      JSON.stringify({ ...DEFAULT_RULE_CHECK, entryMaxHours: 8 })
    )
  })
})
