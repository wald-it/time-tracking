/**
 * Q8, 2.2: the description field suggests the user's own recent texts for
 * the chosen client and project, after the TagInput pattern — list under the
 * field, ↑↓ to move, Enter to take one, Escape closes only the list.
 */
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DescriptionInput } from './DescriptionInput'
import { I18nProvider } from '../contexts/I18nContext'

afterEach(() => {
  cleanup()
})

const TEXTS = ['Rollout: Planung', 'Rollout: Abstimmung', 'Review']

function setup(opts: { clientId?: number | null; projectId?: number | null } = {}): {
  recent: ReturnType<typeof vi.fn>
  onEnter: ReturnType<typeof vi.fn>
  input: () => HTMLInputElement
  value: () => string
} {
  const recent = vi.fn(async () => ({ ok: true as const, data: TEXTS }))
  ;(window as unknown as { api: unknown }).api = { entries: { recentDescriptions: recent } }
  const onEnter = vi.fn()
  let current = ''
  function Harness(): React.JSX.Element {
    const [v, setV] = useState('')
    current = v
    return (
      <DescriptionInput
        value={v}
        onChange={setV}
        onEnter={onEnter}
        clientId={opts.clientId === undefined ? 1 : opts.clientId}
        projectId={opts.projectId === undefined ? 10 : opts.projectId}
        placeholder="Woran arbeitest du?"
      />
    )
  }
  render(
    <I18nProvider>
      <Harness />
    </I18nProvider>
  )
  return {
    recent,
    onEnter,
    input: () => screen.getByPlaceholderText('Woran arbeitest du?') as HTMLInputElement,
    value: () => current
  }
}

describe('DescriptionInput (Q8)', () => {
  it.each(['clientId', 'projectId'] as const)(
    'clears suggestions on a %s change and ignores late results',
    async (changedId) => {
      type Result = { ok: true; data: string[] }
      const pending = Promise.withResolvers<Result>()
      const latest = Promise.withResolvers<Result>()
      const recent = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, data: ['Old pair text'] })
        .mockReturnValueOnce(pending.promise)
        .mockReturnValueOnce(latest.promise)
      window.api = { entries: { recentDescriptions: recent } } as unknown as Window['api']
      const onChange = vi.fn()
      const onEnter = vi.fn()
      const props = { value: '', onChange, onEnter, clientId: 1, projectId: 10 }
      const { rerender } = render(<DescriptionInput {...props} />)
      const input = screen.getByRole('textbox')
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      await screen.findByRole('option', { name: 'Old pair text' })
      fireEvent.keyDown(input, { key: 'ArrowDown' })

      rerender(<DescriptionInput {...props} {...{ [changedId]: 20 }} />)
      expect(recent).toHaveBeenLastCalledWith({
        clientId: 1,
        projectId: 10,
        [changedId]: 20
      })
      expect.soft(screen.queryByRole('listbox')).toBeNull()
      expect.soft(screen.queryByRole('option', { name: 'Old pair text' })).toBeNull()
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect.soft(onChange).not.toHaveBeenCalledWith('Old pair text')
      expect.soft(onEnter).toHaveBeenCalledTimes(1)

      // Change again while the preceding lookup is still pending.
      rerender(<DescriptionInput {...props} {...{ [changedId]: 30 }} />)
      await act(async () => {
        latest.resolve({ ok: true, data: ['Latest pair text'] })
      })
      expect.soft(screen.queryByRole('listbox')).toBeNull()
      fireEvent.click(input)
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
        'Latest pair text'
      ])
      expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'false')

      await act(async () => {
        pending.resolve({ ok: true, data: ['Late old pair text'] })
      })
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
        'Latest pair text'
      ])
    }
  )

  it('lets Escape reach the parent after typing with no visible suggestions', async () => {
    const recent = vi.fn(async () => ({ ok: true as const, data: [] }))
    window.api = { entries: { recentDescriptions: recent } } as unknown as Window['api']
    const outer = vi.fn()
    function Harness(): React.JSX.Element {
      const [value, setValue] = useState('')
      return (
        <div onKeyDown={outer}>
          <DescriptionInput value={value} onChange={setValue} clientId={1} projectId={10} />
        </div>
      )
    }
    await act(async () => {
      render(<Harness />)
    })
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'New text' } })
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(outer).toHaveBeenCalledTimes(1)
    expect(outer.mock.calls[0][0].key).toBe('Escape')
  })

  it.each(['absent', 'refused', 'rejected'] as const)(
    'Q8 keeps typing usable when the lookup is %s',
    async (mode) => {
      const lookup =
        mode === 'absent'
          ? undefined
          : vi.fn(async () => {
              if (mode === 'rejected') throw new Error('Lookup unavailable')
              return { ok: false as const, error: 'Lookup unavailable' }
            })
      window.api = { entries: { recentDescriptions: lookup } } as unknown as Window['api']
      const onEnter = vi.fn()
      function Harness(): React.JSX.Element {
        const [value, setValue] = useState('')
        return (
          <DescriptionInput
            value={value}
            onChange={setValue}
            onEnter={onEnter}
            clientId={1}
            projectId={null}
            ariaLabel="Description"
          />
        )
      }
      await act(async () => {
        render(<Harness />)
      })
      const input = screen.getByRole('textbox', { name: 'Description' })
      fireEvent.change(input, { target: { value: 'My own text' } })
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(input).toHaveValue('My own text')
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onEnter).toHaveBeenCalledTimes(1)
      // Vitest also fails this test file on an unhandled rejected lookup.
    }
  )
  it('reads the suggestions of the chosen pair', async () => {
    const { recent } = setup({ clientId: 2, projectId: null })
    await waitFor(() => expect(recent).toHaveBeenCalledWith({ clientId: 2, projectId: null }))
  })

  it('reads nothing without a client', async () => {
    const { recent } = setup({ clientId: null })
    await new Promise((r) => setTimeout(r, 20))
    expect(recent).not.toHaveBeenCalled()
  })

  it('shows them on ArrowDown, and Enter takes the highlighted one', async () => {
    const { input, onEnter, value, recent } = setup()
    await waitFor(() => expect(recent).toHaveBeenCalled())

    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(TEXTS)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Enter' })

    expect(value()).toBe('Rollout: Abstimmung')
    expect(onEnter).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('filters by what is typed, case-insensitive, anywhere in the text', async () => {
    const { input, recent } = setup()
    await waitFor(() => expect(recent).toHaveBeenCalled())

    fireEvent.change(input(), { target: { value: 'rollout' } })

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Rollout: Planung',
      'Rollout: Abstimmung'
    ])
  })

  it('Enter without a highlighted suggestion is the host’s Enter (the dialog starts)', async () => {
    const { input, onEnter, recent } = setup()
    await waitFor(() => expect(recent).toHaveBeenCalled())

    fireEvent.change(input(), { target: { value: 'Neu' } })
    fireEvent.keyDown(input(), { key: 'Enter' })

    expect(onEnter).toHaveBeenCalledTimes(1)
  })

  it('does not open the list on the first focus (the dialog focuses the field on open)', async () => {
    const { input, recent } = setup()
    await waitFor(() => expect(recent).toHaveBeenCalled())

    fireEvent.focus(input())

    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('Escape closes only the list', async () => {
    const { input, recent } = setup()
    await waitFor(() => expect(recent).toHaveBeenCalled())
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    // Listen only now: the ↓ that opened the list may reach the window.
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(outer).not.toHaveBeenCalled()

    // With the list closed, Escape belongs to the host (the dialog closes).
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(outer).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', outer)
  })
})
