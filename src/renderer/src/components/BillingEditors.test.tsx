import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { BillingEditors } from './BillingEditors'
import { I18nProvider } from '../contexts/I18nContext'
import { useSettingsStore } from '../store/settingsStore'
import type { ProfileEditorData, RateTarget } from '../../../shared/rateEditor'
import type { Settings } from '../../../shared/types'

afterEach(() => {
  cleanup()
  useSettingsStore.setState({ settings: null })
})

describe('billing profile choices', () => {
  it.each([
    ['de', 'client'],
    ['de', 'project'],
    ['en', 'client'],
    ['en', 'project']
  ] as const)(
    'shows inherited values and sources and saves all choices (%s, %s)',
    async (locale, kind) => {
      useSettingsStore.setState({ settings: { language: locale } as Settings })
      const source = kind === 'project' ? 'client' : 'default'
      const profile: ProfileEditorData = {
        interval_min: 15,
        min_unit_min: null,
        columns: null,
        language: null,
        fee_column: null,
        group_by: null,
        inherited: {
          interval_min: 5,
          min_unit_min: 0,
          columns: 'times',
          language: 'de',
          fee_column: 'auto',
          group_by: 'none'
        },
        inherited_source: {
          interval_min: source,
          min_unit_min: source,
          columns: source,
          language: source,
          fee_column: source,
          group_by: source
        }
      }
      const save = vi.fn().mockResolvedValue({ ok: true, data: profile })
      ;(window as unknown as { api: unknown }).api = {
        rates: {
          list: vi.fn().mockResolvedValue({ ok: true, data: { rows: [], current_rate_cent: null } })
        },
        billingProfile: { get: vi.fn().mockResolvedValue({ ok: true, data: profile }), save }
      }
      const target: RateTarget = { kind, id: kind === 'client' ? 1 : 10 }
      await act(async () => {
        render(
          <I18nProvider>
            <BillingEditors
              target={target}
              onRateLoaded={vi.fn()}
              onRateSaved={vi.fn()}
              onChanged={vi.fn()}
            />
          </I18nProvider>
        )
      })
      const german = locale === 'de'
      const labels = german
        ? ['Spalten', 'Sprache', 'Betragsspalte', 'Gruppierung']
        : ['Columns', 'Language', 'Fee column', 'Grouping']
      const inherited = german
        ? ['Mit Uhrzeiten', 'Deutsch', 'Automatisch', 'Keine']
        : ['With times', 'German', 'Automatic', 'None']
      const sourceLabel =
        source === 'client' ? (german ? 'Kunde' : 'client') : german ? 'Standard' : 'default'
      const options = [
        ['', 'times', 'no_times'],
        ['', 'de', 'en'],
        ['', 'auto', 'on', 'off'],
        ['', 'none', 'tag', 'project', 'reference']
      ]
      const values = ['no_times', 'en', 'off', 'reference']
      labels.forEach((label, index) => {
        const select = screen.getByRole('combobox', { name: label })
        const allOptions = within(select).getAllByRole('option') as HTMLOptionElement[]
        expect(allOptions.map((option) => option.value)).toEqual(options[index])
        expect(allOptions[0]).toHaveTextContent(
          `${german ? 'Geerbt' : 'Inherited'}: ${inherited[index]} (${sourceLabel})`
        )
        expect(select).toHaveValue('')
        fireEvent.change(select, { target: { value: values[index] } })
      })
      const button = screen.getByRole('button', {
        name: german ? 'Abrechnung speichern' : 'Save billing'
      })
      await act(async () => {
        fireEvent.click(button)
      })
      expect(save).toHaveBeenLastCalledWith(target, {
        interval_min: 15,
        min_unit_min: null,
        columns: 'no_times',
        language: 'en',
        fee_column: 'off',
        group_by: 'reference'
      })
      labels.forEach((label) =>
        fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value: '' } })
      )
      await act(async () => {
        fireEvent.click(button)
      })
      expect(save).toHaveBeenLastCalledWith(target, {
        interval_min: 15,
        min_unit_min: null,
        columns: null,
        language: null,
        fee_column: null,
        group_by: null
      })
      save.mockResolvedValue({
        ok: false,
        error:
          'Error: Bitte eine gültige Auswahl für das Abrechnungsprofil treffen oder den Wert erben.'
      })
      await act(async () => {
        fireEvent.click(button)
      })
      expect(screen.getByRole('alert')).toHaveTextContent(
        german
          ? 'Bitte eine gültige Auswahl treffen oder den Wert erben.'
          : 'Please select an available option or inherit the value.'
      )
    }
  )
})
