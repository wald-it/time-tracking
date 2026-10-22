import { describe, expect, it } from 'vitest'
import { formatCsv } from './csv'
import type { Entry, Client } from './types'

const BASE_CLIENT: Client = {
  id: 1,
  name: 'Acme GmbH',
  color: '#4f46e5',
  active: 1,
  rate_cent: 7500, // 75,00 €/h
  created_at: '2024-01-01T00:00:00.000Z'
}

const CLIENT_MAP = new Map([[1, BASE_CLIENT]])

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 1,
    client_id: 1,
    description: 'Meeting',
    started_at: '2026-04-25T09:00:00.000Z',
    stopped_at: '2026-04-25T10:30:00.000Z',
    heartbeat_at: null,
    rounded_min: null,
    deleted_at: null,
    created_at: '2026-04-25T09:00:00.000Z',
    link_id: null,
    tags: '',
    reference: '',
    billable: 1,
    private_note: '',
    ...overrides
  }
}

describe('formatCsv', () => {
  it('produces UTF-8 BOM', () => {
    const csv = formatCsv([], CLIENT_MAP)
    expect(csv.startsWith('﻿')).toBe(true)
  })

  it('produces CRLF line endings', () => {
    const csv = formatCsv([], CLIENT_MAP)
    expect(csv).toContain('\r\n')
    expect(csv).not.toMatch(/(?<!\r)\n/)
  })

  it('outputs header row', () => {
    const csv = formatCsv([], CLIENT_MAP)
    expect(csv).toContain(
      'Datum;Start;Ende;Dauer;Kunde;Beschreibung;Tags;Referenz;Stundensatz;Betrag'
    )
  })

  it('empty list → header only', () => {
    const csv = formatCsv([], CLIENT_MAP)
    const lines = csv.replace('﻿', '').split('\r\n').filter(Boolean)
    expect(lines).toHaveLength(1) // just the header
  })

  it('skips running entries (stopped_at = null)', () => {
    const running = makeEntry({ stopped_at: null })
    const csv = formatCsv([running], CLIENT_MAP)
    const lines = csv.replace('﻿', '').split('\r\n').filter(Boolean)
    expect(lines).toHaveLength(1) // only header
  })

  it('DE format defaults: semicolon sep + comma decimal', () => {
    const entry = makeEntry()
    const csv = formatCsv([entry], CLIENT_MAP)
    // Rate 75.00 → "75,00", all fields semicolon-separated
    expect(csv).toContain(';75,00;')
  })

  it('US format: comma sep + dot decimal', () => {
    const entry = makeEntry()
    const csv = formatCsv([entry], CLIENT_MAP, { fieldSeparator: ',', decimalSeparator: '.' })
    expect(csv).toContain(',75.00,')
  })

  it('calculates Betrag correctly (1.5h × 75 €/h = 112.50)', () => {
    // 09:00 → 10:30 = 5400s = 1.5h × 7500 cent = 11250 cent = 112.50 €
    const entry = makeEntry()
    const csv = formatCsv([entry], CLIENT_MAP)
    expect(csv).toContain('112,50')
  })

  it('leaves Stundensatz + Betrag empty when no rate', () => {
    const noRateClient: Client = { ...BASE_CLIENT, rate_cent: 0 }
    const map = new Map([[1, noRateClient]])
    const csv = formatCsv([makeEntry()], map)
    // last two fields should be empty → line ends with ";;..." trailing sep
    const dataLine = csv.replace('﻿', '').split('\r\n')[1]
    expect(dataLine).toMatch(/;;$/)
  })

  it('renders tags pipe-separated', () => {
    const entry = makeEntry({ tags: ',bug,ux,' })
    const csv = formatCsv([entry], CLIENT_MAP)
    expect(csv).toContain('bug|ux')
  })

  it('empty tags → empty tags field', () => {
    const entry = makeEntry({ tags: '' })
    const csv = formatCsv([entry], CLIENT_MAP)
    // tags column is index 6: Datum(0) Start(1) Ende(2) Dauer(3) Kunde(4) Beschreibung(5) Tags(6)
    const dataLine = csv.replace('﻿', '').split('\r\n')[1]
    const fields = dataLine.split(';')
    expect(fields[6]).toBe('') // tags
  })

  it('reference field appears as Referenz column (index 7)', () => {
    const entry = makeEntry({ reference: 'JIRA-123' })
    const csv = formatCsv([entry], CLIENT_MAP)
    const dataLine = csv.replace('﻿', '').split('\r\n')[1]
    const fields = dataLine.split(';')
    expect(fields[7]).toBe('JIRA-123')
  })

  it('empty reference → empty Referenz column', () => {
    const entry = makeEntry({ reference: '' })
    const csv = formatCsv([entry], CLIENT_MAP)
    const dataLine = csv.replace('﻿', '').split('\r\n')[1]
    const fields = dataLine.split(';')
    expect(fields[7]).toBe('')
  })

  it('reference containing separator is quoted', () => {
    const entry = makeEntry({ reference: 'PROJ; TICKET-42' })
    const csv = formatCsv([entry], CLIENT_MAP)
    expect(csv).toContain('"PROJ; TICKET-42"')
  })

  it('escapes fields containing the separator', () => {
    const entry = makeEntry({ description: 'Projekt; Detail' })
    const csv = formatCsv([entry], CLIENT_MAP)
    expect(csv).toContain('"Projekt; Detail"')
  })

  it('escapes fields containing double quotes', () => {
    const entry = makeEntry({ description: 'Er sagte "Hallo"' })
    const csv = formatCsv([entry], CLIENT_MAP)
    expect(csv).toContain('"Er sagte ""Hallo"""')
  })

  it('escapes fields containing newlines', () => {
    const entry = makeEntry({ description: 'Zeile1\nZeile2' })
    const csv = formatCsv([entry], CLIENT_MAP)
    expect(csv).toContain('"Zeile1\nZeile2"')
  })

  it('handles unknown client_id gracefully (empty client name)', () => {
    const entry = makeEntry({ client_id: 999 })
    const csv = formatCsv([entry], CLIENT_MAP)
    // client name field (index 4) should be empty string
    const dataLine = csv.replace('﻿', '').split('\r\n')[1]
    const fields = dataLine.split(';')
    expect(fields[4]).toBe('') // no client → empty
  })

  it('midnight-split: two separate entries → two data rows', () => {
    const linkId = 'abc-123'
    const first = makeEntry({
      id: 1,
      started_at: '2026-04-24T23:00:00.000Z',
      stopped_at: '2026-04-24T23:59:59.000Z',
      link_id: linkId
    })
    const second = makeEntry({
      id: 2,
      started_at: '2026-04-25T00:00:00.000Z',
      stopped_at: '2026-04-25T01:00:00.000Z',
      link_id: linkId
    })
    const csv = formatCsv([first, second], CLIENT_MAP)
    const lines = csv.replace('﻿', '').split('\r\n').filter(Boolean)
    expect(lines).toHaveLength(3) // header + 2 data rows
  })
  it('skips non-billable entries (billable = 0)', () => {
    const nonBillable = makeEntry({ billable: 0 })
    const csv = formatCsv([nonBillable], CLIENT_MAP)
    const lines = csv.replace('\uFEFF', '').split('\r\n').filter(Boolean)
    expect(lines).toHaveLength(1) // header only
  })

  it('includes billable entries (billable = 1)', () => {
    const billable = makeEntry({ billable: 1 })
    const csv = formatCsv([billable], CLIENT_MAP)
    const lines = csv.replace('\uFEFF', '').split('\r\n').filter(Boolean)
    expect(lines).toHaveLength(2) // header + 1 data row
  })

  it('mixed billable + non-billable: only billable rows exported', () => {
    const b = makeEntry({ id: 1, billable: 1 })
    const nb = makeEntry({ id: 2, billable: 0 })
    const csv = formatCsv([b, nb], CLIENT_MAP)
    const lines = csv.replace('\uFEFF', '').split('\r\n').filter(Boolean)
    expect(lines).toHaveLength(2) // header + 1
  })

  describe('groupByTag', () => {
    it('flat output when no entries have tags (groupByTag ignored)', () => {
      const e1 = makeEntry({ id: 1, tags: '' })
      const e2 = makeEntry({ id: 2, tags: '' })
      const csv = formatCsv([e1, e2], CLIENT_MAP, { groupByTag: true })
      const lines = csv.replace('\uFEFF', '').split('\r\n').filter(Boolean)
      // No tagged entries → falls back to flat: header + 2 data rows
      expect(lines).toHaveLength(3)
    })

    it('groups entries by first tag alphabetically', () => {
      const eDesign = makeEntry({ id: 1, tags: ',Design,', description: 'UI' })
      const eDev = makeEntry({ id: 2, tags: ',Dev,', description: 'Backend' })
      const csv = formatCsv([eDev, eDesign], CLIENT_MAP, { groupByTag: true })
      const lines = csv.replace('\uFEFF', '').split('\r\n').filter(Boolean)
      // header + [Design] header + 1 data + Design Σ + [Dev] header + 1 data + Dev Σ + Σ Gesamt
      expect(lines).toHaveLength(8)
      // Design group should appear before Dev alphabetically
      const beschreibungCol = 5
      const designHeaderLine = lines.find((l) => l.split(';')[beschreibungCol] === '[Design]')
      const devHeaderLine = lines.find((l) => l.split(';')[beschreibungCol] === '[Dev]')
      expect(designHeaderLine).toBeDefined()
      expect(devHeaderLine).toBeDefined()
      expect(lines.indexOf(designHeaderLine!)).toBeLessThan(lines.indexOf(devHeaderLine!))
    })

    it('subtotal row has correct duration for a group', () => {
      // entry: 09:00 → 10:30 = 5400s = 01:30:00
      const entry = makeEntry({ tags: ',Development,' })
      const csv = formatCsv([entry], CLIENT_MAP, { groupByTag: true })
      const lines = csv.replace('\uFEFF', '').split('\r\n').filter(Boolean)
      const subtotalLine = lines.find((l) => l.includes('Development Σ'))
      expect(subtotalLine).toBeDefined()
      const fields = subtotalLine!.split(';')
      expect(fields[3]).toBe('01:30:00') // Dauer column
    })

    it('subtotal row has correct Betrag (1.5h × 75€/h = 112,50)', () => {
      const entry = makeEntry({ tags: ',Dev,' })
      const csv = formatCsv([entry], CLIENT_MAP, { groupByTag: true })
      const subtotalLine = csv
        .replace('\uFEFF', '')
        .split('\r\n')
        .find((l) => l.includes('Dev Σ'))
      expect(subtotalLine).toBeDefined()
      const fields = subtotalLine!.split(';')
      expect(fields[9]).toBe('112,50') // Betrag column
    })

    it('entries with no tag go into Ohne Tag group (shown last)', () => {
      const withTag = makeEntry({ id: 1, tags: ',alpha,', description: 'Tagged' })
      const noTag = makeEntry({ id: 2, tags: '', description: 'Untagged' })
      const csv = formatCsv([withTag, noTag], CLIENT_MAP, { groupByTag: true })
      const lines = csv.replace('\uFEFF', '').split('\r\n').filter(Boolean)
      const alphaIdx = lines.findIndex((l) => l.split(';')[5] === '[alpha]')
      const ohneTagIdx = lines.findIndex((l) => l.split(';')[5] === '[Ohne Tag]')
      expect(alphaIdx).toBeGreaterThan(-1)
      expect(ohneTagIdx).toBeGreaterThan(-1)
      expect(alphaIdx).toBeLessThan(ohneTagIdx) // named tags before Ohne Tag
    })

    it('grand total row at end has combined Dauer + Betrag', () => {
      // Two entries of 1.5h each → 3h total, 2 × 112,50 = 225,00
      const e1 = makeEntry({ id: 1, tags: ',A,' })
      const e2 = makeEntry({ id: 2, tags: ',B,' })
      const csv = formatCsv([e1, e2], CLIENT_MAP, { groupByTag: true })
      const lines = csv.replace('\uFEFF', '').split('\r\n').filter(Boolean)
      const totalLine = lines[lines.length - 1]
      const fields = totalLine.split(';')
      expect(fields[5]).toBe('Σ Gesamt')
      expect(fields[3]).toBe('03:00:00')
      expect(fields[9]).toBe('225,00')
    })

    it('multi-tag entry is grouped by first tag only (no duplication)', () => {
      const entry = makeEntry({ tags: ',Design,Dev,' })
      const csv = formatCsv([entry], CLIENT_MAP, { groupByTag: true })
      const lines = csv.replace('\uFEFF', '').split('\r\n').filter(Boolean)
      // Only one data row expected, under Design (alphabetically first)
      const dataRows = lines.filter((l) => {
        const fields = l.split(';')
        // Data rows have a date in col 0 (dd.MM.yyyy)
        return /^\d{2}\.\d{2}\.\d{4}$/.test(fields[0])
      })
      expect(dataRows).toHaveLength(1)
    })
  })
})

describe('formatCsv — amounts follow the invoice rule', () => {
  const lastTwo = (csv: string): string[] => csv.split('\r\n')[1].split(';').slice(-2)

  it('rounds minutes up to the step before pricing', () => {
    // 16 min at 75 €/h with a 15-min step bills 30 min = 37,50 €.
    const entry = makeEntry({ stopped_at: '2026-04-25T09:16:00.000Z' })
    expect(lastTwo(formatCsv([entry], CLIENT_MAP, { roundMinutes: 15 }))).toEqual([
      '75,00',
      '37,50'
    ])
  })

  it('uses a project rate of its own over the client rate', () => {
    const entry = makeEntry({ project_id: 5 })
    const csv = formatCsv([entry], CLIENT_MAP, { projectRates: new Map([[5, 10000]]) })
    expect(lastTwo(csv)).toEqual(['100,00', '150,00'])
  })

  it('bills a goodwill project (rate 0) at 0,00, not the client rate', () => {
    const entry = makeEntry({ project_id: 5 })
    const csv = formatCsv([entry], CLIENT_MAP, { projectRates: new Map([[5, 0]]) })
    expect(lastTwo(csv)).toEqual(['0,00', '0,00'])
  })

  it('inherits the client rate for a project without one', () => {
    const entry = makeEntry({ project_id: 5 })
    const csv = formatCsv([entry], CLIENT_MAP, { projectRates: new Map([[5, null]]) })
    expect(lastTwo(csv)).toEqual(['75,00', '112,50'])
  })
})
