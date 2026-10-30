/**
 * CSV export formatter (v1.5 PR C, issue #18).
 *
 * Produces UTF-8+BOM CSV that Excel DE opens without encoding prompts.
 * Default: semicolon separator + comma decimal (DACH convention).
 * Optional: comma separator + dot decimal (US / DATEV).
 *
 * Columns:
 *   Datum ; Start ; Ende ; Dauer ; Kunde ; Beschreibung ; Tags ; Referenz ; Stundensatz ; Betrag
 *
 * - Datum / Start / Ende in DE locale (dd.MM.yyyy / HH:mm).
 * - Dauer as HH:mm:ss so Excel [h]:mm:ss format works.
 * - Tags pipe-separated (| can't conflict with field separator).
 * - Stundensatz / Betrag follow the invoice rule (shared/currency.ts): project
 *   rate over client rate, minutes ceiled and rounded up to the step, fee
 *   rounded per entry. Empty when no rate applies; a goodwill project (rate 0)
 *   shows 0,00. Decimal uses chosen separator.
 * - Text cells (Kunde, Beschreibung, Tags, Referenz) that start with =, +, -,
 *   @, Tab or CR get a leading ' so spreadsheet apps keep them as text.
 *   Numeric cells are never prefixed.
 * - Line endings: \r\n (Windows / Excel DE friendly).
 * - Midnight-split entries stored as 2 separate rows in DB → 2 CSV rows (no special handling needed).
 */

import { formatTimeHHMM } from './date'
import { formatDuration } from './duration'
import { deserializeTags } from './tags'
import type { Entry, Client } from './types'

export interface CsvOptions {
  /** Document labels; independent of the data format and app language. */
  language?: 'de' | 'en'
  /** Field separator. Default: ';' (DACH). */
  fieldSeparator?: ';' | ','
  /** Decimal separator for monetary amounts. Default: ',' (DACH). */
  decimalSeparator?: ',' | '.'
  /** When true, entries are grouped by their first tag with subtotal rows. Default: false. */
  groupByTag?: boolean
}

/**
 * Rate and fee of one entry, exactly as the PDF invoice bills it: read from
 * the money columns of `billing_lines` (design section 7), never computed
 * here. `null` when no rate applies at all — the CSV leaves those cells empty.
 */
function entryBilling(entry: Entry): { rateCent: number; feeCent: number } | null {
  const rateCent = entry.rate_cent
  if (rateCent == null || entry.fee_cent == null) return null
  // A goodwill project (explicit 0) is billed, at 0 €; only "no rate anywhere" is empty.
  if (rateCent <= 0 && entry.rate_is_project !== 1) return null
  return { rateCent, feeCent: entry.fee_cent }
}

const HEADER_DE = [
  'Datum',
  'Start',
  'Ende',
  'Dauer',
  'Kunde',
  'Beschreibung',
  'Tags',
  'Referenz',
  'Stundensatz',
  'Betrag'
]

const CSV_LABELS = {
  de: { header: HEADER_DE, noTag: 'Ohne Tag', total: 'Σ Gesamt' },
  en: {
    header: [
      'Date',
      'Start',
      'End',
      'Duration',
      'Client',
      'Description',
      'Tags',
      'Reference',
      'Hourly rate',
      'Amount'
    ],
    noTag: 'No tag',
    total: 'Σ Total'
  }
}

/** Wrap a field value in quotes if it contains the separator, quote char, or newline. */
export function escapeField(value: string, sep: string): string {
  if (value.includes(sep) || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return '"' + value.replace(/"/g, '""') + '"'
  }
  return value
}

/**
 * Characters that make Excel, LibreOffice and Google Sheets read a cell as a
 * formula instead of text.
 */
const FORMULA_START = ['=', '+', '-', '@', '\t', '\r']

/**
 * Escape a free-text cell (client, description, tags, reference, group
 * labels). A text that starts with a formula character gets a leading `'`, so
 * spreadsheet apps show it as typed instead of evaluating it. Numeric cells
 * (dates, times, durations, rates, amounts) go through `escapeField` only —
 * a negative amount like `-12,50` must stay a number.
 */
export function escapeTextField(value: string, sep: string): string {
  const guarded = FORMULA_START.some((c) => value.startsWith(c)) ? "'" + value : value
  return escapeField(guarded, sep)
}

/** Format a fractional number using the chosen decimal separator, 2 decimal places. */
function formatDecimal(n: number, decimalSep: string): string {
  return n.toFixed(2).replace('.', decimalSep)
}

/**
 * Build a CSV string (UTF-8 BOM + header + data rows) from a list of entries.
 *
 * @param entries  - Only complete entries (stopped_at non-null) are exported.
 *                   Running entries are silently skipped.
 * @param clientMap - Map from client_id → Client (for name + rate).
 * @param opts     - Format options.
 */
export function formatCsv(
  entries: Entry[],
  clientMap: Map<number, Client>,
  opts: CsvOptions = {}
): string {
  const sep = opts.fieldSeparator ?? ';'
  const dec = opts.decimalSeparator ?? ','
  const labels = CSV_LABELS[opts.language ?? 'de']

  // Pre-filter: skip running entries and non-billable entries.
  const validEntries = entries.filter((e) => {
    if (!e.stopped_at) return false
    if (e.billable === 0) return false
    return true
  })

  const headerRow = labels.header.map((h) => escapeField(h, sep)).join(sep)
  const rows: string[] = [headerRow]

  if (opts.groupByTag && validEntries.some((e) => deserializeTags(e.tags).length > 0)) {
    appendGroupedRows(rows, validEntries, clientMap, sep, dec, labels)
  } else {
    for (const entry of validEntries) {
      rows.push(buildEntryRow(entry, clientMap, sep, dec))
    }
  }

  // UTF-8 BOM + CRLF line endings
  return '\uFEFF' + rows.join('\r\n') + '\r\n'
}

/**
 * Build an array of CSV rows for a single entry (no newline handling — caller
 * is responsible for joining with \r\n).
 */
function buildEntryRow(
  entry: Entry,
  clientMap: Map<number, Client>,
  sep: string,
  dec: string
): string {
  const start = new Date(entry.started_at)
  const stop = new Date(entry.stopped_at!)
  const durationSec = Math.max(0, Math.floor((stop.getTime() - start.getTime()) / 1000))

  const client = clientMap.get(entry.client_id)
  const clientName = client?.name ?? ''
  const billing = entryBilling(entry)

  const rateStr = billing ? formatDecimal(billing.rateCent / 100, dec) : ''
  const betragStr = billing ? formatDecimal(billing.feeCent / 100, dec) : ''

  const tags = deserializeTags(entry.tags).join('|')
  const reference = entry.reference ?? ''

  return [
    escapeField(
      // The stored day when there is one, so the column matches the range filter.
      entry.segment_date ? entry.segment_date.split('-').reverse().join('.') : formatDate(start),
      sep
    ),
    escapeField(formatTimeHHMM(start), sep),
    escapeField(formatTimeHHMM(stop), sep),
    escapeField(formatDuration(durationSec), sep),
    escapeTextField(clientName, sep),
    escapeTextField(entry.description, sep),
    escapeTextField(tags, sep),
    escapeTextField(reference, sep),
    escapeField(rateStr, sep),
    escapeField(betragStr, sep)
  ].join(sep)
}

/** Column indexes holding free text: Kunde, Beschreibung, Tags, Referenz. */
const TEXT_COLUMNS = new Set([4, 5, 6, 7])

/** Escape a cell of a group/total row by its column: text guard for text columns only. */
function escapeCell(value: string, column: number, sep: string): string {
  return TEXT_COLUMNS.has(column) ? escapeTextField(value, sep) : escapeField(value, sep)
}

/**
 * Append tag-grouped rows (header + data + subtotal per group, then grand
 * total) to the rows array in-place.
 *
 * Grouping key: first tag of each entry. Entries with no tags fall into the
 * "Ohne Tag" group (shown last). Named groups sorted alphabetically.
 */
function appendGroupedRows(
  rows: string[],
  entries: Entry[],
  clientMap: Map<number, Client>,
  sep: string,
  dec: string,
  labels: (typeof CSV_LABELS)['de']
): void {
  // Build groups keyed by first tag ('' = no tag).
  const groupMap = new Map<string, Entry[]>()
  for (const entry of entries) {
    const entryTags = deserializeTags(entry.tags)
    const key = entryTags[0] ?? ''
    const bucket = groupMap.get(key) ?? []
    bucket.push(entry)
    groupMap.set(key, bucket)
  }

  // Named tags alphabetically first, then '' (Ohne Tag) last.
  const sortedKeys = [...groupMap.keys()].sort((a, b) => {
    if (a === '') return 1
    if (b === '') return -1
    return a.localeCompare(b, 'de')
  })

  let grandDurSec = 0
  let grandAmountCent = 0
  let grandHasRate = false

  for (const key of sortedKeys) {
    const groupEntries = groupMap.get(key)!
    const tagLabel = key === '' ? labels.noTag : key

    // Group header row: tag name in Beschreibung column, all others empty.
    const headerFields = Array<string>(labels.header.length).fill('')
    headerFields[5] = `[${tagLabel}]` // Beschreibung column
    rows.push(headerFields.map((f, i) => escapeCell(f, i, sep)).join(sep))

    let groupDurSec = 0
    let groupAmountCent = 0
    let groupHasRate = false

    for (const entry of groupEntries) {
      rows.push(buildEntryRow(entry, clientMap, sep, dec))

      const start = new Date(entry.started_at)
      const stop = new Date(entry.stopped_at!)
      const durSec = Math.max(0, Math.floor((stop.getTime() - start.getTime()) / 1000))
      groupDurSec += durSec

      const billing = entryBilling(entry)
      if (billing) {
        groupHasRate = true
        groupAmountCent += billing.feeCent
      }
    }

    grandDurSec += groupDurSec
    if (groupHasRate) {
      grandHasRate = true
      grandAmountCent += groupAmountCent
    }

    // Subtotal row: Beschreibung = label, Dauer = duration, Betrag = amount.
    const subtotalFields = Array<string>(labels.header.length).fill('')
    subtotalFields[3] = formatDuration(groupDurSec) // Dauer
    subtotalFields[5] = `${tagLabel} Σ` // Beschreibung
    if (groupHasRate) subtotalFields[9] = formatDecimal(groupAmountCent / 100, dec) // Betrag
    rows.push(subtotalFields.map((f, i) => escapeCell(f, i, sep)).join(sep))
  }

  // Grand total row.
  const totalFields = Array<string>(labels.header.length).fill('')
  totalFields[3] = formatDuration(grandDurSec)
  totalFields[5] = labels.total
  if (grandHasRate) totalFields[9] = formatDecimal(grandAmountCent / 100, dec)
  rows.push(totalFields.map((f, i) => escapeCell(f, i, sep)).join(sep))
}

/** Format a Date as dd.MM.yyyy in local timezone. */
function formatDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${dd}.${mm}.${yyyy}`
}
