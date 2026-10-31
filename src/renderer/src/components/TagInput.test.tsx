/**
 * Characterization tests for TagInput (#142, Schritt 2).
 *
 * Written against the pre-refactor implementation and kept green through it:
 * the suggestion list moves from `useState` + `useEffect` to a `useMemo`, and
 * the highlight reset that shared that effect moves to the two places that
 * actually trigger it (typing, and removing a chip). These tests pin the
 * observable behavior across that move — they are the safety net #142 says
 * the renderer lacks, not a spec for new behavior.
 *
 * The reset cases (5 and 6) are the ones that matter: they are the only part
 * of the old effect that is NOT a pure derivation, so they are the only part
 * that can silently disappear during the refactor.
 */
import { useState } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, render, waitFor, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { TagInput } from './TagInput'
import { I18nProvider } from '../contexts/I18nContext'
import { serializeTags } from '../../../shared/tags'

// `globals` is off in vitest.config.ts, so Testing Library's auto-cleanup
// afterEach is never registered — unmount explicitly or the screen queries
// see every previous render.
afterEach(cleanup)

const KNOWN = ['bug', 'docs', 'ux']

interface ApiMock {
  create: ReturnType<typeof vi.fn>
}

function mockApi(known: string[]): ApiMock {
  const registry = [...known]
  const create = vi.fn(async (name: string) => {
    registry.push(name)
    return { ok: true as const, data: undefined }
  })
  const api = {
    tags: {
      getAllWithCount: async () => ({
        ok: true as const,
        data: registry.map((name) => ({ name, count: 1 }))
      }),
      create
    }
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { create }
}

/** Controlled wrapper — mirrors how EntryEditForm/StartTimerModal drive it. */
function Harness({
  initial = '',
  onChange
}: {
  initial?: string
  onChange?: (v: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  return (
    <I18nProvider>
      <TagInput
        value={value}
        onChange={(v) => {
          setValue(v)
          onChange?.(v)
        }}
      />
    </I18nProvider>
  )
}

/** Renders, waits for the async master-registry load, opens the dropdown. */
async function setup(opts: { initial?: string; known?: string[] } = {}): Promise<{
  input: HTMLInputElement
  onChange: ReturnType<typeof vi.fn>
  api: ApiMock
}> {
  const api = mockApi(opts.known ?? KNOWN)
  const onChange = vi.fn()
  render(<Harness initial={opts.initial ?? ''} onChange={onChange} />)
  const input = screen.getByLabelText('Tag eingeben') as HTMLInputElement
  // React 17+ delegates onFocus to the bubbling `focusin`; a plain `focus`
  // event never reaches the handler.
  fireEvent.focusIn(input)
  // The registry arrives via IPC after mount; before it does, the list is empty.
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeNull())
  return { input, onChange, api }
}

function optionTexts(): string[] {
  return screen.queryAllByRole('option').map((li) => li.textContent ?? '')
}

function highlightedText(): string | null {
  const sel = screen
    .queryAllByRole('option')
    .find((li) => li.getAttribute('aria-selected') === 'true')
  return sel ? (sel.textContent ?? '') : null
}

describe('TagInput — suggestion list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('1 — zeigt beim Fokus alle bekannten Tags, bereits gewählte ausgenommen', async () => {
    await setup({ initial: serializeTags(['bug']) })
    expect(optionTexts()).toEqual(['#docs', '#ux'])
  })

  it('2 — filtert nach Präfix und hängt den Erstellen-Eintrag an', async () => {
    const { input } = await setup()
    fireEvent.change(input, { target: { value: 'u' } })
    // 'u' matches 'ux' by prefix and is itself not a known tag → create option.
    expect(optionTexts()).toEqual(['#ux', "+ 'u' erstellen"])
  })

  it('3 — kein Erstellen-Eintrag bei exaktem Treffer', async () => {
    const { input } = await setup()
    fireEvent.change(input, { target: { value: 'ux' } })
    expect(optionTexts()).toEqual(['#ux'])
  })

  it('4 — höchstens 8 Vorschläge', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `tag${i}`)
    await setup({ known: many })
    expect(optionTexts()).toHaveLength(8)
  })

  it('5 — Tippen setzt die Markierung zurück', async () => {
    const { input } = await setup()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(highlightedText()).toBe('#bug')

    fireEvent.change(input, { target: { value: 'd' } })
    expect(highlightedText()).toBeNull()
  })

  it('6 — das Entfernen eines Chips setzt die Markierung zurück', async () => {
    const { input } = await setup({ initial: serializeTags(['bug', 'ux']) })
    expect(optionTexts()).toEqual(['#docs'])

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(highlightedText()).toBe('#docs')

    // Backspace on an empty input removes the last chip; the list grows by the
    // freed tag, so a stale index would now point at a different entry.
    fireEvent.keyDown(input, { key: 'Backspace' })
    await waitFor(() => expect(optionTexts()).toEqual(['#docs', '#ux']))
    expect(highlightedText()).toBeNull()
  })
})

describe('TagInput — keyboard commit paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('7 — Enter übernimmt den markierten Vorschlag', async () => {
    const { input, onChange } = await setup()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(highlightedText()).toBe('#docs')

    fireEvent.change(input, { target: { value: 'd' } })
    // Typing reset the highlight, so re-arm it before committing.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(serializeTags(['docs'])))
  })

  it('8 — Enter auf unbekanntem Freitext legt den Tag an', async () => {
    const { input, onChange, api } = await setup()
    fireEvent.change(input, { target: { value: 'neu' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(api.create).toHaveBeenCalledWith('neu'))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(serializeTags(['neu'])))
  })

  it('9 — Escape schließt die Liste', async () => {
    const { input } = await setup()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('TagInput — Dropdown gegen den Host-Dialog (#158)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('10 — Enter übernimmt den markierten Vorschlag auch bei leerem Eingabefeld', async () => {
    const { input, onChange } = await setup()
    // Kein Zeichen tippen — nur Pfeil-runter, dann Enter. Der Zweig lag hinter
    // `&& inputValue.trim()`, griff also nie: die Auswahl wurde still verworfen
    // und Enter sendete stattdessen das umschließende Formular ab.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(highlightedText()).toBe('#bug')

    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(serializeTags(['bug'])))
  })

  it('11 — Enter ohne Markierung und ohne Text bleibt beim Formular', async () => {
    const { input, onChange } = await setup()
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)

    // Nichts markiert, nichts getippt: TagInput darf das Event nicht
    // abfangen, sonst lässt sich der Eintrag nicht mehr per Enter speichern.
    fireEvent.keyDown(input, { key: 'Enter' })

    window.removeEventListener('keydown', onWindowKey)
    expect(onWindowKey).toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('12 — Escape bei offener Liste erreicht den Host-Dialog nicht', async () => {
    const { input } = await setup()
    // Dialog.tsx und CalendarDrawer.tsx hängen ihren Escape-Handler an
    // `window`; ohne stopPropagation schließt die erste Escape-Taste den
    // ganzen Dialog und die ungespeicherten Änderungen sind weg.
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)

    fireEvent.keyDown(input, { key: 'Escape' })

    window.removeEventListener('keydown', onWindowKey)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onWindowKey).not.toHaveBeenCalled()
  })

  it('13 — Escape bei geschlossener Liste erreicht den Host-Dialog sehr wohl', async () => {
    const { input } = await setup()
    fireEvent.keyDown(input, { key: 'Escape' }) // schließt die Liste
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)

    fireEvent.keyDown(input, { key: 'Escape' }) // zweite Taste → Dialog

    window.removeEventListener('keydown', onWindowKey)
    expect(onWindowKey).toHaveBeenCalled()
  })

  it('14 — ein Klick ins bereits fokussierte Feld öffnet die Liste erneut', async () => {
    const { input } = await setup()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())

    // `onFocus` feuert nicht erneut, wenn der Cursor das Feld nie verlassen hat.
    fireEvent.click(input)
    expect(screen.queryByRole('listbox')).not.toBeNull()
  })

  it('15 — nach einer Übernahme ist die Markierung zurückgesetzt', async () => {
    const { input } = await setup()
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // markiert '#bug'
    fireEvent.keyDown(input, { key: 'Enter' }) // übernimmt, Liste schließt
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())

    // Regression aus #142 (nie veröffentlicht): der Reset hing am Effekt, der
    // beim Umbau auf useMemo entfiel — dieser Pfad wurde übersehen. Sonst steht
    // beim nächsten Öffnen ein Eintrag markiert, den niemand gewählt hat, und
    // mit Fall 10 übernimmt Enter ihn.
    //
    // Gemessen statt behauptet über ArrowDown, das die Liste selbst öffnet und
    // den Index um eins vorrückt — unabhängig von Fall 14:
    //   zurückgesetzt (-1) → Index 0 → '#docs'
    //   stale        ( 0) → Index 1 → '#ux'
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(highlightedText()).toBe('#docs')
  })
})

describe('TagInput — scrolling the highlighted suggestion (#449)', () => {
  let original: PropertyDescriptor | undefined
  const scrollIntoView = vi.fn()

  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    scrollIntoView.mockClear()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })
  })

  afterEach(() => {
    if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original)
    else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  })

  it('scrolls each keyboard-highlighted option into view in a long list', async () => {
    const { input } = await setup({ known: Array.from({ length: 8 }, (_, i) => `tag${i}`) })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(8)

    for (const [i, option] of options.entries()) {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      expect(option.getAttribute('aria-selected')).toBe('true')
      expect(scrollIntoView).toHaveBeenCalledTimes(i + 1)
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(option)
    }

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(options[6].getAttribute('aria-selected')).toBe('true')
    expect(scrollIntoView).toHaveBeenCalledTimes(9)
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(options[6])
  })

  it('does not scroll when no option is highlighted', async () => {
    const { input } = await setup()
    expect(highlightedText()).toBeNull()
    expect(scrollIntoView).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    scrollIntoView.mockClear()

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(highlightedText()).toBeNull()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('does not scroll while closed and scrolls the retained highlight on reopening', async () => {
    const { input } = await setup()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    scrollIntoView.mockClear()

    fireEvent.pointerDown(document.body)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(scrollIntoView).not.toHaveBeenCalled()

    fireEvent.click(input)
    const first = screen.getAllByRole('option')[0]
    expect(first.getAttribute('aria-selected')).toBe('true')
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' })
    expect(scrollIntoView.mock.contexts[0]).toBe(first)
  })
})

describe('TagInput — chip remove key', () => {
  it('is a 24 px target (WCAG 2.5.8) with a name', async () => {
    mockApi(KNOWN)
    render(<Harness initial=",kunde," />)
    const remove = screen.getByRole('button', { name: 'Tag kunde entfernen' })
    expect(remove.className).toContain('h-6 w-6')
  })
})
