/**
 * The calendar drawer shares the Dialog shell's focus handling (owner review
 * PR 5b): Tab stays inside the drawer instead of running into the covered
 * page, and focus goes back to the day that opened it.
 */
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { CalendarDrawer } from './CalendarDrawer'
import { I18nProvider } from '../contexts/I18nContext'

afterEach(cleanup)

function Host(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <I18nProvider>
      <button type="button" onClick={() => setOpen(true)}>
        22.10.
      </button>
      <button type="button">Seite dahinter</button>
      <CalendarDrawer
        open={open}
        dateISO="2026-10-22"
        entries={[]}
        clients={[]}
        projects={[]}
        onClose={() => setOpen(false)}
      />
    </I18nProvider>
  )
}

describe('CalendarDrawer — focus', () => {
  it('Tab pulls focus back into the drawer; closing returns focus to the day', async () => {
    render(<Host />)
    const day = screen.getByRole('button', { name: '22.10.' })
    day.focus()
    fireEvent.click(day)
    await act(async () => {})
    const drawer = screen.getByRole('dialog')
    const inside = Array.from(drawer.querySelectorAll<HTMLElement>('button:not([disabled])'))
    expect(document.activeElement).toBe(inside[0])

    // jsdom does not move focus on Tab by itself, so what is pinned is the
    // trap's own move: focus on the covered page is pulled back in.
    act(() => screen.getByRole('button', { name: 'Seite dahinter' }).focus())
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(inside[0])
    act(() => screen.getByRole('button', { name: 'Seite dahinter' }).focus())
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(inside[inside.length - 1])

    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(day)
  })
})
