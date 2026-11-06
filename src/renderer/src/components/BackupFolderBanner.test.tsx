import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BackupFolderBanner } from './BackupFolderBanner'
import { I18nProvider } from '../contexts/I18nContext'
import { useSettingsStore } from '../store/settingsStore'
import type { Settings } from '../../../shared/types'

const info = { dir: 'custom', defaultDir: 'default', isCustom: true, isReachable: false }
let getPathInfo: ReturnType<typeof vi.fn>
const openSettings = vi.fn()
beforeEach(() => {
  useSettingsStore.setState({ settings: { language: 'en' } as Settings })
  getPathInfo = vi.fn(async () => ({ ok: true, data: info }))
  window.api = { backups: { getPathInfo } } as unknown as Window['api']
  openSettings.mockClear()
})
afterEach(() => {
  cleanup()
  useSettingsStore.setState({ settings: null })
  vi.useRealTimers()
  vi.restoreAllMocks()
})
async function mount(): Promise<ReturnType<typeof render>> {
  const result = render(
    <I18nProvider>
      <BackupFolderBanner onOpenSettings={openSettings} />
    </I18nProvider>
  )
  await act(async () => {})
  return result
}
describe('BackupFolderBanner (#512)', () => {
  it('shows an unreachable custom folder and opens settings', async () => {
    await mount()
    expect(screen.getByRole('status').textContent).toContain(
      'Backup folder cannot be reached. Backups go to the default folder.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(openSettings).toHaveBeenCalledOnce()
  })
  it.each([
    { ...info, isReachable: true },
    { ...info, isCustom: false }
  ])('hides for %j', async (data) => {
    getPathInfo.mockResolvedValue({ ok: true, data })
    await mount()
    expect(getPathInfo).toHaveBeenCalledOnce()
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('dismisses until app restart, including subsequent refreshes', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await act(async () => {
      fireEvent.focus(window)
    })
    expect(screen.queryByRole('status')).toBeNull()
    // No further checks once dismissed: a hanging share is not polled.
    expect(getPathInfo).toHaveBeenCalledOnce()
  })
  it('starts no second check while one is still pending', async () => {
    let resolve: (v: unknown) => void = () => {}
    getPathInfo.mockImplementation(() => new Promise((r) => (resolve = r)))
    await mount()
    await act(async () => {
      fireEvent.focus(window)
      fireEvent.focus(window)
    })
    expect(getPathInfo).toHaveBeenCalledOnce()
    await act(async () => {
      resolve({ ok: true, data: info })
    })
    expect(screen.getByRole('status')).toBeTruthy()
    getPathInfo.mockResolvedValue({ ok: true, data: { ...info, isReachable: true } })
    await act(async () => {
      fireEvent.focus(window)
    })
    expect(getPathInfo).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('rechecks on focus and hides after recovery', async () => {
    await mount()
    expect(screen.getByRole('status')).toBeTruthy()
    getPathInfo.mockResolvedValue({ ok: true, data: { ...info, isReachable: true } })
    await act(async () => {
      fireEvent.focus(window)
    })
    expect(getPathInfo).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('polls every five minutes and removes the listener and interval on unmount', async () => {
    vi.useFakeTimers()
    const result = await mount()
    expect(screen.getByRole('status')).toBeTruthy()
    getPathInfo.mockResolvedValue({ ok: true, data: { ...info, isReachable: true } })
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000)
    })
    expect(getPathInfo).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('status')).toBeNull()
    result.unmount()
    await act(async () => {
      fireEvent.focus(window)
      vi.advanceTimersByTime(5 * 60_000)
    })
    expect(getPathInfo).toHaveBeenCalledTimes(2)
  })
})
