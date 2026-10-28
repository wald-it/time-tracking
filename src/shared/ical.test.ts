/**
 * Tests für den reinen iCal-Formatter (#135, Stufe 1).
 *
 * Schwerpunkt sind die RFC-5545-Fallstricke, an denen echte Bugs entstehen:
 * Oktett-basierte Zeilenfaltung (inkl. Multibyte/Umlaut), TEXT-Escaping in der
 * korrekten Reihenfolge, UTC-Zeitstempel, Cross-Midnight → zwei VEVENTs und die
 * nicht verhandelbare Privacy (weder Honorar noch private_note im Output).
 */
import { describe, expect, it } from 'vitest'
import { formatIcal, foldLine } from './ical'
import type { Client, Entry } from './types'

const encoder = new TextEncoder()
const byteLen = (s: string): number => encoder.encode(s).length

const BASE_CLIENT: Client = {
  short_code: null,
  id: 1,
  name: 'Acme GmbH',
  color: '#4f46e5',
  active: 1,
  rate_cent: 7500, // 75,00 €/h — darf NIE im Feed auftauchen
  created_at: '2024-01-01T00:00:00.000Z'
}
const CLIENT_MAP = new Map([[1, BASE_CLIENT]])
const NO_PROJECTS = new Map<number, string>()

// Fixe DTSTAMP für deterministische Ausgabe.
const FIXED_NOW = new Date('2026-04-01T00:00:00.000Z')

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
    segment_date: '2026-04-25',
    ...overrides
  }
}

/** Entfaltet gefaltete Content-Lines wieder zu logischen Zeilen. */
function unfold(ics: string): string {
  return ics.replace(/\r\n /g, '')
}

describe('formatIcal — Gerüst', () => {
  it('schreibt die Pflichtfelder des VCALENDAR', () => {
    const ics = formatIcal([], CLIENT_MAP, NO_PROJECTS, { now: FIXED_NOW })
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).toContain('VERSION:2.0')
    expect(ics).toContain('PRODID:')
    expect(ics).toContain('END:VCALENDAR')
  })

  it('nutzt CRLF als Zeilenende (RFC 5545), nie ein nacktes LF', () => {
    const ics = formatIcal([makeEntry()], CLIENT_MAP, NO_PROJECTS, { now: FIXED_NOW })
    expect(ics).toContain('\r\n')
    expect(ics).not.toMatch(/(?<!\r)\n/)
  })

  it('jeder Eintrag hat UID und DTSTAMP', () => {
    const ics = formatIcal([makeEntry()], CLIENT_MAP, NO_PROJECTS, { now: FIXED_NOW })
    expect(ics).toContain('UID:timetrack-entry-1-2026-04-25@wald-it.com')
    expect(ics).toContain('DTSTAMP:20260401T000000Z')
  })

  it('leitet die UID stabil aus Eintrags-ID und Segment-Datum ab (Re-Import aktualisiert statt dupliziert)', () => {
    const a = formatIcal([makeEntry({ id: 42 })], CLIENT_MAP, NO_PROJECTS, { now: FIXED_NOW })
    const b = formatIcal(
      [makeEntry({ id: 42, description: 'geändert' })],
      CLIENT_MAP,
      NO_PROJECTS,
      {
        now: FIXED_NOW
      }
    )
    expect(a).toContain('UID:timetrack-entry-42-2026-04-25@wald-it.com')
    expect(b).toContain('UID:timetrack-entry-42-2026-04-25@wald-it.com')
  })

  it('überspringt laufende Timer (kein stopped_at)', () => {
    const ics = formatIcal([makeEntry({ stopped_at: null })], CLIENT_MAP, NO_PROJECTS, {
      now: FIXED_NOW
    })
    expect(ics).not.toContain('BEGIN:VEVENT')
  })
})

describe('formatIcal — UTC-Zeitstempel (DST-sicher)', () => {
  it('schreibt DTSTART/DTEND direkt als UTC YYYYMMDDTHHMMSSZ', () => {
    const ics = formatIcal([makeEntry()], CLIENT_MAP, NO_PROJECTS, { now: FIXED_NOW })
    expect(ics).toContain('DTSTART:20260425T090000Z')
    expect(ics).toContain('DTEND:20260425T103000Z')
  })

  it('rechnet den ISO-String NICHT in Lokalzeit um (Sommerzeit-Eintrag bleibt UTC)', () => {
    // 2026-07-15 liegt in der MESZ-Periode; die UTC-Ausgabe muss die reinen
    // Z-Werte spiegeln, nicht +02:00.
    const ics = formatIcal(
      [
        makeEntry({
          started_at: '2026-07-15T12:00:00.000Z',
          stopped_at: '2026-07-15T13:00:00.000Z'
        })
      ],
      CLIENT_MAP,
      NO_PROJECTS,
      { now: FIXED_NOW }
    )
    expect(ics).toContain('DTSTART:20260715T120000Z')
    expect(ics).toContain('DTEND:20260715T130000Z')
  })
})

describe('formatIcal — SUMMARY & CATEGORIES', () => {
  it('setzt Kunde + Beschreibung in den Titel', () => {
    const ics = formatIcal([makeEntry({ description: 'Sprint-Review' })], CLIENT_MAP, NO_PROJECTS, {
      now: FIXED_NOW
    })
    expect(unfold(ics)).toContain('SUMMARY:Acme GmbH — Sprint-Review')
  })

  it('ergänzt den Projektnamen, wenn vorhanden', () => {
    const projects = new Map<number, string>([[9, 'Website-Relaunch']])
    const ics = formatIcal(
      [makeEntry({ project_id: 9, description: 'CSS' })],
      CLIENT_MAP,
      projects,
      { now: FIXED_NOW }
    )
    expect(unfold(ics)).toContain('SUMMARY:Acme GmbH / Website-Relaunch — CSS')
  })

  it('schreibt Tags als CATEGORIES', () => {
    const ics = formatIcal([makeEntry({ tags: ',bug,ux,' })], CLIENT_MAP, NO_PROJECTS, {
      now: FIXED_NOW
    })
    expect(unfold(ics)).toContain('CATEGORIES:bug,ux')
  })

  it('Privacy-Modus (showClientName=false): nur generischer Titel, keine Beschreibung/Tags', () => {
    const ics = formatIcal(
      [makeEntry({ description: 'Geheimprojekt', tags: ',bug,' })],
      CLIENT_MAP,
      NO_PROJECTS,
      { now: FIXED_NOW, showClientName: false }
    )
    expect(ics).toContain('SUMMARY:Fokus')
    expect(ics).not.toContain('Geheimprojekt')
    expect(ics).not.toContain('Acme')
    expect(ics).not.toContain('CATEGORIES')
  })
})

describe('formatIcal — Privacy (nicht verhandelbar)', () => {
  it('emittiert weder Honorar/Stundensatz noch private_note — auch bei gesetzten Werten', () => {
    const ics = formatIcal(
      [makeEntry({ private_note: 'INTERN-GEHEIM-123', description: 'Arbeit' })],
      CLIENT_MAP, // rate_cent 7500 gesetzt
      NO_PROJECTS,
      { now: FIXED_NOW }
    )
    expect(ics).not.toContain('INTERN-GEHEIM-123')
    expect(ics).not.toContain('7500')
    expect(ics).not.toContain('75,00')
    expect(ics).not.toContain('75.00')
    expect(ics.toUpperCase()).not.toContain('RATE')
  })
})

describe('formatIcal — Cross-Midnight', () => {
  it('zwei Segmente eines Eintrags (gleiche ID) ergeben zwei VEVENTs mit verschiedenen UIDs (kein Merge)', () => {
    const first = makeEntry({
      id: 1,
      segment_seq: 0,
      segment_date: '2026-04-25',
      started_at: '2026-04-25T21:00:00.000Z',
      stopped_at: '2026-04-25T23:59:59.000Z'
    })
    const second = makeEntry({
      id: 1,
      segment_seq: 1,
      segment_date: '2026-04-26',
      started_at: '2026-04-26T00:00:00.000Z',
      stopped_at: '2026-04-26T01:00:00.000Z'
    })
    const ics = formatIcal([first, second], CLIENT_MAP, NO_PROJECTS, { now: FIXED_NOW })
    const events = ics.match(/BEGIN:VEVENT/g) ?? []
    expect(events).toHaveLength(2)
    expect(ics).toContain('UID:timetrack-entry-1-2026-04-25@wald-it.com')
    expect(ics).toContain('UID:timetrack-entry-1-2026-04-26@wald-it.com')
  })
})

describe('formatIcal — TEXT-Escaping (RFC 5545 §3.3.11)', () => {
  it('escaped Backslash, Semikolon, Komma und Zeilenumbruch in korrekter Reihenfolge', () => {
    // Eingabe enthält alle vier Sonderfälle. Backslash zuerst escapen, sonst
    // würden die neu eingefügten Escapes doppelt escaped.
    const ics = formatIcal([makeEntry({ description: 'a\\b;c,d\ne' })], CLIENT_MAP, NO_PROJECTS, {
      now: FIXED_NOW
    })
    const line = unfold(ics)
    expect(line).toContain('SUMMARY:Acme GmbH — a\\\\b\\;c\\,d\\ne')
  })
})

describe('foldLine — Oktett-basierte Faltung (RFC 5545 §3.1)', () => {
  it('faltet eine reine ASCII-Zeile von exakt 75 Oktetten NICHT', () => {
    const line = 'X'.repeat(75)
    const folded = foldLine(line)
    expect(folded).not.toContain('\r\n ')
    expect(byteLen(folded)).toBe(75)
  })

  it('faltet eine ASCII-Zeile von 76 Oktetten in zwei physische Zeilen ≤ 75', () => {
    const line = 'X'.repeat(76)
    const folded = foldLine(line)
    expect(folded).toContain('\r\n ')
    for (const physical of folded.split('\r\n')) {
      expect(byteLen(physical)).toBeLessThanOrEqual(75)
    }
    // Entfalten rekonstruiert exakt die Ausgangszeile.
    expect(folded.replace(/\r\n /g, '')).toBe(line)
  })

  it('faltet nach Oktetten, nicht nach Zeichen: 74× "a" + "ä" (= 76 Oktette) muss falten', () => {
    // 75 ZEICHEN würden bei zeichenbasierter Faltung auf eine Zeile passen —
    // die wäre aber 76 OKTETTE lang. Beweist die Byte-Zählung.
    const line = 'a'.repeat(74) + 'ä'
    expect(line.length).toBe(75) // 75 Codepoints
    expect(byteLen(line)).toBe(76) // aber 76 Oktette
    const folded = foldLine(line)
    expect(folded).toContain('\r\n ')
    for (const physical of folded.split('\r\n')) {
      expect(byteLen(physical)).toBeLessThanOrEqual(75)
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line)
  })

  it('zerschneidet ein Multibyte-Zeichen nie mitten in der Byte-Sequenz', () => {
    // Kette aus Umlauten: jede physische Zeile muss für sich gültiges UTF-8
    // sein (Round-Trip durch encode/decode ohne Ersatzzeichen).
    const line = 'SUMMARY:' + 'ä'.repeat(60) // 8 + 120 = 128 Oktette
    const folded = foldLine(line)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    for (const physical of folded.split('\r\n')) {
      expect(byteLen(physical)).toBeLessThanOrEqual(75)
      // fatal:true wirft, wenn eine Byte-Sequenz mittendrin zerschnitten wäre.
      expect(() => decoder.decode(encoder.encode(physical))).not.toThrow()
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line)
  })

  it('behält eine Zeile mit exakt 75 Oktetten inkl. Umlaut ungefaltet', () => {
    const line = 'a'.repeat(73) + 'ä' // 73 + 2 = 75 Oktette
    expect(byteLen(line)).toBe(75)
    const folded = foldLine(line)
    expect(folded).not.toContain('\r\n ')
  })
})

describe('formatIcal — Faltung integriert', () => {
  it('lange Beschreibung mit Umlauten wird gefaltet, keine physische Zeile > 75 Oktette', () => {
    const ics = formatIcal(
      [makeEntry({ description: 'Ärgerliche Überstunden über Ostern — ' + 'ä'.repeat(80) })],
      CLIENT_MAP,
      NO_PROJECTS,
      { now: FIXED_NOW }
    )
    for (const physical of ics.split('\r\n')) {
      expect(byteLen(physical)).toBeLessThanOrEqual(75)
    }
  })
})
