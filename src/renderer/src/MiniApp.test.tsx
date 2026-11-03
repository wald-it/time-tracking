import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, cleanup, fireEvent, render, screen, type RenderResult } from '@testing-library/react'
import MiniApp from './MiniApp'
import { I18nProvider } from './contexts/I18nContext'
import { useSettingsStore } from './store/settingsStore'
import type { Settings } from '../../shared/types'

type MiniState = Parameters<Parameters<Window['api']['mini']['onState']>[0]>[0]
const stopped: MiniState = {
  running: false,
  label: '',
  startedAt: null,
  unexplainedSince: null
}

afterEach(() => {
  cleanup()
  useSettingsStore.setState({ settings: null })
  delete (window as unknown as { api?: unknown }).api
})

function mount(state: MiniState): RenderResult & {
  requestStart: Mock
  push: (next: MiniState) => void
  unsubscribe: Mock
} {
  let listener: (state: MiniState) => void = () => {}
  const unsubscribe = vi.fn()
  const requestStart = vi.fn()
  window.api = {
    mini: {
      onState: (callback: typeof listener) => {
        listener = callback
        return unsubscribe
      },
      requestStart,
      requestStop: vi.fn()
    }
  } as unknown as Window['api']
  const view = render(
    <I18nProvider>
      <MiniApp />
    </I18nProvider>
  )
  act(() => listener(state))
  return {
    ...view,
    requestStart,
    push: (next: MiniState) => act(() => listener(next)),
    unsubscribe
  }
}

describe('MiniApp unexplained state', () => {
  it.each([
    ['de', 'Bereit', 'ungeklärt seit 14:00'],
    ['en', 'Ready', 'unexplained since 14:00']
  ])('shows two dim lines and the full title in %s', (language, ready, line) => {
    useSettingsStore.setState({ settings: { language } as Settings })
    const view = mount({ ...stopped, unexplainedSince: new Date(2026, 10, 2, 14).toISOString() })
    const text = screen.getByTitle(`${ready} · ${line}`)
    expect(text).toHaveClass(
      'flex-col',
      'text-[11px]',
      'leading-[12px]',
      'text-[var(--disp-dim,#8f8c83)]'
    )
    expect(screen.getByText(ready).parentElement).toBe(text)
    expect(screen.getByText(line).parentElement).toBe(text)
    fireEvent.click(screen.getByRole('button'))
    expect(view.requestStart).toHaveBeenCalledOnce()
    view.unmount()
    expect(view.unsubscribe).toHaveBeenCalledOnce()
  })

  it('keeps Kein Timer without a value, including after the gap disappears', () => {
    const view = mount(stopped)
    expect(screen.getByText('Kein Timer')).toBeInTheDocument()
    view.push({ ...stopped, unexplainedSince: new Date(2026, 10, 2, 14).toISOString() })
    expect(screen.queryByText('Kein Timer')).not.toBeInTheDocument()
    view.push(stopped)
    expect(screen.getByText('Kein Timer')).toBeInTheDocument()
    expect(screen.queryByText('Bereit')).not.toBeInTheDocument()
  })

  it('keeps the running display when a time is supplied', () => {
    mount({ ...stopped, running: true, label: 'Acme', unexplainedSince: new Date().toISOString() })
    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.queryByText(/ungeklärt/)).not.toBeInTheDocument()
  })
})
