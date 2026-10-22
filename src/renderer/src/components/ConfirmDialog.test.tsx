/**
 * ConfirmDialog on the shared Dialog shell (Messinstrument PR 5): an
 * alertdialog with the message as description, default focus on Cancel,
 * Escape = cancel, Tab trapped inside, focus back to the trigger.
 */
import { useState } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { ConfirmDialog } from './ConfirmDialog'
import { I18nProvider } from '../contexts/I18nContext'

afterEach(cleanup)

async function flushFocus(): Promise<void> {
  await act(async () => {})
}

function Host({ onConfirm = () => {} }: { onConfirm?: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <I18nProvider>
      <button type="button" onClick={() => setOpen(true)}>
        Löschen …
      </button>
      <ConfirmDialog
        open={open}
        title="Eintrag löschen?"
        message="Das lässt sich nicht rückgängig machen."
        confirmLabel="Löschen"
        cancelLabel="Abbrechen"
        variant="danger"
        onConfirm={onConfirm}
        onCancel={() => setOpen(false)}
      />
    </I18nProvider>
  )
}

async function openIt(): Promise<HTMLElement> {
  const trigger = screen.getByRole('button', { name: 'Löschen …' })
  trigger.focus()
  fireEvent.click(trigger)
  await flushFocus()
  return trigger
}

describe('ConfirmDialog', () => {
  it('is a modal alertdialog, named by the title, described by the message', async () => {
    render(<Host />)
    await openIt()
    const dialog = screen.getByRole('alertdialog', { name: 'Eintrag löschen?' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const describedBy = dialog.getAttribute('aria-describedby')
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBe(
      'Das lässt sich nicht rückgängig machen.'
    )
  })

  it('initial focus is on Cancel, never on the destructive key', async () => {
    render(<Host />)
    await openIt()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Abbrechen' }))
  })

  it('Escape cancels and focus returns to the trigger', async () => {
    const onConfirm = vi.fn()
    render(<Host onConfirm={onConfirm} />)
    const trigger = await openIt()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
  })

  it('Tab stays inside: from the last key to the first and back', async () => {
    render(<Host />)
    await openIt()
    const cancel = screen.getByRole('button', { name: 'Abbrechen' })
    const confirm = screen.getByRole('button', { name: 'Löschen' })
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirm)
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)
  })

  it('a click on the backdrop does not cancel', async () => {
    render(<Host />)
    await openIt()
    fireEvent.click(screen.getByRole('alertdialog'))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
  })
})
