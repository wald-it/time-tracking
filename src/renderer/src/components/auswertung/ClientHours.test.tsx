import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ClientHours } from './ClientHours'
import { I18nProvider } from '../../contexts/I18nContext'
import { useSettingsStore } from '../../store/settingsStore'
import type { AnalyticsSummary, Settings } from '../../../../shared/types'

afterEach(() => {
  cleanup()
  useSettingsStore.setState({ settings: null })
})

const H = 3600
const clients: AnalyticsSummary['byClient'] = [
  { client_id: 1, name: 'Month client', color: '#111', h: H, b: H, rev: 10_000 }
]
const clientYear: NonNullable<AnalyticsSummary['byClientYear']> = {
  from: '2025-11-01',
  to: '2026-10-31',
  clients: [
    { client_id: 1, name: 'Main', color: '#111', h: 100 * H, b: 80 * H, rev: 840_000 },
    { client_id: 2, name: 'Goodwill', color: '#111', h: 20 * H, b: 20 * H, rev: 0 },
    { client_id: 3, name: 'Internal', color: '#111', h: 10 * H, b: 0, rev: 0 },
    { client_id: 4, name: 'Fourth', color: '#111', h: 5 * H, b: 5 * H, rev: 10_000 },
    { client_id: 5, name: 'Fifth', color: '#111', h: 4 * H, b: 3 * H, rev: 100_000 },
    { client_id: 6, name: 'Sixth', color: '#111', h: H, b: H, rev: 50_000 }
  ]
}
const tooltipDe =
  '5/6 des Umsatzes. Ein hoher Anteil eines Auftraggebers ist ein Merkmal, das die Rentenversicherung bei der Statusprüfung ansieht. Die Zahl ist keine Bewertung; im Einzelfall entscheidet die Beratung.'
const tooltipEn =
  '5/6 of revenue. A high share from one client is one criterion the German pension insurance looks at in a status review. The number is not an assessment; individual cases need professional advice.'

function setup(showRevenue = true, year = clientYear): void {
  render(
    <I18nProvider>
      <ClientHours clients={clients} clientYear={year} isCurrentMonth showRevenue={showRevenue} />
    </I18nProvider>
  )
}

function row(name: string): HTMLElement {
  return screen.getByText(name).closest('[data-client-row]') as HTMLElement
}

function switchToYear(): void {
  fireEvent.click(screen.getByRole('button', { name: '12 Monate' }))
}

describe('ClientHours — client year', () => {
  it('defaults to Month with the original rows, meta, bars and grid; switching back restores it', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Monat' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '12 Monate' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.getByText('laufender Monat · Umsatz rechts')).toBeTruthy()
    expect(within(row('Month client')).getByText('1:00')).toBeTruthy()
    expect(within(row('Month client')).getByText('100 €')).toBeTruthy()
    expect(screen.queryByText('Main')).toBeNull()
    expect(screen.queryByText('Effektiv')).toBeNull()
    expect(screen.queryByTestId('client-share-bar')).toBeNull()
    const grid = screen.getByTestId('client-ruler').parentElement!
    expect(grid.style.gridTemplateColumns).toBe('170px minmax(0, 1fr) 72px 88px')
    const monthGrid = grid.innerHTML
    switchToYear()
    fireEvent.click(screen.getByRole('button', { name: 'Monat' }))
    expect(grid.innerHTML).toBe(monthGrid)
  })

  it('shows the window and three computed columns with all clients in the revenue denominator', () => {
    setup()
    switchToYear()
    expect(screen.getByRole('button', { name: '12 Monate' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByText(/Nov\.? 2025 – Okt\.? 2026/)).toBeTruthy()
    for (const label of ['Effektiv', 'Nicht abrechenbar', 'Umsatzanteil']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    const main = within(row('Main'))
    for (const value of ['100:00', '8.400 €', '84 €/h', '20 %', '84 %']) {
      expect(main.getByText(value)).toBeTruthy()
    }
    expect(within(row('Goodwill')).getByText('—')).toBeTruthy()
    expect(within(row('Goodwill')).getByText('0 €/h')).toBeTruthy()
    expect(within(row('Internal')).getByText('intern')).toBeTruthy()
    expect(within(row('Internal')).getByText('100 %')).toBeTruthy()
    const other = within(row('Sonstige'))
    for (const value of ['5:00', '1.500 €', '300 €/h', '20 %', '15 %']) {
      expect(other.getByText(value)).toBeTruthy()
    }
    expect(screen.queryByText('Fifth')).toBeNull()
    expect(screen.queryByText('Sixth')).toBeNull()
    expect(screen.queryByText('Month client')).toBeNull()
  })

  it('marks each individual share bar neutrally, never Other, including above five sixths', () => {
    setup()
    switchToYear()
    expect(screen.getAllByTestId('client-share-bar')).toHaveLength(4)
    for (const name of ['Main', 'Goodwill', 'Internal', 'Fourth']) {
      const clientRow = row(name)
      const mark = within(clientRow).getByRole('img', { name: tooltipDe })
      expect(mark).toHaveAttribute('title', tooltipDe)
      expect(mark.style.left).toBe(`${(5 / 6) * 100}%`)
      expect(mark.className).toContain('bg-[var(--ink3)]')
      expect(clientRow.className).toBe('contents')
      expect(clientRow).not.toHaveAttribute('style')
      expect(clientRow.lastElementChild?.className).toBe(row('Main').lastElementChild?.className)
    }
    const mainBar = within(row('Main')).getByTestId('client-share-bar')
    expect((mainBar.firstElementChild as HTMLElement).style.width).toBe('84%')
    expect(mainBar.className).toBe(within(row('Fourth')).getByTestId('client-share-bar').className)
    expect(within(row('Sonstige')).queryByTestId('client-share-bar')).toBeNull()
    expect(within(row('Sonstige')).queryByRole('img')).toBeNull()
  })

  it('adds only the non-billable column when no rates are configured', () => {
    setup(false)
    switchToYear()
    expect(screen.getByText('Nicht abrechenbar')).toBeTruthy()
    expect(within(row('Main')).getByText('20 %')).toBeTruthy()
    expect(row('Main').children).toHaveLength(4)
    for (const label of ['Effektiv', 'Umsatzanteil', '€']) {
      expect(screen.queryByText(label)).toBeNull()
    }
    expect(screen.queryByText(/€\/h/)).toBeNull()
    expect(screen.queryAllByTestId('client-share-bar')).toHaveLength(0)
    expect(screen.queryByTitle(tooltipDe)).toBeNull()
    expect(screen.getByText(/Nov\.? 2025 – Okt\.? 2026/).textContent).not.toContain('Umsatz rechts')
  })

  it('shows undefined revenue shares without any bars or marks when total revenue is zero', () => {
    setup(true, {
      ...clientYear,
      clients: clientYear.clients.map((c) => ({ ...c, rev: 0 }))
    })
    switchToYear()
    expect(row('Main').lastElementChild?.textContent).toBe('—')
    expect(row('Sonstige').lastElementChild?.textContent).toBe('—')
    expect(screen.queryAllByTestId('client-share-bar')).toHaveLength(0)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('shows undefined rate and non-billable share for a row with no worked seconds', () => {
    setup(true, { ...clientYear, clients: [{ ...clientYear.clients[0], h: 0, b: 0, rev: 0 }] })
    switchToYear()
    expect(within(row('Main')).getAllByText('—')).toHaveLength(3)
  })

  it('localises the switch, window, column labels and exact tooltip in English', () => {
    useSettingsStore.setState({ settings: { language: 'en' } as Settings })
    setup()
    expect(screen.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '12 months' }))
    expect(screen.getByText(/Nov 2025 – Oct 2026/)).toBeTruthy()
    for (const label of ['Effective', 'Non-billable', 'Revenue share', 'Other']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(screen.getAllByRole('img', { name: tooltipEn })).toHaveLength(4)
    expect(screen.getAllByTitle(tooltipEn)).toHaveLength(4)
  })
})
