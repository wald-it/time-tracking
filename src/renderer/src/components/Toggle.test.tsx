/**
 * Toggle (Messinstrument PR 5, HANDOFF §5/§8): a real button with
 * role="switch", so it is reachable and operable by keyboard. Until PR 5 it
 * was a `div role="switch"` with a click handler only — no tab stop, no keys.
 *
 * Keyboard operation is the browser's job for a native `<button>`: Space and
 * Enter dispatch `click`. jsdom does not emulate that activation (and the repo
 * has no user-event), so the keyboard contract is pinned through what makes
 * it true: a focusable native `type="button"` whose `click` toggles.
 */
import { useState } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { Toggle } from './Toggle'
import { ToggleHintContext, ToggleLabelContext } from './toggleLabelContext'

afterEach(cleanup)

function Host({ disabled = false }: { disabled?: boolean }): React.JSX.Element {
  const [on, setOn] = useState(false)
  return (
    <>
      <span id="row-label">Autostart</span>
      <Toggle checked={on} onChange={setOn} disabled={disabled} labelledBy="row-label" />
    </>
  )
}

describe('Toggle', () => {
  it('is a native button with role switch, named by the row label', () => {
    render(<Host />)
    const toggle = screen.getByRole('switch', { name: 'Autostart' })
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle.getAttribute('type')).toBe('button')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('is a tab stop and takes keyboard focus', () => {
    render(<Host />)
    const toggle = screen.getByRole('switch')
    expect(toggle.tabIndex).toBe(0)
    toggle.focus()
    expect(document.activeElement).toBe(toggle)
  })

  it('activation (click — what Space/Enter dispatch on a button) flips aria-checked', () => {
    render(<Host />)
    const toggle = screen.getByRole('switch')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('calls onChange with the inverted value', () => {
    const onChange = vi.fn()
    render(<Toggle checked onChange={onChange} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('disabled: a disabled button, activation does nothing', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} disabled />)
    const toggle = screen.getByRole('switch') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    fireEvent.click(toggle)
    expect(onChange).not.toHaveBeenCalled()
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })
})

describe('Toggle — accessible name', () => {
  it('is named by the label of the settings row it sits in', () => {
    render(
      <ToggleLabelContext.Provider value="row-label">
        <span id="row-label">Autostart</span>
        <Toggle checked={false} onChange={() => {}} />
      </ToggleLabelContext.Provider>
    )
    expect(screen.getByRole('switch', { name: 'Autostart' })).toBeTruthy()
  })

  it('an explicit labelledBy wins over the row label', () => {
    render(
      <ToggleLabelContext.Provider value="row-label">
        <span id="row-label">Webhooks</span>
        <span id="own">Aktiv</span>
        <Toggle checked={false} onChange={() => {}} labelledBy="own" />
      </ToggleLabelContext.Provider>
    )
    expect(screen.getByRole('switch', { name: 'Aktiv' })).toBeTruthy()
  })

  it('is described by the hint of its settings row', () => {
    render(
      <ToggleLabelContext.Provider value="row-label">
        <ToggleHintContext.Provider value="row-hint">
          <span id="row-label">Autostart</span>
          <span id="row-hint">Startet mit Windows</span>
          <Toggle checked={false} onChange={() => {}} />
        </ToggleHintContext.Provider>
      </ToggleLabelContext.Provider>
    )
    expect(screen.getByRole('switch').getAttribute('aria-describedby')).toBe('row-hint')
  })
})
