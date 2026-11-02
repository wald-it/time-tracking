import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DayScale } from './DayScale'
import { I18nProvider } from '../../contexts/I18nContext'
import { useSettingsStore } from '../../store/settingsStore'
import type { Entry, Settings } from '../../../../shared/types'
import type { Gap } from '../../../../shared/gaps'

const local = (hour: number, minute = 0): number => new Date(2026, 7, 10, hour, minute).getTime()
const entry = {
  id: 1,
  client_id: 1,
  started_at: new Date(local(9)).toISOString(),
  stopped_at: new Date(local(10)).toISOString()
} as Entry
const gap = { startMs: local(10), endMs: local(12) }

afterEach(() => {
  cleanup()
  useSettingsStore.setState({ settings: null })
})

function mount(
  gaps: Gap[],
  entries: Entry[] = [entry]
): { onGap: ReturnType<typeof vi.fn>; onSelect: ReturnType<typeof vi.fn> } {
  const onGap = vi.fn()
  const onSelect = vi.fn()
  render(
    <I18nProvider>
      <DayScale
        entries={entries}
        clientsById={new Map()}
        projectsById={new Map()}
        nowMs={local(12)}
        gaps={gaps}
        onGap={onGap}
        onSelect={onSelect}
      />
    </I18nProvider>
  )
  return { onGap, onSelect }
}

describe('DayScale gap buttons', () => {
  it.each([
    ['de', 'Lücke 10:00–12:00 · ungeklärt 2:00 · nachtragen'],
    ['en', 'Gap 10:00–12:00 · unexplained 2:00 · add entry']
  ])('labels the button in %s and passes the original gap on click', (language, label) => {
    useSettingsStore.setState({ settings: { language } as Settings })
    const { onGap, onSelect } = mount([gap])
    const button = screen.getByRole('button', { name: label })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveAttribute('title', label)
    expect(button).toHaveStyle({ top: '22px', height: '40px', background: 'transparent' })
    expect(button.style.border).toBe('1px solid var(--tick)')
    expect(button.style.left).toBe('23.077%')
    expect(button.style.width).toBe('15.385%')
    fireEvent.click(button)
    expect(onGap).toHaveBeenCalledExactlyOnceWith(gap)
    expect(onGap.mock.calls[0][0]).toBe(gap)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('leaves entry bars and their click action unchanged without gaps', () => {
    const { onSelect, onGap } = mount([])
    const button = screen.getByRole('button', { name: '09:00–10:00 · —' })
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(button.style.left).toBe('15.385%')
    expect(button.style.width).toBe('7.692%')
    expect(button.style.background).toBe('var(--tick)')
    fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(entry)
    expect(onGap).not.toHaveBeenCalled()
  })

  it('keeps running entry hatching and the same hover/focus treatment', () => {
    mount([gap], [{ ...entry, stopped_at: null }])
    const running = screen.getByRole('button', { name: '09:00– · — · läuft' })
    expect(running.style.background).toContain('repeating-linear-gradient')
    expect(screen.getByRole('button', { name: /^Lücke/ }).className).toBe(running.className)
  })

  it('clips to the drawn range and omits gaps wholly outside it', () => {
    mount(
      [
        { startMs: local(6), endMs: local(8) },
        { startMs: local(19), endMs: local(21) },
        { startMs: local(5), endMs: local(6) },
        { startMs: local(21), endMs: local(22) }
      ],
      []
    )
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].style.left).toBe('0%')
    expect(buttons[0].style.width).toBe('7.692%')
    expect(buttons[1].style.left).toBe('92.308%')
    expect(buttons[1].style.width).toBe('7.692%')
  })

  it('gives a short gap a minimum hit width without shifting its start', () => {
    mount([{ startMs: local(10), endMs: local(10, 1) }], [])
    const button = screen.getByRole('button')
    expect(button.style.left).toBe('23.077%')
    expect(button.style.minWidth).toBe('min(4px, 76.923%)')
  })
})
