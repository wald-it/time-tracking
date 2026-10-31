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
import { en } from '../../../shared/locales/en'
import { FeedTokenRecreatedHint, SecretStorageHint } from '../components/SecretStorageHint'

afterEach(cleanup)

const URL_A = 'https://hooks.example.com/a'
const URL_OLD = 'https://hooks.example.com/old'

type SetResult = { ok: true; data: undefined } | { ok: false; error: string; code?: 'cancelled' }

function mockSet(
  result: SetResult
): ReturnType<typeof vi.fn<(key: string, value: string) => Promise<SetResult>>> {
  const set = vi.fn<(key: string, value: string) => Promise<SetResult>>(async () => result)
  ;(window as unknown as { api: unknown }).api = {
    settings: { getAll: async () => ({ ok: true, data: { webhook_targets: existing } }), set }
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

describe('stored webhook secret markers (#470)', () => {
  it('shows a stored secret without receiving it; an empty field keeps it and explicit clear removes it', async () => {
    const set = mockSet({ ok: true, data: undefined })
    render(
      <I18nProvider>
        <WebhooksSection
          initialRaw={JSON.stringify([
            {
              id: 'stored',
              url: URL_OLD,
              secret: '',
              secretStored: true,
              events: ['timer.started'],
              enabled: true
            }
          ])}
          logsPath="logs"
        />
      </I18nProvider>
    )
    const secret = screen.getByLabelText(de['settings.webhooks.secret']) as HTMLInputElement
    expect(secret.value).toBe('')
    expect(secret.placeholder).toBe(de['settings.webhooks.secretStored'])
    await act(async () => {
      fireEvent.click(screen.getByLabelText(de['settings.webhooks.event.timerStopped']))
    })
    expect(JSON.parse(set.mock.calls[0][1])[0]).toMatchObject({ secret: '', secretStored: true })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: de['settings.webhooks.clearSecret'] }))
    })
    expect(JSON.parse(set.mock.calls[1][1])[0]).toMatchObject({ secret: '' })
    expect(JSON.parse(set.mock.calls[1][1])[0].secretStored).toBeUndefined()
    expect(secret.placeholder).toBe('')
  })

  it('says at the target when its secret is missing on this machine, and only there', () => {
    render(
      <I18nProvider>
        <WebhooksSection
          initialRaw={JSON.stringify([
            {
              id: 'lost',
              url: URL_OLD,
              secret: '',
              secretStored: true,
              secretUnreadable: true,
              events: ['timer.started'],
              enabled: true
            },
            {
              id: 'fine',
              url: 'https://fine.example/hook',
              secret: '',
              secretStored: true,
              events: ['timer.started'],
              enabled: true
            }
          ])}
          logsPath="logs"
          secretStorage="encrypted"
        />
      </I18nProvider>
    )
    expect(screen.getAllByText(de['settings.webhooks.secretMissing'])).toHaveLength(1)
    expect(screen.getAllByText(de['settings.webhooks.secretHint'])).toHaveLength(2)
    expect(de['settings.webhooks.secretHint']).not.toContain('Klartext')
  })

  it('says the feed address was created anew only while the feed is on', () => {
    const { container, rerender } = render(
      <I18nProvider>
        <FeedTokenRecreatedHint recreated enabled />
      </I18nProvider>
    )
    expect(screen.getByText(de['settings.icalFeed.tokenRecreated'])).toBeTruthy()
    rerender(
      <I18nProvider>
        <FeedTokenRecreatedHint recreated enabled={false} />
      </I18nProvider>
    )
    expect(container.textContent).toBe('')
    rerender(
      <I18nProvider>
        <FeedTokenRecreatedHint recreated={undefined} enabled />
      </I18nProvider>
    )
    expect(container.textContent).toBe('')
  })

  it('keeps the plain-text wording of the secret hint in plain mode', () => {
    render(
      <I18nProvider>
        <WebhooksSection
          initialRaw={JSON.stringify([
            { id: 'p', url: URL_OLD, secret: '', events: ['timer.started'], enabled: true }
          ])}
          logsPath="logs"
          secretStorage="plain"
        />
      </I18nProvider>
    )
    expect(screen.getByText(de['settings.webhooks.secretHintPlain'])).toBeTruthy()
  })

  it.each(['plain', 'unreadable'] as const)('shows the %s storage hint beside webhooks', (mode) => {
    render(
      <I18nProvider>
        <WebhooksSection initialRaw="[]" logsPath="logs" secretStorage={mode} />
      </I18nProvider>
    )
    expect(screen.getByText(de[`settings.secrets.${mode}`])).toBeTruthy()
  })

  it('has English and German hints and hides the hint for encrypted storage', () => {
    expect(en['settings.secrets.plain']).toBe(
      'Secrets are stored unencrypted because the system offers no encryption'
    )
    expect(en['settings.secrets.unreadable']).toContain('Regenerate the feed address')
    const { container } = render(
      <I18nProvider>
        <SecretStorageHint mode="encrypted" />
      </I18nProvider>
    )
    expect(container.textContent).toBe('')
  })
})

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

  it('Shift+Tab to Remove does not save the typed address', async () => {
    const set = mockSet({ ok: true, data: undefined })
    const input = await renderSection()
    input.focus()
    fireEvent.change(input, { target: { value: URL_A } })
    const remove = screen.getByRole('button', { name: de['settings.webhooks.remove'] })
    await act(async () => {
      fireEvent.blur(input, { relatedTarget: remove })
      fireEvent.focusOut(input, { relatedTarget: remove })
    })
    expect(set).not.toHaveBeenCalled()
    // The unsaved address does not stay in the field looking saved.
    expect(input.value).toBe(URL_OLD)
  })

  // Codex follow-up: a save queued behind a declined one was built on the
  // declined list and may be confirmed itself; the editor must end up showing
  // what is stored, not the read-back from the moment of the decline.
  it('after a decline, a queued save that is confirmed is what the editor shows', async () => {
    let stored = existing
    let releaseFirst: (r: SetResult) => void = () => {}
    let call = 0
    const set = vi.fn<(key: string, value: string) => Promise<SetResult>>(async (_k, v) => {
      call++
      if (call === 1) return new Promise<SetResult>((r) => (releaseFirst = r))
      stored = v
      return { ok: true, data: undefined }
    })
    ;(window as unknown as { api: unknown }).api = {
      settings: { getAll: async () => ({ ok: true, data: { webhook_targets: stored } }), set }
    }
    const input = await renderSection()
    input.focus()
    fireEvent.change(input, { target: { value: URL_A } })
    await act(async () => {
      input.blur()
    })
    const secret = screen.getByLabelText(/^Secret/) as HTMLInputElement
    await act(async () => {
      fireEvent.change(secret, { target: { value: 'new-secret' } })
    })
    await act(async () => {
      releaseFirst({ ok: false, error: 'declined', code: 'cancelled' })
    })
    await act(async () => {})
    expect(set).toHaveBeenCalledTimes(2)
    const kept = JSON.parse(stored)[0]
    expect(kept.url).toBe(URL_A)
    expect(kept.secret).toBe('new-secret')
    expect(input.value).toBe(URL_A)
    expect(secret.value).toBe('new-secret')
  })

  it('an accepted save followed by a declined one ends on the stored list', async () => {
    let stored = existing
    let call = 0
    const set = vi.fn<(key: string, value: string) => Promise<SetResult>>(async (_k, v) => {
      call++
      if (call === 2) return { ok: false, error: 'declined', code: 'cancelled' }
      stored = v
      return { ok: true, data: undefined }
    })
    ;(window as unknown as { api: unknown }).api = {
      settings: { getAll: async () => ({ ok: true, data: { webhook_targets: stored } }), set }
    }
    const URL_B = 'https://hooks.example.com/b'
    const input = await renderSection()
    input.focus()
    fireEvent.change(input, { target: { value: URL_A } })
    await act(async () => {
      input.blur()
    })
    input.focus()
    fireEvent.change(input, { target: { value: URL_B } })
    await act(async () => {
      input.blur()
    })
    await act(async () => {})
    expect(set).toHaveBeenCalledTimes(2)
    expect(JSON.parse(stored)[0].url).toBe(URL_A)
    expect(input.value).toBe(URL_A)
  })

  // Codex follow-up 2: an edit made while the reload after a decline is still
  // pending must not be overwritten for good by that (older) reload.
  it('an edit during the reload after a decline still ends on the stored list', async () => {
    let stored = existing
    let call = 0
    const set = vi.fn<(key: string, value: string) => Promise<SetResult>>(async (_k, v) => {
      call++
      if (call === 1) return { ok: false, error: 'declined', code: 'cancelled' }
      stored = v
      return { ok: true, data: undefined }
    })
    let releaseReload: () => void = () => {}
    let reloads = 0
    const getAll = vi.fn(async () => {
      reloads++
      const snapshot = stored
      if (reloads === 1) await new Promise<void>((r) => (releaseReload = r))
      return { ok: true, data: { webhook_targets: snapshot } }
    })
    ;(window as unknown as { api: unknown }).api = { settings: { getAll, set } }
    const input = await renderSection()
    input.focus()
    fireEvent.change(input, { target: { value: URL_A } })
    await act(async () => {
      input.blur()
    })
    // The decline is in; the reload is now pending. An edit arrives meanwhile.
    const secret = screen.getByLabelText(/^Secret/) as HTMLInputElement
    await act(async () => {
      fireEvent.change(secret, { target: { value: 'during-reload' } })
    })
    await act(async () => {
      releaseReload()
    })
    await act(async () => {})
    // The editor shows exactly what is stored (the edit was built on the list
    // that still held the declined address, and its own save went through).
    const kept = JSON.parse(stored)[0]
    expect(kept.secret).toBe('during-reload')
    expect(secret.value).toBe(kept.secret)
    expect(input.value).toBe(kept.url)
  })
})
