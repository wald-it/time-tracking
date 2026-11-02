import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import SettingsView from './SettingsView'
import { I18nProvider } from '../contexts/I18nContext'
import { useSettingsStore } from '../store/settingsStore'
import type { Settings } from '../../../shared/types'
import { DEFAULT_WORKING_HOURS } from '../../../shared/workingHours'
import { DEFAULT_RULE_CHECK } from '../../../shared/ruleCheck'
import { de } from '../../../shared/locales/de'
import { en } from '../../../shared/locales/en'

afterEach(() => {
  cleanup()
  useSettingsStore.setState({ settings: null })
})

async function setup(
  locale: 'de' | 'en' = 'en',
  overrides: Partial<Settings> = {},
  reject = false
): Promise<{ set: ReturnType<typeof vi.fn>; strings: typeof en }> {
  const settings = {
    language: locale,
    company_name: '',
    pdf_sender_address: '',
    pdf_tax_id: '',
    pdf_footer_text: '',
    pdf_accent_color: '#123456',
    ...overrides
  } as Settings
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
    app: { getVersion: async () => ({ ok: true, data: '2.4.0' }) },
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
  await screen.findByRole('heading', { name: strings['settings.workingHours.title'] })
  return { set, strings }
}

describe('Settings working hours', () => {
  it.each(['de', 'en'] as const)(
    'shows defaults next to targets and saves a valid window (%s)',
    async (locale) => {
      const { set, strings } = await setup(locale)
      const section = screen
        .getByRole('heading', { name: strings['settings.workingHours.title'] })
        .closest('section')!
      expect(section.previousElementSibling).toContainElement(
        screen.getByRole('heading', { name: strings['settings.targets.title'] })
      )
      expect(screen.getByText(strings['settings.workingHours.hint'])).toBeInTheDocument()
      const start = screen.getByLabelText(strings['settings.workingHours.start'])
      const end = screen.getByLabelText(strings['settings.workingHours.end'])
      expect(start).toHaveValue('08:00')
      expect(end).toHaveValue('18:00')
      expect(start).toHaveAttribute('type', 'time')
      expect(end).toHaveAttribute('type', 'time')
      expect(set).not.toHaveBeenCalled()
      fireEvent.change(start, { target: { value: '09:00' } })
      fireEvent.change(end, { target: { value: '17:00' } })
      await waitFor(() =>
        expect(set).toHaveBeenLastCalledWith(
          'working_hours',
          JSON.stringify({ start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] })
        )
      )
      expect(set.mock.calls.every(([key]) => key === 'working_hours')).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: strings['settings.nav.export'] }))
      expect(await screen.findByLabelText(strings['settings.ruleCheck.windowStart'])).toHaveValue(
        DEFAULT_RULE_CHECK.windowStart
      )
      expect(screen.getByLabelText(strings['settings.ruleCheck.windowEnd'])).toHaveValue(
        DEFAULT_RULE_CHECK.windowEnd
      )
    }
  )

  it.each(['18:00', '19:00', ''])(
    'keeps invalid start %s unsaved and saves after correction',
    async (value) => {
      const { set } = await setup()
      const start = screen.getByLabelText('From')
      fireEvent.change(start, { target: { value } })
      expect(start).toHaveValue(value)
      expect(start).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(set).not.toHaveBeenCalled()
      fireEvent.change(start, { target: { value: '09:00' } })
      await waitFor(() =>
        expect(set).toHaveBeenLastCalledWith(
          'working_hours',
          JSON.stringify({ ...DEFAULT_WORKING_HOURS, start: '09:00' })
        )
      )
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    }
  )

  it.each([
    ['monday', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']],
    ['sunday', ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']]
  ] as const)(
    'orders weekday buttons by %s and persists sorted days',
    async (weekStart, labels) => {
      const { set } = await setup('en', { week_start: weekStart })
      const group = screen.getByRole('group', { name: 'Workdays' })
      const buttons = within(group).getAllByRole('button')
      expect(buttons.map((button) => button.textContent)).toEqual(labels)
      expect(within(group).getAllByRole('button', { pressed: true })).toHaveLength(5)
      const sunday = within(group).getByRole('button', { name: 'Sun', pressed: false })
      sunday.focus()
      expect(sunday).toHaveFocus()
      expect(sunday).toHaveAttribute('type', 'button')
      fireEvent.click(sunday)
      await waitFor(() =>
        expect(set).toHaveBeenLastCalledWith(
          'working_hours',
          JSON.stringify({ ...DEFAULT_WORKING_HOURS, days: [0, 1, 2, 3, 4, 5] })
        )
      )
      expect(sunday).toHaveAttribute('aria-pressed', 'true')
      fireEvent.click(within(group).getByRole('button', { name: 'Mon' }))
      await waitFor(() =>
        expect(set).toHaveBeenLastCalledWith(
          'working_hours',
          JSON.stringify({ ...DEFAULT_WORKING_HOURS, days: [0, 2, 3, 4, 5] })
        )
      )
    }
  )

  it('refuses an empty workweek and saves when a day is chosen again', async () => {
    const { set } = await setup('en', {
      working_hours: JSON.stringify({ ...DEFAULT_WORKING_HOURS, days: [1] })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Mon' }))
    expect(set).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Tue' }))
    await waitFor(() =>
      expect(set).toHaveBeenLastCalledWith(
        'working_hours',
        JSON.stringify({ ...DEFAULT_WORKING_HOURS, days: [2] })
      )
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('loads stored values and restores them after a failed write', async () => {
    const hours = { start: '10:00', end: '16:00', days: [0, 6] }
    const { set } = await setup('en', { working_hours: JSON.stringify(hours) }, true)
    const start = screen.getByLabelText('From')
    expect(start).toHaveValue('10:00')
    expect(screen.getByLabelText('To')).toHaveValue('16:00')
    expect(screen.getByRole('button', { name: 'Sun' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.change(start, { target: { value: '09:00' } })
    expect(await screen.findByText(/Write failed/)).toBeInTheDocument()
    await waitFor(() => expect(start).toHaveValue('10:00'))
    expect(set).toHaveBeenCalledWith('working_hours', JSON.stringify({ ...hours, start: '09:00' }))
  })
})
