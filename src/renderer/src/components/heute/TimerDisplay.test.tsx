// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TimerDisplay } from './TimerDisplay'
import { I18nProvider } from '../../contexts/I18nContext'
import type { Entry } from '../../../../shared/types'

const T0 = Date.UTC(2026, 9, 21, 9, 0, 0)

function running(over: Partial<Entry>): Entry {
  return {
    id: 1,
    client_id: 1,
    description: '',
    started_at: new Date(T0).toISOString(),
    stopped_at: null,
    heartbeat_at: null,
    rounded_min: null,
    deleted_at: null,
    created_at: new Date(T0).toISOString(),
    link_id: null,
    tags: '',
    reference: '',
    billable: 1,
    private_note: '',
    project_id: null,
    ...over
  }
}

function show(entry: Entry, nowMs: number): void {
  render(
    <I18nProvider>
      <TimerDisplay runningEntry={entry} nowMs={nowMs} hotkey="" />
    </I18nProvider>
  )
}

describe('TimerDisplay rounding label', () => {
  it('names the step of the row when it has an interval and no minimum unit', () => {
    show(running({ interval_min: 15, min_unit_min: 0 }), T0 + 16 * 60000)
    expect(screen.getByText('Takt 15 min · gerundet 0:30 h')).toBeTruthy()
  })

  it('names no step for a minimum unit and ignores the global setting', () => {
    show(running({ interval_min: 0, min_unit_min: 15 }), T0 + 3 * 60000)
    expect(screen.getByText('gerundet 0:15 h')).toBeTruthy()
  })
})
