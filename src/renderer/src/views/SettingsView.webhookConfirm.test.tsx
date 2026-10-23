/**
 * #272 (A3) — a new webhook address asks for a native confirmation in the
 * main process. The URL field therefore saves when it is left (or on Enter),
 * not per keystroke, so the question comes once for the whole address; and
 * a declined confirmation puts the list back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { WebhooksSection } from './SettingsView'
import { I18nProvider } from '../contexts/I18nContext'
import { de } from '../../../shared/locales/de'

afterEach(cleanup)

const URL_A = 'https://hooks.example.com/a'
const URL_OLD = 'https://hooks.example.com/old'

type SetResult = { ok: true; data: undefined } | { ok: false; error: string; code?: 'cancelled' }

function mockSet(
  result: SetResult
): ReturnType<typeof vi.fn<(key: string, value: string) => Promise<SetResult>>> {
  const set = vi.fn<(key: string, value: string) => Promise<SetResult>>(async () => result)
  ;(window as unknown as { api: unknown }).api = {
    settings: { getAll: async () => ({ ok: true, data: {} }), set }
  }
  return set
}

const existing = JSON.stringify([
  { id: 't1', url: URL_OLD, secret: '', events: ['timer.started'], enabled: true }
])

async function renderSection(): Promise<HTMLInputElement> {
  render(
    <I18nProvider>
      <WebhooksSection initialRaw={existing} logsPath="logs" />
    </I18nProvider>
  )
  await act(async () => {})
  return screen.getByLabelText(de['settings.webhooks.url']) as HTMLInputElement
}

describe('webhook address (#272 A3)', () => {
  it('typing saves nothing; leaving the field saves the whole address once', async () => {
    const set = mockSet({ ok: true, data: undefined })
    const input = await renderSection()
    input.focus()
    for (const part of ['https://', 'https://hooks', URL_A]) {
      fireEvent.change(input, { target: { value: part } })
    }
    expect(set).not.toHaveBeenCalled()
    await act(async () => {
      input.blur()
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(JSON.parse(set.mock.calls[0][1])[0].url).toBe(URL_A)
  })

  it('Enter saves as well', async () => {
    const set = mockSet({ ok: true, data: undefined })
    const input = await renderSection()
    input.focus()
    fireEvent.change(input, { target: { value: URL_A } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    // Enter blurs the field; jsdom fires blur only for a focused element.
    input.focus()
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('a declined confirmation puts the address back', async () => {
    mockSet({ ok: false, error: 'declined', code: 'cancelled' })
    const input = await renderSection()
    input.focus()
    fireEvent.change(input, { target: { value: URL_A } })
    await act(async () => {
      input.blur()
    })
    expect(input.value).toBe(URL_OLD)
  })

  // Review round 1: the field's blur on "Remove" saved (and asked about) the
  // address the user was deleting, and the dialog swallowed the click.
  it('removing a target right after typing does not save the typed address', async () => {
    const set = mockSet({ ok: true, data: undefined })
    const input = await renderSection()
    input.focus()
    fireEvent.change(input, { target: { value: URL_A } })
    const remove = screen.getByRole('button', { name: de['settings.webhooks.remove'] })
    const down = fireEvent.mouseDown(remove)
    // mousedown is cancelled, so the browser would not move the focus away.
    expect(down).toBe(false)
    await act(async () => {
      fireEvent.click(remove)
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(JSON.parse(set.mock.calls[0][1])).toEqual([])
  })
})
