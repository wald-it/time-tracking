/**
 * Characterization tests for Dialog (#167): open/close, focus management,
 * Escape. Written against the current implementation to pin observable
 * behavior, not as a spec for new behavior.
 *
 * The focus/keydown effect deliberately depends on [open] only and reads
 * `onClose` through a ref (see the comment in Dialog.tsx): a parent that
 * re-renders every second (Today's ticking timer pill) must not re-trigger
 * the initial-focus routine. Cases 8 and 9 pin both halves of that design —
 * they are the ones that would silently break if the ref were "simplified"
 * back into a dependency.
 */
import { useState } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { Dialog } from './Dialog'
import { I18nProvider } from '../contexts/I18nContext'

// `globals` is off in vitest.config.ts — unmount explicitly (see TagInput test).
afterEach(cleanup)

function renderDialog(ui: React.ReactElement): ReturnType<typeof render> {
  return render(<I18nProvider>{ui}</I18nProvider>)
}

/** Flush the queueMicrotask the focus routine is scheduled on. */
async function flushFocus(): Promise<void> {
  await act(async () => {})
}

const FIELDS = (
  <>
    <input aria-label="Feld eins" />
    <input aria-label="Feld zwei" />
    <button type="button">Speichern</button>
  </>
)

describe('Dialog — open/close', () => {
  it('1 — renders nothing while closed', () => {
    renderDialog(
      <Dialog open={false} onClose={() => {}} title="Eintrag">
        {FIELDS}
      </Dialog>
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('2 — open: a modal dialog labelled by its title', () => {
    renderDialog(
      <Dialog open onClose={() => {}} title="Eintrag nachtragen">
        {FIELDS}
      </Dialog>
    )
    const dialog = screen.getByRole('dialog', { name: 'Eintrag nachtragen' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
  })

  it('3 — Escape closes', async () => {
    const onClose = vi.fn()
    renderDialog(
      <Dialog open onClose={onClose} title="Eintrag">
        {FIELDS}
      </Dialog>
    )
    await flushFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('4 — after closing, Escape no longer reaches the handler', async () => {
    const onClose = vi.fn()
    const { rerender } = renderDialog(
      <Dialog open onClose={onClose} title="Eintrag">
        {FIELDS}
      </Dialog>
    )
    await flushFocus()
    rerender(
      <I18nProvider>
        <Dialog open={false} onClose={onClose} title="Eintrag">
          {FIELDS}
        </Dialog>
      </I18nProvider>
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('5 — a click on the backdrop closes, a click inside the panel does not', async () => {
    const onClose = vi.fn()
    renderDialog(
      <Dialog open onClose={onClose} title="Eintrag">
        {FIELDS}
      </Dialog>
    )
    await flushFocus()

    // The overlay IS the role=dialog element; clicking a child bubbles up to
    // it with target ≠ currentTarget and must not close.
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.pointerDown(screen.getByRole('dialog'))
    fireEvent.pointerUp(screen.getByRole('dialog'))
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('5b — a press that starts in the panel and ends on the backdrop does not close', async () => {
    const onClose = vi.fn()
    renderDialog(
      <Dialog open onClose={onClose} title="Eintrag">
        {FIELDS}
      </Dialog>
    )
    await flushFocus()

    // A text selection dragged out of the field: the browser fires the click
    // on the common ancestor, the backdrop.
    fireEvent.pointerDown(screen.getByRole('textbox', { name: 'Feld eins' }))
    fireEvent.pointerUp(screen.getByRole('dialog'))
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('5c — a press that starts on the backdrop and ends in the panel does not close', async () => {
    const onClose = vi.fn()
    renderDialog(
      <Dialog open onClose={onClose} title="Eintrag">
        {FIELDS}
      </Dialog>
    )
    await flushFocus()

    fireEvent.pointerDown(screen.getByRole('dialog'))
    fireEvent.pointerUp(screen.getByRole('textbox', { name: 'Feld eins' }))
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('Dialog — focus management', () => {
  it('6 — initial focus goes to the first form control, not the earlier close button', async () => {
    renderDialog(
      <Dialog open onClose={() => {}} title="Eintrag">
        {FIELDS}
      </Dialog>
    )
    await flushFocus()
    expect(document.activeElement).toBe(screen.getByLabelText('Feld eins'))
  })

  it('7 — without any form control, focus falls back to the first button (×)', async () => {
    renderDialog(
      <Dialog open onClose={() => {}} title="Hinweis">
        <p>Nur Text.</p>
      </Dialog>
    )
    await flushFocus()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Schließen' }))
  })

  it('8 — closing returns focus to the previously focused element', async () => {
    function Host(): React.JSX.Element {
      const [open, setOpen] = useState(false)
      return (
        <I18nProvider>
          <button type="button" onClick={() => setOpen(true)}>
            Öffnen
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Eintrag">
            {FIELDS}
          </Dialog>
        </I18nProvider>
      )
    }
    render(<Host />)
    const opener = screen.getByRole('button', { name: 'Öffnen' })
    opener.focus()
    fireEvent.click(opener)
    await flushFocus()
    expect(document.activeElement).toBe(screen.getByLabelText('Feld eins'))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  // Owner review PR 5b: a child with autoFocus focuses itself before the
  // shell reads the opener — the dialog then "returned" focus to its own,
  // removed field. The forms no longer use autoFocus; the shell's initial
  // focus picks the same first field.
  it('8b — with an autoFocus child the opener is lost; without, it comes back', async () => {
    function Host({ auto }: { auto: boolean }): React.JSX.Element {
      const [open, setOpen] = useState(false)
      return (
        <I18nProvider>
          <button type="button" onClick={() => setOpen(true)}>
            Öffnen
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Kunde">
            <input aria-label="Name" autoFocus={auto} />
          </Dialog>
        </I18nProvider>
      )
    }
    for (const auto of [true, false]) {
      const { unmount } = render(<Host auto={auto} />)
      const opener = screen.getByRole('button', { name: 'Öffnen' })
      opener.focus()
      fireEvent.click(opener)
      await flushFocus()
      expect(document.activeElement).toBe(screen.getByLabelText('Name'))
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(document.activeElement === opener).toBe(!auto)
      unmount()
    }
  })

  it('8c — an opener that is gone sends focus to the main area, also when it goes later', async () => {
    function Host({ keepOpener }: { keepOpener: boolean }): React.JSX.Element {
      const [open, setOpen] = useState(false)
      return (
        <I18nProvider>
          <main tabIndex={-1}>
            {keepOpener && (
              <button type="button" onClick={() => setOpen(true)}>
                Löschen
              </button>
            )}
          </main>
          <Dialog open={open} onClose={() => setOpen(false)} title="Löschen?">
            <button type="button">Ok</button>
          </Dialog>
        </I18nProvider>
      )
    }
    // Gone before the dialog closes.
    const first = render(<Host keepOpener />)
    const opener = screen.getByRole('button', { name: 'Löschen' })
    opener.focus()
    fireEvent.click(opener)
    await flushFocus()
    first.rerender(<Host keepOpener={false} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByRole('main'))
    first.unmount()

    // Gone after the dialog closed — the row of a deleted entry leaves only
    // once the IPC round trip is done.
    const second = render(<Host keepOpener />)
    const again = screen.getByRole('button', { name: 'Löschen' })
    again.focus()
    fireEvent.click(again)
    await flushFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.activeElement).toBe(again)
    second.rerender(<Host keepOpener={false} />)
    await act(async () => {})
    expect(document.activeElement).toBe(screen.getByRole('main'))
  })

  it('8d — a dialog closing under another one leaves focus in the top one', async () => {
    function Host(): React.JSX.Element {
      const [lower, setLower] = useState(false)
      const [upper, setUpper] = useState(false)
      return (
        <I18nProvider>
          <button type="button" onClick={() => setLower(true)}>
            Öffnen
          </button>
          <Dialog open={lower} onClose={() => setLower(false)} title="Notiz">
            <button type="button" onClick={() => setUpper(true)}>
              Weiter
            </button>
            <button type="button" onClick={() => setLower(false)}>
              Unten schließen
            </button>
          </Dialog>
          <Dialog open={upper} onClose={() => setUpper(false)} title="Leerlauf" closeButton={false}>
            <button type="button">Behalten</button>
          </Dialog>
        </I18nProvider>
      )
    }
    render(<Host />)
    const opener = screen.getByRole('button', { name: 'Öffnen' })
    opener.focus()
    fireEvent.click(opener)
    await flushFocus()
    const weiter = screen.getByRole('button', { name: 'Weiter' })
    weiter.focus()
    fireEvent.click(weiter)
    await flushFocus()
    const keep = screen.getByRole('button', { name: 'Behalten' })
    expect(document.activeElement).toBe(keep)
    // The lower dialog closes on its own (a timeout) while the upper is open.
    fireEvent.click(screen.getByRole('button', { name: 'Unten schließen' }))
    expect(document.activeElement).toBe(keep)
    // Closing the upper one now returns focus to where the lower one came from.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.activeElement).toBe(opener)
  })

  it('9 — a parent re-render with a fresh onClose neither steals focus back …', async () => {
    const { rerender } = renderDialog(
      <Dialog open onClose={() => {}} title="Eintrag">
        {FIELDS}
      </Dialog>
    )
    await flushFocus()
    const second = screen.getByLabelText('Feld zwei')
    act(() => second.focus())

    // New function identity on every parent render — the ticking-pill case.
    rerender(
      <I18nProvider>
        <Dialog open onClose={() => {}} title="Eintrag">
          {FIELDS}
        </Dialog>
      </I18nProvider>
    )
    await flushFocus()
    expect(document.activeElement).toBe(second)
  })

  it('10 — … and Escape still calls the LATEST onClose', async () => {
    const first = vi.fn()
    const latest = vi.fn()
    const { rerender } = renderDialog(
      <Dialog open onClose={first} title="Eintrag">
        {FIELDS}
      </Dialog>
    )
    await flushFocus()
    rerender(
      <I18nProvider>
        <Dialog open onClose={latest} title="Eintrag">
          {FIELDS}
        </Dialog>
      </I18nProvider>
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledTimes(1)
  })
})

describe('Dialog — focus trap and stacking (PR 5)', () => {
  it('11 — Tab from the last control wraps to the first, Shift+Tab from the first to the last', async () => {
    renderDialog(
      <Dialog open onClose={() => {}} title="Eintrag">
        {FIELDS}
      </Dialog>
    )
    await flushFocus()
    const close = screen.getByRole('button', { name: 'Schließen' })
    const save = screen.getByRole('button', { name: 'Speichern' })
    act(() => save.focus())
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(save)
  })

  it('12 — focus that escaped the dialog is pulled back in on Tab', async () => {
    render(
      <I18nProvider>
        <button type="button">Draußen</button>
        <Dialog open onClose={() => {}} title="Eintrag">
          {FIELDS}
        </Dialog>
      </I18nProvider>
    )
    await flushFocus()
    act(() => screen.getByRole('button', { name: 'Draußen' }).focus())
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Schließen' }))
  })

  it('13 — with two dialogs open, Escape closes only the top one', async () => {
    const outer = vi.fn()
    const inner = vi.fn()
    const { rerender } = renderDialog(
      <Dialog open onClose={outer} title="Außen">
        {FIELDS}
      </Dialog>
    )
    await flushFocus()
    rerender(
      <I18nProvider>
        <Dialog open onClose={outer} title="Außen">
          {FIELDS}
        </Dialog>
        <Dialog open onClose={inner} title="Innen">
          <button type="button">Ok</button>
        </Dialog>
      </I18nProvider>
    )
    await flushFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
  })

  it('13b — the dialog opened last is painted on top, even earlier in the DOM', async () => {
    const { rerender } = renderDialog(
      <>
        <Dialog open={false} onClose={() => {}} title="Leerlauf">
          <button type="button">Ok</button>
        </Dialog>
        <Dialog open onClose={() => {}} title="Timer starten">
          {FIELDS}
        </Dialog>
      </>
    )
    await flushFocus()
    rerender(
      <I18nProvider>
        <Dialog open onClose={() => {}} title="Leerlauf">
          <button type="button">Ok</button>
        </Dialog>
        <Dialog open onClose={() => {}} title="Timer starten">
          {FIELDS}
        </Dialog>
      </I18nProvider>
    )
    await flushFocus()
    const z = (name: string): number => Number(screen.getByRole('dialog', { name }).style.zIndex)
    expect(z('Leerlauf')).toBeGreaterThan(z('Timer starten'))
  })

  it('13c — a <summary> counts as the last control of the trap', async () => {
    renderDialog(
      <Dialog open onClose={() => {}} title="Import">
        <button type="button">Laden</button>
        <details>
          <summary>Übersprungen</summary>
          <p>Grund</p>
        </details>
      </Dialog>
    )
    await flushFocus()
    act(() => screen.getByRole('button', { name: 'Laden' }).focus())
    fireEvent.keyDown(window, { key: 'Tab' })
    // Laden is not the last control: the trap must let Tab move on to the
    // summary instead of wrapping back to ×.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Laden' }))
  })

  it('14 — the title row carries the 2 px ink rule (HANDOFF §5)', () => {
    renderDialog(
      <Dialog open onClose={() => {}} title="Eintrag">
        {FIELDS}
      </Dialog>
    )
    const heading = screen.getByRole('heading', { name: 'Eintrag' })
    expect(heading.parentElement?.className).toContain('border-t-2')
    expect(heading.parentElement?.className).toContain('border-[var(--ink)]')
  })
})
