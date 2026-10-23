/**
 * A switch outside a settings Row gets no name from ToggleLabelContext, so it
 * must pass `labelledBy` itself — otherwise a screen reader announces a bare
 * "switch". Pinned on two such places: the iCal feed section (rendered
 * directly in a settings Section) and the billable switch of the edit form.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { IcalFeedSection } from './IcalFeedSection'
import { EntryEditForm } from './EntryEditForm'
import { I18nProvider } from '../contexts/I18nContext'

afterEach(cleanup)

describe('switches outside a settings row carry a name', () => {
  it('iCal feed', () => {
    render(
      <I18nProvider>
        <IcalFeedSection
          enabled={false}
          port=""
          onEnabledChange={() => {}}
          onPortChange={() => {}}
        />
      </I18nProvider>
    )
    const sw = screen.getByRole('switch')
    expect(sw.getAttribute('aria-labelledby')).toBeTruthy()
    expect(screen.getByRole('switch', { name: /iCal|Feed/i })).toBe(sw)
  })

  it('billable in the entry edit form', () => {
    ;(window as unknown as { api: unknown }).api = {
      projects: { getAll: async () => ({ ok: true as const, data: [] }) },
      // TagInput loads its suggestions on mount; without this the rejection
      // lands after the test and fails the run as an unhandled error (macOS CI).
      tags: { getAllWithCount: async () => ({ ok: true as const, data: [] }) }
    }
    render(
      <I18nProvider>
        <EntryEditForm clients={[]} onSaved={() => {}} onCancel={() => {}} />
      </I18nProvider>
    )
    expect(screen.getByRole('switch', { name: /abrechenbar/i })).toBeTruthy()
  })
})
