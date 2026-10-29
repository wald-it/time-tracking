/**
 * iCalendar (.ics) export formatter — Stufe 1, statischer Export (#135).
 *
 * Warum getrennt von icalExport.ts (Vorbild csv.ts ↔ csvExport.ts):
 * dieser Teil ist eine reine Funktion ohne Electron-Importe und damit
 * unit-testbar. icalExport.ts macht Dialog + DB-Query + Schreiben.
 *
 * Zwei Fallstricke, an denen echte iCal-Bugs entstehen, sind hier bewusst
 * adressiert:
 *
 *  - **Zeitzone/DST:** started_at/stopped_at liegen bereits als UTC-ISO in der
 *    DB (`toISOString()`, `Z`-Suffix). DTSTART/DTEND werden deshalb direkt im
 *    UTC-Format `YYYYMMDDTHHMMSSZ` geschrieben. Kein VTIMEZONE nötig, keine
 *    Lokalzeit-Rechnung (die Helfer aus date.ts sind für die UI-Anzeige) — das
 *    Ergebnis ist DST-sicher, wie es das Issue als Akzeptanzkriterium fordert.
 *
 *  - **Zeilenfaltung nach Oktetten (nicht Zeichen):** RFC 5545 erlaubt max. 75
 *    Oktette pro Zeile. Umlaute/Emoji sind in UTF-8 mehrere Bytes; eine
 *    zeichenbasierte Faltung würde entweder zu lange Zeilen erzeugen oder ein
 *    Multibyte-Zeichen mittendrin zerschneiden und die Datei für strenge Parser
 *    zerstören. `foldLine` zählt daher Oktette und faltet nur an
 *    Codepoint-Grenzen.
 *
 * Cross-Midnight: Einträge über Mitternacht liegen als zwei Zeilen mit
 * gemeinsamer link_id in der DB. Wie CSV/JSON behandeln wir beide Hälften als
 * unabhängige Zeilen → zwei VEVENTs. Keine link_id-Merge-Logik (die gibt es
 * nirgends im Code).
 *
 * Privacy (nicht verhandelbar, Issue-Vorgabe): Honorare/Stundensätze und
 * `private_note` tauchen NIE im Feed auf — hier schlicht dadurch, dass diese
 * Felder nirgends emittiert werden. Der MCP-Privacy-Schalter ist irrelevant:
 * er gilt für den MCP-Server, nicht für eine Datei, die im Kalender eines
 * Arbeitgebers landen kann.
 *
 * Zeilenenden: RFC 5545 schreibt CRLF vor. Das betrifft das generierte
 * Artefakt, nicht die LF-normalisierten Quelldateien (#141).
 */

import { deserializeTags } from './tags'
import type { Client, Entry } from './types'

export interface IcalOptions {
  /**
   * true (Default): SUMMARY = Kunde (+ Projekt) + Beschreibung.
   * false: SUMMARY = generischer Titel (`genericTitle`), und zum Schutz der
   * Vertraulichkeit werden auch Beschreibung und CATEGORIES/Tags weggelassen —
   * ein „Fokus"-Block darf sonst über Tags/Beschreibung doch den Kunden
   * verraten.
   */
  showClientName?: boolean
  /** Generischer Titel, wenn showClientName=false. Default: 'Fokus'. */
  genericTitle?: string
  /** PRODID-Wert. Default: TimeTrack-Kennung. */
  prodId?: string
  /**
   * Fixes DTSTAMP für deterministische Ausgabe (Tests). Default: jetzt.
   * DTSTAMP ist der Erstellungszeitpunkt des Kalenderobjekts, nicht der
   * Termin selbst.
   */
  now?: Date
}

const DEFAULT_PRODID = '-//wald-it//TimeTrack//DE'
const DEFAULT_GENERIC_TITLE = 'Fokus'

const encoder = new TextEncoder()

/**
 * Escape für iCalendar-TEXT-Werte (RFC 5545 §3.3.11).
 * Reihenfolge zwingend: Backslash zuerst, sonst werden die eigenen Escapes
 * (`\;`, `\,`) doppelt escaped.
 */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Faltet eine Content-Line auf max. 75 Oktette pro physischer Zeile
 * (RFC 5545 §3.1). Fortsetzungszeilen beginnen mit einem Leerzeichen.
 *
 * Gezählt wird in UTF-8-Oktetten; gefaltet wird nur an Codepoint-Grenzen
 * (`for..of` iteriert über Codepoints, hält also Surrogatpaare/Umlaute
 * zusammen). Die Fortsetzungszeilen reservieren ein Oktett für das führende
 * Leerzeichen, damit auch die physische Zeile inkl. Space ≤ 75 Oktette bleibt.
 */
export function foldLine(line: string): string {
  const OCTET_LIMIT = 75
  const segments: string[] = []
  let current = ''
  let currentBytes = 0
  let isFirst = true

  for (const ch of line) {
    const chBytes = encoder.encode(ch).length
    // Fortsetzungszeile trägt ein führendes Leerzeichen → 1 Oktett reserviert.
    const limit = isFirst ? OCTET_LIMIT : OCTET_LIMIT - 1
    if (currentBytes > 0 && currentBytes + chBytes > limit) {
      segments.push(current)
      current = ''
      currentBytes = 0
      isFirst = false
    }
    current += ch
    currentBytes += chBytes
  }
  segments.push(current)

  return segments.join('\r\n ')
}

/** Formatiert einen UTC-ISO-String als iCal-UTC-Zeitstempel `YYYYMMDDTHHMMSSZ`. */
function formatUtcStamp(iso: string): string {
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  )
}

/**
 * Stabile, eindeutige UID pro Segment. Aus Eintrags-ID und gespeichertem
 * Segment-Datum abgeleitet (Design 6: `timetrack-entry-<id>-<segment_date>`),
 * damit ein erneuter Import denselben Termin aktualisiert statt zu
 * duplizieren, auch wenn eine Bearbeitung vorne einen Tag ergänzt. Die beiden
 * Tage eines Cross-Midnight-Eintrags teilen die ID, haben aber verschiedene
 * Segment-Daten → zwei UIDs → zwei eigenständige VEVENTs. Ohne gespeichertes
 * Datum (eine Zeile, die nicht aus der View kommt) zählt der lokale Tag des
 * Beginns.
 */
function buildUid(entry: Entry): string {
  return `timetrack-entry-${entry.id}-${entry.segment_date ?? localDate(entry.started_at)}@wald-it.com`
}

function localDate(iso: string): string {
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Baut einen iCalendar-String (VCALENDAR mit je einem VEVENT pro Eintrag).
 *
 * @param entries    - Nur abgeschlossene Einträge (stopped_at gesetzt) werden
 *                     exportiert; laufende Timer werden still übersprungen.
 *                     Nicht abrechenbare Einträge bleiben drin — anders als der
 *                     rechnungsorientierte CSV-Export ist der Kalender eine
 *                     Ist-Zeit-Ansicht.
 * @param clientMap  - client_id → Client (nur der Name wird genutzt).
 * @param projectMap - project_id → Projektname (für den SUMMARY-Zusatz).
 * @param opts       - Formatoptionen (Privacy-Titel, PRODID, DTSTAMP).
 */
export function formatIcal(
  entries: Entry[],
  clientMap: Map<number, Client>,
  projectMap: Map<number, string>,
  opts: IcalOptions = {}
): string {
  const showClientName = opts.showClientName ?? true
  const genericTitle = opts.genericTitle ?? DEFAULT_GENERIC_TITLE
  const prodId = opts.prodId ?? DEFAULT_PRODID
  const dtstamp = formatUtcStamp((opts.now ?? new Date()).toISOString())

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${escapeText(prodId)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH'
  ]

  for (const entry of entries) {
    if (!entry.stopped_at) continue // laufende Timer raus

    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${escapeText(buildUid(entry))}`)
    lines.push(`DTSTAMP:${dtstamp}`)
    lines.push(`DTSTART:${formatUtcStamp(entry.started_at)}`)
    lines.push(`DTEND:${formatUtcStamp(entry.stopped_at)}`)

    if (showClientName) {
      const clientName = clientMap.get(entry.client_id)?.name ?? ''
      const projectName = entry.project_id != null ? (projectMap.get(entry.project_id) ?? '') : ''
      const namePart = [clientName, projectName].filter((s) => s.length > 0).join(' / ')
      const description = entry.description?.trim() ?? ''

      let summary: string
      if (description) {
        summary = namePart ? `${namePart} — ${description}` : description
      } else {
        summary = namePart || genericTitle
      }
      lines.push(`SUMMARY:${escapeText(summary)}`)

      const tags = deserializeTags(entry.tags)
      if (tags.length > 0) {
        // CATEGORIES ist eine kommaseparierte Liste; die Trenn-Kommas sind
        // strukturell und werden NICHT escaped, die einzelnen Werte schon.
        lines.push(`CATEGORIES:${tags.map(escapeText).join(',')}`)
      }
    } else {
      // Privacy-Modus: generischer Titel, sonst nichts Identifizierendes.
      lines.push(`SUMMARY:${escapeText(genericTitle)}`)
    }

    lines.push('END:VEVENT')
  }

  lines.push('END:VCALENDAR')

  // Jede Content-Line falten, mit CRLF verbinden, mit CRLF abschließen.
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
