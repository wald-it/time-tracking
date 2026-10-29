import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { I18nProvider } from '../../contexts/I18nContext'
import { NowProvider } from '../../contexts/NowContext'
import { AppHeader } from './AppHeader'
import type { McpApprovalState } from '../../../../shared/types'

vi.mock('../../hooks/useTimer', () => ({
  useTimer: () => ({ runningEntry: null, clients: [], stop: vi.fn() })
}))

let receive: (state: McpApprovalState) => void
const unsubscribe = vi.fn()
const get = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-29T12:00:00Z'))
  unsubscribe.mockClear()
  get.mockResolvedValue({ ok: true, data: { state: 'off' } })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      mcpApproval: {
        get,
        onChanged: (cb: typeof receive) => {
          receive = cb
          return unsubscribe
        }
      }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

async function show(): Promise<ReturnType<typeof render>> {
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(
      <I18nProvider>
        <NowProvider running={false}>
          <AppHeader view="today" onNavigate={vi.fn()} onStartTimer={vi.fn()} />
        </NowProvider>
      </I18nProvider>
    )
  })
  return view
}

it('shows a static signal square with remaining minutes and writes, then hides on reset', async () => {
  get.mockResolvedValue({
    ok: true,
    data: { state: 'window', until: Date.now() + 120000, writesLeft: 19 }
  })
  const view = await show()
  const square = screen.getByRole('img', {
    name: 'MCP-Freigabe: noch 2 Min. und 19 Schreibzugriffe.'
  })
  expect(square).toHaveAttribute('title', square.getAttribute('aria-label'))
  expect(square).toHaveClass('h-[6px]', 'w-[6px]', 'bg-[var(--sig)]')
  expect(square.className).not.toMatch(/blink|animat/)
  expect(square.style.animation).toBe('')
  act(() => vi.advanceTimersByTime(60000))
  expect(square).toHaveAttribute('title', 'MCP-Freigabe: noch 1 Min. und 19 Schreibzugriffe.')
  act(() => receive({ state: 'off' }))
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('keeps silent mode visible and uses a plain tooltip without a countdown', async () => {
  await show()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  act(() => receive({ state: 'silent' }))
  const square = screen.getByRole('img', {
    name: 'MCP-Schreibzugriffe werden ohne Nachfrage zugelassen.'
  })
  expect(square).toHaveAttribute('title', square.getAttribute('aria-label'))
  act(() => vi.advanceTimersByTime(31 * 60000))
  expect(square).toBeVisible()
})

it('hides at the deadline even without an expiry event', async () => {
  get.mockResolvedValue({
    ok: true,
    data: { state: 'window', until: Date.now() + 1250, writesLeft: 20 }
  })
  await show()
  expect(screen.getByRole('img')).toBeVisible()
  act(() => vi.advanceTimersByTime(1250))
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

it('does not let a late initial read overwrite a newer push', async () => {
  let resolve!: (value: unknown) => void
  get.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  await show()
  act(() => receive({ state: 'silent' }))
  expect(screen.getByRole('img')).toBeVisible()
  await act(async () => resolve({ ok: true, data: { state: 'off' } }))
  expect(screen.getByRole('img')).toBeVisible()
})
