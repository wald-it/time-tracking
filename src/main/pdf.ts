/**
 * PDF payload assembly + HTML template rendering.
 *
 * Pure functions — no Electron, no I/O. The hidden-window driver in
 * `pdfWindow.ts` calls `buildPdfPayload()` to gather data and
 * `buildPdfHtml()` to produce the self-contained HTML string that gets
 * fed to `webContents.printToPDF()`.
 *
 * Why a string template instead of a third Vite renderer entry: the PDF
 * doesn't need Tailwind, React, or hot-reload. Inline CSS keeps the
 * artifact self-contained, eliminates a build-config knot (R5 in the
 * v1.3 plan), and makes the output trivially snapshot-testable.
 */
import type Database from 'better-sqlite3'
import { formatEur, formatHoursMinutes } from '../shared/currency'
import { localDayRange } from '../shared/dateRanges'
import { deserializeTags } from '../shared/tags'
import type { Client, Entry, Settings } from '../shared/types'

export interface PdfRequest {
  clientId: number
  /** ISO-date strings, inclusive. e.g. '2026-04-01' to '2026-04-30'. */
  fromIso: string
  toIso: string
  /**
   * v1.9 #75: optional project filter. When set, only entries with this
   * project_id are included in the PDF. `undefined` / `null` = all projects.
   */
  projectId?: number | null
  /**
   * Render the two signature lines ("Datum, Auftragnehmer" / "Datum,
   * Auftraggeber") at the bottom of the document. Default `false` —
   * most users never need them, and an empty signature row at the end
   * looks like an unfinished template. Toggled per-export from the modal.
   */
  includeSignatures?: boolean
  /**
   * v1.13 #118: row grouping in the rendered PDF. Each distinct group
   * value gets its own section with a subtotal.
   *
   *  - `'none'`      — flat table (default).
   *  - `'tag'`       — group by tag. Entries with no tag fall under "Ohne Tag".
   *  - `'project'`   — group by project name. Entries with no project fall
   *                    under "Ohne Projekt". Only meaningful when `projectId`
   *                    is not also set (otherwise there is exactly one group).
   *  - `'reference'` — group by entry reference (e.g. ticket id). Entries
   *                    with no reference fall under "Sonstiges".
   *
   * Falls back to flat layout when no entry carries the chosen grouping
   * dimension (silent fallback, matches the legacy `groupByTag` behaviour).
   */
  groupBy?: 'none' | 'tag' | 'project' | 'reference'
  /**
   * Legacy v1.5 flag. When `true` and `groupBy` is unset, coerces to
   * `groupBy: 'tag'` so existing callers keep working.
   * @deprecated use `groupBy` instead.
   */
  groupByTag?: boolean
  /**
   * v1.13 #118: hide the Honorar column even when a rate is configured.
   * Used when the sender wants to share a stundennachweis without
   * exposing the per-row or total billed amount.
   */
  hideFeeColumn?: boolean
}

export interface PdfRow {
  date: string
  startTime: string
  stopTime: string
  description: string
  minutes: number
  feeCent: number | null
  /** Raw serialized tags string from the DB column (`,bug,ux,` format). Optional — only needed for `groupBy: 'tag'`. */
  tags?: string
  /** Free-text ticket/reference (e.g. 'JIRA-123'). Empty string = no reference. */
  reference?: string
  /**
   * v1.13 #118: project name rendered as a small line under the description
   * when the export spans multiple projects of a client. `undefined` when
   * the row has no project or when the project context is already implied
   * by a project filter / project-grouping header.
   */
  projectName?: string
}

/**
 * One group when `groupBy !== 'none'`. `label` is the rendered group heading
 * (e.g. `#bug`, `Projekt: Alpha`, `Sonstiges`).
 */
export interface PdfGroup {
  label: string
  rows: PdfRow[]
  totalMinutes: number
  totalFeeCent: number | null
}

export interface PdfPayload {
  client: Pick<
    Client,
    | 'id'
    | 'name'
    | 'rate_cent'
    | 'billing_address_line1'
    | 'billing_address_line2'
    | 'billing_address_line3'
    | 'billing_address_line4'
    | 'vat_id'
    | 'contact_person'
    | 'contact_email'
  >
  /** Sender block: pulled from settings.company_name + pdf_sender_address. */
  sender: { name: string; address: string; taxId: string }
  /** ISO range echoed back for the header. */
  fromIso: string
  toIso: string
  rows: PdfRow[]
  totals: {
    minutes: number
    /** null when the client has no rate (rate_cent === 0). */
    feeCent: number | null
  }
  accentColor: string
  footerText: string
  /** Logo as a `data:image/...;base64,...` URL or empty string. */
  logoDataUrl: string
  /** Rounding step in minutes; 0 = no rounding. */
  roundMinutes: number
  /**
   * When true, the rendered HTML includes a bottom signature row with
   * lines for Auftragnehmer / Auftraggeber. Defaults to false at the
   * payload level so existing call-sites / tests don't have to opt out.
   */
  includeSignatures?: boolean
  /** Used for the "erstellt am" footer line. */
  generatedAtIso: string
  /**
   * When non-null, rows are organised into groups for the HTML renderer.
   * null = flat layout (default).
   */
  groups: PdfGroup[] | null
  /**
   * v1.13 #118: when true, the Honorar column is suppressed even though
   * a rate is configured. Mirrors the user-facing toggle in the export modal.
   */
  hideFeeColumn?: boolean
  /**
   * v1.9 #75: optional project name for the PDF header when the export
   * is filtered to a single project. Undefined = all projects (no label shown).
   */
  projectName?: string
  /**
   * v1.12 #105: effective contact person for the recipient block.
   * Priority: project.contact_person ?? client.contact_person.
   * Undefined / null = no "z.Hd." line rendered.
   */
  effectiveContactPerson?: string | null
}

const DATE_FMT = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
})

const TIME_FMT = new Intl.DateTimeFormat('de-DE', {
  hour: '2-digit',
  minute: '2-digit'
})

function formatDate(iso: string): string {
  return DATE_FMT.format(new Date(iso))
}

function formatTime(iso: string): string {
  return TIME_FMT.format(new Date(iso))
}

/**
 * Snap a Date to the nearest `step` minutes (local time, half-up).
 * Used to align displayed start times with the rounded duration so the
 * PDF reader sees `19:00 – 19:30 → 0:30` instead of
 * `18:54 – 19:18 → 0:30` (which would look like a math error to the
 * recipient even though the duration column is correct).
 *
 * Edge: a snap near local midnight may roll the wall-clock time into
 * the next day (e.g. 23:50 with step=30 → 00:00 next day). The PDF
 * `date` column is taken from the raw start date, so this manifests as
 * a slightly weird-looking row — but in practice cross-midnight entries
 * are already auto-split into halves at the IPC layer (PR B), so no
 * stored entry should sit within `step/2` minutes of midnight.
 */
function snapToStepLocal(d: Date, step: number): Date {
  const totalMin = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
  const snapped = Math.round(totalMin / step) * step
  const result = new Date(d)
  result.setHours(0, 0, 0, 0)
  // setMinutes handles overflow into next day correctly.
  result.setMinutes(snapped)
  return result
}

function formatTimeDate(d: Date): string {
  return TIME_FMT.format(d)
}

/**
 * Read entries + client + settings from the DB and shape them into a
 * fully-resolved PdfPayload. Pure with respect to the DB handle —
 * doesn't write, doesn't touch the filesystem.
 *
 * The `logoDataUrl` is the caller's responsibility (loaded from
 * `settings.pdf_logo_path` once and base64-encoded) so this stays sync
 * and testable.
 */
export function buildPdfPayload(
  db: Database.Database,
  req: PdfRequest,
  logoDataUrl: string,
  generatedAtIso: string = new Date().toISOString()
): PdfPayload {
  const client = db
    .prepare(
      `SELECT id, name, rate_cent,
        billing_address_line1, billing_address_line2,
        billing_address_line3, billing_address_line4,
        vat_id, contact_person, contact_email
      FROM clients WHERE id = ?`
    )
    .get(req.clientId) as
    | Pick<
        Client,
        | 'id'
        | 'name'
        | 'rate_cent'
        | 'billing_address_line1'
        | 'billing_address_line2'
        | 'billing_address_line3'
        | 'billing_address_line4'
        | 'vat_id'
        | 'contact_person'
        | 'contact_email'
      >
    | undefined
  if (!client) {
    throw new Error(`Kunde mit id=${req.clientId} nicht gefunden`)
  }

  const settingsRows = db.prepare(`SELECT key, value FROM settings`).all() as Array<{
    key: string
    value: string
  }>
  const settings = Object.fromEntries(
    settingsRows.map((r) => [r.key, r.value])
  ) as unknown as Settings

  // Local days, both inclusive: an entry started at 00:30 on the first day or
  // 23:30 on the last belongs to the attachment, wherever the user lives.
  const { start: fromTs, end: toExclusive } = localDayRange(req.fromIso, req.toIso)

  // Money comes from billing_lines (design section 7): minutes, rate and fee
  // per segment, with the client's profile and the rate valid on the day.
  const entries = db
    .prepare(
      `SELECT e.*, p.name AS project_name,
              l.billed_minutes, l.rate_cent AS line_rate_cent, l.fee_cent, l.rate_is_project,
              l.interval_min, l.alignment
         FROM entries e
         JOIN billing_lines l ON l.version_id = e.version_id AND l.segment_seq = e.segment_seq
         LEFT JOIN projects p ON p.id = e.project_id
         WHERE e.client_id = ?
           AND e.deleted_at IS NULL
           AND e.stopped_at IS NOT NULL
           AND e.billable = 1
           AND e.started_at >= ?
           AND e.started_at < ?
           AND (? IS NULL OR e.project_id = ?)
         ORDER BY e.started_at ASC, e.id ASC`
    )
    .all(client.id, fromTs, toExclusive, req.projectId ?? null, req.projectId ?? null) as Array<
    Entry & {
      project_name: string | null
      billed_minutes: number
      line_rate_cent: number
      fee_cent: number
      rate_is_project: number
      interval_min: number
      alignment: 'none' | 'grid'
    }
  >

  // v1.13 #118: backward-compat — the legacy `groupByTag` boolean coerces
  // to the new enum when the caller hasn't migrated yet.
  const groupBy: 'none' | 'tag' | 'project' | 'reference' =
    req.groupBy ?? (req.groupByTag ? 'tag' : 'none')

  // v1.13 #118: project label per row — only when the export spans
  // multiple projects (no projectId filter) AND we are not already
  // grouping by project (the group header would duplicate it).
  const showProjectPerRow = req.projectId == null && groupBy !== 'project'

  const rows: PdfRow[] = entries.map((e) => {
    const start = new Date(e.started_at)
    const minutes = e.billed_minutes
    // A goodwill project (explicit 0) is billed at 0 € and keeps the fee
    // column; null means no rate applies anywhere.
    const fee =
      e.line_rate_cent > 0 || (e.rate_is_project === 1 && e.line_rate_cent === 0)
        ? e.fee_cent
        : null
    // The profile's alignment `grid` adjusts the displayed times so the
    // visible "Von / Bis / Dauer" arithmetic adds up for the recipient: snap
    // the start to the interval, derive the stop as start + billed minutes.
    // `none` prints the stored clock times.
    let startTime: string
    let stopTime: string
    if (e.alignment === 'grid' && e.interval_min > 0) {
      const displayedStart = snapToStepLocal(start, e.interval_min)
      const displayedStop = new Date(displayedStart.getTime() + minutes * 60_000)
      startTime = formatTimeDate(displayedStart)
      stopTime = formatTimeDate(displayedStop)
    } else {
      startTime = formatTime(e.started_at)
      stopTime = formatTime(e.stopped_at as string)
    }
    return {
      date: formatDate(e.started_at),
      startTime,
      stopTime,
      description: e.description ?? '',
      minutes,
      feeCent: fee,
      tags: e.tags ?? '',
      reference: e.reference ?? '',
      projectName: showProjectPerRow && e.project_name ? e.project_name : undefined
    }
  })

  const totalMinutes = rows.reduce((sum, r) => sum + r.minutes, 0)
  // v1.13 #120: show fee column when the client has a rate (legacy behavior)
  // OR when any row carries a fee via project rate (new behavior). Previously
  // gated only on client.rate_cent > 0, which hid revenue from project-only rates.
  const anyFee = rows.some((r) => r.feeCent != null)
  const showFee = client.rate_cent > 0 || anyFee
  const totalFee = showFee ? rows.reduce((sum, r) => sum + (r.feeCent ?? 0), 0) : null

  // v1.13 #118: build groups based on the chosen dimension. Each branch
  // produces a Map<label, rows[]> + an ordering rule for the labels.
  // Silent fallback to flat layout when no row carries the chosen dim.
  let groups: PdfGroup[] | null = null
  if (groupBy === 'tag' && rows.some((r) => r.tags && r.tags !== '')) {
    const groupMap = new Map<string, PdfRow[]>()
    for (const row of rows) {
      const rowTags = deserializeTags(row.tags ?? '')
      if (rowTags.length === 0) {
        const bucket = groupMap.get('') ?? []
        bucket.push(row)
        groupMap.set('', bucket)
      } else {
        for (const tag of rowTags) {
          const bucket = groupMap.get(tag) ?? []
          bucket.push(row)
          groupMap.set(tag, bucket)
        }
      }
    }
    const sortedKeys = [...groupMap.keys()].sort((a, b) => {
      if (a === '') return 1
      if (b === '') return -1
      return a.localeCompare(b)
    })
    groups = sortedKeys.map((tag) => {
      const groupRows = groupMap.get(tag)!
      const gMinutes = groupRows.reduce((s, r) => s + r.minutes, 0)
      const gFee = showFee ? groupRows.reduce((s, r) => s + (r.feeCent ?? 0), 0) : null
      return {
        label: tag ? `#${tag}` : 'Ohne Tag',
        rows: groupRows,
        totalMinutes: gMinutes,
        totalFeeCent: gFee
      }
    })
  } else if (groupBy === 'project' && entries.some((e) => e.project_name)) {
    // Group by project name. Entries with no project_id fall under 'Ohne Projekt'.
    const groupMap = new Map<string, PdfRow[]>()
    rows.forEach((row, idx) => {
      const name = entries[idx].project_name ?? ''
      const bucket = groupMap.get(name) ?? []
      bucket.push(row)
      groupMap.set(name, bucket)
    })
    const sortedKeys = [...groupMap.keys()].sort((a, b) => {
      if (a === '') return 1
      if (b === '') return -1
      return a.localeCompare(b)
    })
    groups = sortedKeys.map((name) => {
      const groupRows = groupMap.get(name)!
      const gMinutes = groupRows.reduce((s, r) => s + r.minutes, 0)
      const gFee = showFee ? groupRows.reduce((s, r) => s + (r.feeCent ?? 0), 0) : null
      return {
        label: name ? `Projekt: ${name}` : 'Ohne Projekt',
        rows: groupRows,
        totalMinutes: gMinutes,
        totalFeeCent: gFee
      }
    })
  } else if (groupBy === 'reference' && rows.some((r) => r.reference && r.reference !== '')) {
    // Group by entry.reference. Empty/missing falls under 'Sonstiges' (per #118).
    const groupMap = new Map<string, PdfRow[]>()
    for (const row of rows) {
      const ref = row.reference && row.reference.trim() !== '' ? row.reference : ''
      const bucket = groupMap.get(ref) ?? []
      bucket.push(row)
      groupMap.set(ref, bucket)
    }
    const sortedKeys = [...groupMap.keys()].sort((a, b) => {
      if (a === '') return 1
      if (b === '') return -1
      return a.localeCompare(b, 'de', { numeric: true })
    })
    groups = sortedKeys.map((ref) => {
      const groupRows = groupMap.get(ref)!
      const gMinutes = groupRows.reduce((s, r) => s + r.minutes, 0)
      const gFee = showFee ? groupRows.reduce((s, r) => s + (r.feeCent ?? 0), 0) : null
      return {
        label: ref || 'Sonstiges',
        rows: groupRows,
        totalMinutes: gMinutes,
        totalFeeCent: gFee
      }
    })
  }

  // v1.9 #75: load project name when filtered to a specific project
  // v1.12 #105: also load project.contact_person for the recipient fallback
  let projectName: string | undefined
  let projectContactPerson: string | null | undefined
  if (req.projectId != null) {
    const proj = db
      .prepare(`SELECT name, contact_person FROM projects WHERE id = ?`)
      .get(req.projectId) as { name: string; contact_person: string | null } | undefined
    projectName = proj?.name
    projectContactPerson = proj?.contact_person ?? null
  }

  // v1.12 #105: project contact person overrides client contact person
  const effectiveContactPerson =
    req.projectId != null ? (projectContactPerson ?? client.contact_person) : client.contact_person

  return {
    client,
    sender: {
      name: settings.company_name ?? '',
      address: settings.pdf_sender_address ?? '',
      taxId: settings.pdf_tax_id ?? ''
    },
    fromIso: req.fromIso,
    toIso: req.toIso,
    rows,
    totals: { minutes: totalMinutes, feeCent: totalFee },
    accentColor: settings.pdf_accent_color || '#4f46e5',
    footerText: settings.pdf_footer_text ?? '',
    logoDataUrl,
    roundMinutes: entries.reduce((max, e) => Math.max(max, e.interval_min), 0),
    includeSignatures: req.includeSignatures === true,
    generatedAtIso,
    groups,
    projectName,
    effectiveContactPerson,
    hideFeeColumn: req.hideFeeColumn === true
  }
}

/**
 * Escape user-controlled strings for safe interpolation into the HTML
 * template. Matches the OWASP basic set; we never output user content
 * into JS or attribute contexts (only text + a single style attribute
 * for the accent color, which we restrict to `#RRGGBB` upstream).
 */
function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Validate `#RRGGBB` accent color and fall back to indigo on bad input. */
function safeColor(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#4f46e5'
}

/**
 * Produce a self-contained HTML document for the PDF. All CSS inline,
 * all assets embedded as data: URLs. Designed for `pageSize: 'A4'`
 * with `printBackground: true` and 2 cm margins on the printToPDF call
 * (we don't repeat margins in CSS to avoid double-margins).
 */
export function buildPdfHtml(p: PdfPayload): string {
  const accent = safeColor(p.accentColor)
  // v1.13 #118: explicit hide overrides the rate-based default.
  const showFee = p.hideFeeColumn ? false : p.totals.feeCent !== null
  const dateRange = `${formatDate(p.fromIso)} – ${formatDate(p.toIso)}`
  const generated = formatDate(p.generatedAtIso)

  const senderLines = p.sender.address
    .split('\n')
    .map((line) => esc(line.trim()))
    .filter(Boolean)
    .join('<br />')

  const taxLine = p.sender.taxId ? `<div>Steuernr.: ${esc(p.sender.taxId)}</div>` : ''

  const logoBlock = p.logoDataUrl
    ? `<img src="${esc(p.logoDataUrl)}" alt="" class="logo" />`
    : '<div class="logo-placeholder"></div>'

  function renderRows(rows: PdfRow[]): string {
    return rows
      .map(
        (r) => `<tr>
        <td class="col-date">${esc(r.date)}</td>
        <td class="col-time">${esc(r.startTime)}</td>
        <td class="col-time">${esc(r.stopTime)}</td>
        <td class="col-desc">${esc(r.description)}${r.reference ? `<div class="entry-ref">${esc(r.reference)}</div>` : ''}${r.projectName ? `<div class="entry-project">Projekt: ${esc(r.projectName)}</div>` : ''}</td>
        <td class="col-dur">${esc(formatHoursMinutes(r.minutes))}</td>
        ${showFee ? `<td class="col-fee">${esc(formatEur(r.feeCent ?? 0))}</td>` : ''}
      </tr>`
      )
      .join('\n')
  }

  let tableBody: string
  if (p.groups !== null && p.groups.length > 0) {
    // Grouped layout: each group gets a group-header row + data rows + subtotal.
    const groupSections = p.groups
      .map((g) => {
        const label = esc(g.label)
        const subtotalFee = showFee
          ? `<td class="col-fee">${esc(formatEur(g.totalFeeCent ?? 0))}</td>`
          : ''
        return `<tr class="group-header">
          <td colspan="${showFee ? 6 : 5}" class="col-group">${label}</td>
        </tr>
        ${renderRows(g.rows)}
        <tr class="subtotal">
          <td colspan="${showFee ? 4 : 4}">Zwischensumme ${label}</td>
          <td class="col-dur">${esc(formatHoursMinutes(g.totalMinutes))}</td>
          ${subtotalFee}
        </tr>`
      })
      .join('\n')

    const totalsRowGrouped = `<tr class="total">
        <td colspan="${showFee ? 4 : 4}">Gesamtsumme</td>
        <td class="col-dur">${esc(formatHoursMinutes(p.totals.minutes))}</td>
        ${showFee ? `<td class="col-fee">${esc(formatEur(p.totals.feeCent ?? 0))}</td>` : ''}
      </tr>`

    tableBody = groupSections + '\n' + totalsRowGrouped
  } else {
    const tableRows = renderRows(p.rows)
    const emptyState =
      p.rows.length === 0
        ? `<tr class="empty"><td colspan="${showFee ? 6 : 5}">Keine Einträge im gewählten Zeitraum.</td></tr>`
        : ''
    const totalsRow = `<tr class="total">
        <td colspan="${showFee ? 4 : 4}">Summe</td>
        <td class="col-dur">${esc(formatHoursMinutes(p.totals.minutes))}</td>
        ${showFee ? `<td class="col-fee">${esc(formatEur(p.totals.feeCent ?? 0))}</td>` : ''}
      </tr>`
    tableBody = tableRows + '\n' + emptyState + '\n' + totalsRow
  }

  // No visible rounding hint in the PDF: the recipient should never
  // notice that times were rounded. The displayed Von/Bis times are
  // already aligned with the rounded duration in `buildPdfPayload`,
  // so the row arithmetic is internally consistent.

  const footer = p.footerText ? `<div class="footer-text">${esc(p.footerText)}</div>` : ''

  // Signature lines are opt-in: most exports don't need them, and an
  // unsigned signature row at the end of an otherwise clean document
  // looks like a forgotten template.
  const signatureBlock = p.includeSignatures
    ? `<div class="signature-row">
      <div class="sig">Datum, Auftragnehmer</div>
      <div class="sig">Datum, Auftraggeber</div>
    </div>`
    : ''

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'" />
<title>Stundennachweis</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #0f172a;
    font-size: 10pt;
    line-height: 1.45;
  }
  .page { padding: 0; }
  header.doc-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 28px;
  }
  .logo { max-height: 60px; max-width: 180px; object-fit: contain; }
  .logo-placeholder { width: 1px; height: 60px; }
  .sender {
    text-align: right;
    font-size: 9pt;
    color: #334155;
  }
  .sender .name { font-weight: 600; color: #0f172a; }
  h1.doc-title {
    font-size: 18pt;
    font-weight: 600;
    margin: 0 0 4px 0;
    color: #0f172a;
  }
  .meta-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    margin-bottom: 18px;
    border-bottom: 2px solid ${accent};
    padding-bottom: 8px;
  }
  .recipient { font-size: 11pt; }
  .recipient .label { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 2px; }
  .recipient .name { font-weight: 600; }
  .recipient .project-label { font-size: 9pt; color: #475569; margin-top: 2px; }
  .range { font-size: 10pt; color: #334155; }
  .range .label { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; }
  .range .value { font-weight: 600; color: #0f172a; }
  table.entries {
    width: 100%;
    border-collapse: collapse;
    margin-top: 4px;
  }
  table.entries th {
    background: ${accent};
    color: #ffffff;
    font-weight: 600;
    text-align: left;
    padding: 7px 8px;
    font-size: 9pt;
  }
  table.entries td {
    padding: 6px 8px;
    border-bottom: 1px solid #e2e8f0;
    vertical-align: top;
    font-size: 10pt;
  }
  table.entries .col-date { white-space: nowrap; width: 76px; }
  table.entries .col-time { white-space: nowrap; width: 52px; text-align: right; }
  table.entries .col-desc { word-break: break-word; }
  table.entries .entry-ref { font-size: 8pt; color: #64748b; margin-top: 1px; }
  table.entries .entry-project { font-size: 8pt; color: #64748b; margin-top: 1px; font-style: italic; }
  table.entries .col-dur { white-space: nowrap; text-align: right; width: 60px; font-variant-numeric: tabular-nums; }
  table.entries .col-fee { white-space: nowrap; text-align: right; width: 84px; font-variant-numeric: tabular-nums; }
  table.entries tr.total td {
    border-top: 2px solid ${accent};
    border-bottom: none;
    font-weight: 700;
    font-size: 11pt;
    padding-top: 10px;
  }
  table.entries tr.empty td {
    text-align: center;
    color: #64748b;
    padding: 24px 8px;
    font-style: italic;
  }
  table.entries tr.group-header td.col-group {
    background: #f1f5f9;
    color: #334155;
    font-weight: 700;
    font-size: 9.5pt;
    border-top: 2px solid ${accent};
    border-bottom: none;
    padding: 6px 8px;
  }
  table.entries tr.subtotal td {
    border-top: 1px solid #cbd5e1;
    border-bottom: 2px solid ${accent};
    font-weight: 600;
    font-size: 10pt;
    color: #334155;
    padding: 5px 8px;
  }
  footer.doc-foot {
    margin-top: 36px;
    padding-top: 12px;
    border-top: 1px solid #e2e8f0;
    font-size: 8.5pt;
    color: #64748b;
  }
  footer.doc-foot .footer-text { white-space: pre-wrap; margin-bottom: 6px; color: #475569; }
  .signature-row {
    margin-top: 48px;
    display: flex;
    justify-content: space-between;
    gap: 48px;
  }
  .signature-row .sig {
    flex: 1;
    border-top: 1px solid #94a3b8;
    padding-top: 4px;
    font-size: 9pt;
    color: #475569;
    text-align: center;
  }
</style>
</head>
<body>
  <div class="page">
    <header class="doc-head">
      ${logoBlock}
      <div class="sender">
        <div class="name">${esc(p.sender.name)}</div>
        ${senderLines ? `<div>${senderLines}</div>` : ''}
        ${taxLine}
      </div>
    </header>

    <h1 class="doc-title">Stundennachweis</h1>

    <div class="meta-row">
      <div class="recipient">
        <div class="label">Kunde</div>
        <div class="name">${esc(p.client.name)}</div>
        ${[
          p.client.billing_address_line1,
          p.client.billing_address_line2,
          p.client.billing_address_line3,
          p.client.billing_address_line4
        ]
          .filter(Boolean)
          .map((l) => `<div>${esc(l as string)}</div>`)
          .join('\n        ')}
        ${p.client.vat_id ? `<div style="margin-top:2px;font-size:9pt;color:#475569;">USt-IdNr. ${esc(p.client.vat_id)}</div>` : ''}
        ${p.effectiveContactPerson ? `<div style="margin-top:2px;font-size:9pt;color:#475569;">z.Hd. ${esc(p.effectiveContactPerson)}</div>` : ''}
        ${p.projectName ? `<div class="project-label">Projekt: ${esc(p.projectName)}</div>` : ''}
      </div>
      <div class="range">
        <div class="label">Zeitraum</div>
        <div class="value">${esc(dateRange)}</div>
      </div>
    </div>

    <table class="entries">
      <thead>
        <tr>
          <th class="col-date">Datum</th>
          <th class="col-time">Von</th>
          <th class="col-time">Bis</th>
          <th class="col-desc">Tätigkeit</th>
          <th class="col-dur">Dauer</th>
          ${showFee ? '<th class="col-fee">Honorar</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${tableBody}
      </tbody>
    </table>

    ${signatureBlock}

    <footer class="doc-foot">
      ${footer}
      <div>Erstellt am ${esc(generated)} mit TimeTrack.</div>
    </footer>
  </div>
</body>
</html>`
}
