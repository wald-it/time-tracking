import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import App from './App'
import { I18nProvider } from './contexts/I18nContext'
import { useSettingsStore } from './store/settingsStore'
import type { Settings } from '../../shared/types'

vi.mock('./hooks/useTimer', () => ({
  useTimer: () => ({
    runningEntry: null,
    idleEvent: null,
    quickNoteEntry: null,
    clients: [],
    isLoading: false
  }),
  handleOpenStart: vi.fn()
}))
vi.mock('./views/TodayView', () => ({ default: () => <div>Today content</div> }))
vi.mock('./components/UpdateBanner', () => ({ UpdateBanner: () => null }))
vi.mock('./components/LongRunModal', () => ({ LongRunModal: () => null }))
vi.mock('./components/StartTimerModal', () => ({ StartTimerModal: () => null }))
vi.mock('./components/Toast', () => ({ ToastTray: () => null }))
vi.mock('./components/heute/AppHeader', () => ({
  AppHeader: ({ onNavigate }: { onNavigate: (view: 'today' | 'settings') => void }) => (
    <nav>
      <button onClick={() => onNavigate('today')}>Today</button>
      <button onClick={() => onNavigate('settings')}>Settings</button>
    </nav>
  )
}))
beforeEach(() => {
  const settings = { language: 'en', onboarding_completed: '1' } as Settings
  useSettingsStore.setState({ settings })
  window.api = {
    settings: { getAll: async () => ({ ok: true, data: settings }) },
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
    app: { getVersion: async () => ({ ok: true, data: '2.6.1' }) },
    backups: {
      list: async () => ({ ok: true, data: [] }),
      getPathInfo: async () => ({
        ok: true,
        data: { dir: 'custom', defaultDir: 'default', isCustom: true, isReachable: false }
      })
    },
    feedbackRules: { names: async () => ({ ok: true, data: [] }) },
    onOpenStart: () => () => {}
  } as unknown as Window['api']
})
afterEach(() => {
  cleanup()
  useSettingsStore.setState({ settings: null })
})
describe('backup banner navigation (#512)', () => {
  it('opens Data, including when Settings is already open on another tab', async () => {
    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    )
    await screen.findByText('Today content')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    })
    expect(await screen.findByText('No backups available')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'General' }))
    expect(screen.queryByText('No backups available')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    })
    expect(await screen.findByText('No backups available')).toBeTruthy()
    // Header navigation retains its usual General entry point.
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    })
    expect(screen.queryByText('No backups available')).toBeNull()
    expect(screen.getByRole('button', { name: 'General' }).className).toContain('bg-[var(--inv)]')
  })
})
