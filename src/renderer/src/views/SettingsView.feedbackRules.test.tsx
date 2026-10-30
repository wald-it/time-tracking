import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  locale: 'de' | 'en',
  raw?: string,
  reject = false
): Promise<ReturnType<typeof vi.fn>> {
  const settings = {
    language: locale,
    company_name: '',
    pdf_sender_address: '',
    pdf_tax_id: '',
    pdf_footer_text: '',
    pdf_accent_color: '#123456',
    feedback_rules: raw
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
    feedbackRules: { names: async () => ({ ok: true, data: ['Anna Müller', 'Bärbel'] }) }
  }
  render(
    <I18nProvider>
      <SettingsView />
    </I18nProvider>
  )
  fireEvent.click(
    await screen.findByRole('button', { name: (locale === 'de' ? de : en)['settings.nav.export'] })
  )
  return set
}

describe('Settings → Export → feedback texts', () => {
  it.each(['de', 'en'] as const)(
    'saves all three rules and lists read-only master names (%s)',
    async (locale) => {
      const set = await setup(locale)
      const labels =
        locale === 'de'
          ? ['Rückmeldetexte', 'Erlaubte Präfixe', 'Trennzeichen', 'Verbotene Wörter']
          : ['Feedback texts', 'Allowed prefixes', 'Separator', 'Forbidden words']
      const section = (await screen.findByRole('heading', { name: labels[0] })).closest('section')!
      expect(within(section).getByLabelText(labels[2])).toHaveValue(';')
      expect(await within(section).findByText('Anna Müller')).toBeInTheDocument()
      expect(within(section).getByText('Bärbel')).toBeInTheDocument()
      expect(within(section).getAllByRole('textbox')).toHaveLength(3)
      fireEvent.change(within(section).getByLabelText(labels[1]), {
        target: { value: 'IT, Ops, it' }
      })
      fireEvent.change(within(section).getByLabelText(labels[2]), { target: { value: '|' } })
      fireEvent.change(within(section).getByLabelText(labels[3]), {
        target: { value: 'secret, Bär' }
      })
      await waitFor(() =>
        expect(set).toHaveBeenLastCalledWith(
          'feedback_rules',
          JSON.stringify({ prefixes: ['IT', 'Ops'], separator: '|', forbidden: ['secret', 'Bär'] })
        )
      )
    }
  )

  it('loads saved values and preserves comma and whitespace while typing', async () => {
    const set = await setup(
      'en',
      JSON.stringify({ prefixes: ['Ops'], separator: '', forbidden: ['secret'] })
    )
    const prefixes = await screen.findByLabelText('Allowed prefixes')
    expect(prefixes).toHaveValue('Ops')
    expect(screen.getByLabelText('Separator')).toHaveValue('')
    expect(screen.getByLabelText('Forbidden words')).toHaveValue('secret')
    fireEvent.change(prefixes, { target: { value: 'Ops, ' } })
    expect(prefixes).toHaveValue('Ops, ')
    fireEvent.change(prefixes, { target: { value: 'Ops, IT' } })
    await waitFor(() =>
      expect(set).toHaveBeenLastCalledWith(
        'feedback_rules',
        JSON.stringify({ prefixes: ['Ops', 'IT'], separator: '', forbidden: ['secret'] })
      )
    )
  })

  it('shows a failed save and restores the stored values', async () => {
    await setup('en', JSON.stringify({ prefixes: ['Ops'], separator: ';', forbidden: [] }), true)
    fireEvent.change(await screen.findByLabelText('Allowed prefixes'), { target: { value: 'IT' } })
    expect(await screen.findByText(/Write failed/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('Allowed prefixes')).toHaveValue('Ops'))
  })
})
