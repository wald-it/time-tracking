import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import {
  buildPdfHtml,
  buildPdfPayloadFromData,
  readPdfSourceContext,
  type PdfRequest,
  type PdfSourceContext,
  type PdfSourceRow
} from './pdf'

type Db = Database.Database
export interface BillingRun {
  id: number
  number: string
  client_id: number
  project_id: number | null
  period_from: string
  period_to: string
  created_at: string
  status: 'active' | 'released'
  released_at: string | null
  release_reason: string | null
  replaces_run_id: number | null
  invoice_ref: string
  rule_snapshot: string
  html_sha256: string
  pdf_sha256: string
}
interface Item {
  entry_id: number
  version_id: number
  seq: number
  segment_date: string
  billed_minutes: number
  rate_cent: number
  fee_cent: number
}
interface Source extends Item {
  project_id: number | null
  started_at: string
  stopped_at: string
  description: string
  tags: string
  reference: string
}
const PROFILE_FIELDS = [
  'interval_min',
  'min_unit_min',
  'alignment',
  'columns',
  'language',
  'fee_column',
  'group_by'
] as const
type Profile = Record<(typeof PROFILE_FIELDS)[number], string | number>
interface Snapshot {
  snapshot_version: 1
  appVersion: string
  context: PdfSourceContext
  options: PdfRequest
  clientProfile: Profile
  projectProfiles: Record<string, Profile>
  projectNames: Record<string, string>
  rateIsProject: Record<string, number>
}
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')

function getRun(db: Db, runId: number): BillingRun {
  const run = db.prepare('SELECT * FROM billing_run WHERE id = ?').get(runId) as
    | BillingRun
    | undefined
  if (!run) throw new Error('Abrechnungslauf nicht gefunden')
  return run
}
export function listRuns(db: Db, clientId?: number): BillingRun[] {
  return db
    .prepare('SELECT * FROM billing_run WHERE (? IS NULL OR client_id = ?) ORDER BY id DESC')
    .all(clientId ?? null, clientId ?? null) as BillingRun[]
}

function resolvedProfile(db: Db, clientId: number, projectId: number | null): Profile {
  return db
    .prepare(
      `SELECT ${PROFILE_FIELDS.map((f) => `COALESCE(p.${f}, c.${f}, d.${f}) AS "${f}"`).join(', ')}
    FROM billing_profile d
    LEFT JOIN billing_profile c ON c.client_id = ?
    LEFT JOIN billing_profile p ON p.project_id = ?
    WHERE d.client_id IS NULL AND d.project_id IS NULL`
    )
    .get(clientId, projectId) as Profile
}

function runHtml(
  run: Pick<BillingRun, 'number' | 'created_at' | 'rule_snapshot'>,
  rows: Source[]
): string {
  const snapshot = JSON.parse(run.rule_snapshot) as Snapshot
  if (snapshot.snapshot_version !== 1) throw new Error('Unbekannte Abrechnungssnapshot-Version')
  const source: PdfSourceRow[] = rows.map((row) => {
    const profile =
      (row.project_id === null ? undefined : snapshot.projectProfiles[row.project_id]) ??
      snapshot.clientProfile
    return {
      id: row.entry_id,
      started_at: row.started_at,
      stopped_at: row.stopped_at,
      segment_date: row.segment_date,
      description: row.description,
      tags: row.tags,
      reference: row.reference,
      billed_minutes: row.billed_minutes,
      line_rate_cent: row.rate_cent,
      fee_cent: row.fee_cent,
      rate_is_project: snapshot.rateIsProject[row.version_id + ':' + row.seq],
      interval_min: Number(profile.interval_min),
      alignment: profile.alignment as 'none' | 'grid',
      project_name: row.project_id === null ? null : (snapshot.projectNames[row.project_id] ?? null)
    }
  })
  return buildPdfHtml(
    buildPdfPayloadFromData(
      { ...snapshot.context, runNumber: run.number, generatedAtIso: run.created_at },
      snapshot.options,
      source
    )
  )
}

/** Rebuild solely from archived rules and the exact billed versions, never from live readers. */
export function renderRunHtml(db: Db, runId: number): string {
  const run = getRun(db, runId)
  const rows = db
    .prepare(
      `SELECT i.*, v.project_id, v.description, v.tags, v.reference,
      s.started_at, s.stopped_at
    FROM billing_run_item i
    JOIN entry_version v ON v.id = i.version_id
    JOIN entry_segment s ON s.version_id = i.version_id AND s.seq = i.seq
    WHERE i.run_id = ? ORDER BY s.started_at, i.entry_id, i.seq`
    )
    .all(runId) as Source[]
  return runHtml(run, rows)
}

export function verifyRunHtml(db: Db, runId: number): boolean {
  return sha256(renderRunHtml(db, runId)) === getRun(db, runId).html_sha256
}

function validDay(day: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(day)) &&
    new Date(day).toISOString().slice(0, 10) === day
  )
}
function validateReplacement(db: Db, req: PdfRequest): void {
  if (req.replacesRunId === undefined) return
  const old = getRun(db, req.replacesRunId)
  if (old.status !== 'released') throw new Error('Der ersetzte Lauf muss gelöst sein')
  if (old.client_id !== req.clientId)
    throw new Error('Der ersetzte Lauf muss zum selben Kunden gehören')
}
function nextNumber(db: Db, prefix: string): string {
  const rows = db
    .prepare('SELECT number FROM billing_run WHERE number LIKE ?')
    .all(prefix + '%') as Array<{ number: string }>
  const highest = rows.reduce((n, r) => Math.max(n, Number(r.number.slice(prefix.length)) || 0), 0)
  return prefix + String(highest + 1).padStart(2, '0')
}

/**
 * No transaction crosses the renderer await. Prepare once, then recheck versions,
 * number and segment locks in one immediate transaction before storing all three tables.
 */
export async function createRun(
  db: Db,
  req: PdfRequest,
  renderPdf: (html: string) => Promise<Buffer>,
  options: { logoDataUrl?: string; appVersion?: string } = {}
): Promise<BillingRun & { excludedCount: number }> {
  req = { ...req }
  if (!validDay(req.fromIso) || !validDay(req.toIso) || req.fromIso > req.toIso) {
    throw new Error('Ungültiger Abrechnungszeitraum')
  }
  const prepared = db
    .transaction(() => {
      const client = db.prepare('SELECT short_code FROM clients WHERE id = ?').get(req.clientId) as
        | { short_code: string | null }
        | undefined
      if (!client) throw new Error('Kunde nicht gefunden')
      if (!client.short_code) throw new Error('Für diesen Kunden fehlt der Kurzcode')
      if (
        req.projectId != null &&
        !db
          .prepare('SELECT 1 FROM projects WHERE id = ? AND client_id = ?')
          .get(req.projectId, req.clientId)
      ) {
        throw new Error('Projekt gehört nicht zum Kunden')
      }
      validateReplacement(db, req)
      const candidates = db
        .prepare(
          `SELECT l.entry_id, l.version_id, l.segment_seq AS seq, l.segment_date,
        l.billed_minutes, l.rate_cent, l.fee_cent, l.project_id, l.rate_is_project, l.billed_run_id,
        v.description, v.tags, v.reference, l.started_at, l.stopped_at
      FROM billing_lines l JOIN entry_version v ON v.id = l.version_id
      WHERE l.client_id = ? AND l.stopped_at IS NOT NULL AND l.billable = 1
        AND l.segment_date BETWEEN ? AND ?
        AND (? IS NULL OR l.project_id = ?)
      ORDER BY l.started_at, l.entry_id, l.segment_seq`
        )
        .all(
          req.clientId,
          req.fromIso,
          req.toIso,
          req.projectId ?? null,
          req.projectId ?? null
        ) as Array<Source & { rate_is_project: number; billed_run_id: number | null }>
      const rows = candidates.filter((r) => r.billed_run_id === null)
      if (!rows.length) {
        throw new Error(
          `Keine unabgerechneten Segmente im Zeitraum (${candidates.length} bereits abgerechnete Segmente ausgeschlossen)`
        )
      }
      const createdAt = new Date().toISOString()
      const snapshot: Snapshot = {
        snapshot_version: 1,
        appVersion: options.appVersion ?? '',
        context: readPdfSourceContext(db, req, options.logoDataUrl ?? '', createdAt),
        options: {
          clientId: req.clientId,
          fromIso: req.fromIso,
          toIso: req.toIso,
          projectId: req.projectId,
          groupBy: req.groupBy,
          groupByTag: req.groupByTag,
          hideFeeColumn: req.hideFeeColumn,
          includeSignatures: req.includeSignatures
        },
        clientProfile: resolvedProfile(db, req.clientId, null),
        projectProfiles: {},
        projectNames: {},
        rateIsProject: {}
      }
      for (const row of rows) {
        snapshot.rateIsProject[row.version_id + ':' + row.seq] = row.rate_is_project
        if (row.project_id !== null && snapshot.projectNames[row.project_id] === undefined) {
          const project = db
            .prepare('SELECT name FROM projects WHERE id = ?')
            .get(row.project_id) as { name: string }
          snapshot.projectNames[row.project_id] = project.name
          const override = db
            .prepare(
              `SELECT 1 FROM billing_profile WHERE project_id = ? AND (${PROFILE_FIELDS.map((f) => `"${f}" IS NOT NULL`).join(' OR ')})`
            )
            .get(row.project_id)
          if (override)
            snapshot.projectProfiles[row.project_id] = resolvedProfile(
              db,
              req.clientId,
              row.project_id
            )
        }
      }
      const prefix = 'SN-' + req.fromIso.slice(0, 7) + '-' + client.short_code + '-'
      const run = {
        number: nextNumber(db, prefix),
        client_id: req.clientId,
        project_id: req.projectId ?? null,
        period_from: req.fromIso,
        period_to: req.toIso,
        created_at: createdAt,
        status: 'active' as const,
        released_at: null,
        release_reason: null,
        replaces_run_id: req.replacesRunId ?? null,
        invoice_ref: '',
        rule_snapshot: JSON.stringify(snapshot)
      }
      return { rows, run, prefix, excludedCount: candidates.length - rows.length }
    })
    .deferred()
  const html = runHtml(prepared.run, prepared.rows)
  const bytes = await renderPdf(html)
  const htmlHash = sha256(html),
    pdfHash = sha256(bytes)
  return db
    .transaction(() => {
      if (nextNumber(db, prepared.prefix) !== prepared.run.number)
        throw new Error('Die Laufnummer wurde inzwischen vergeben. Export erneut starten.')
      validateReplacement(db, req)
      for (const row of prepared.rows) {
        const current = db
          .prepare('SELECT current_version_id, is_deleted FROM entry WHERE id = ?')
          .get(row.entry_id) as { current_version_id: number; is_deleted: number }
        if (
          current.is_deleted ||
          current.current_version_id !== row.version_id ||
          db
            .prepare(
              'SELECT 1 FROM billing_run_item WHERE entry_id = ? AND segment_date = ? AND active = 1'
            )
            .get(row.entry_id, row.segment_date)
        ) {
          throw new Error(
            'Die ausgewählten Segmente wurden inzwischen geändert oder abgerechnet. Export erneut starten.'
          )
        }
      }
      const id = Number(
        db
          .prepare(
            `INSERT INTO billing_run
      (number, client_id, project_id, period_from, period_to, created_at, status, replaces_run_id, rule_snapshot, html_sha256, pdf_sha256)
      VALUES (@number, @client_id, @project_id, @period_from, @period_to, @created_at, @status, @replaces_run_id, @rule_snapshot, @html_sha256, @pdf_sha256)`
          )
          .run({ ...prepared.run, html_sha256: htmlHash, pdf_sha256: pdfHash }).lastInsertRowid
      )
      const insert = db.prepare(`INSERT INTO billing_run_item
      (run_id, entry_id, version_id, seq, segment_date, billed_minutes, rate_cent, fee_cent, active)
      VALUES (@run_id, @entry_id, @version_id, @seq, @segment_date, @billed_minutes, @rate_cent, @fee_cent, 1)`)
      for (const row of prepared.rows) insert.run({ ...row, run_id: id })
      // This exact public renderer also constructs the stored run's HTML.
      if (sha256(renderRunHtml(db, id)) !== htmlHash)
        throw new Error('Der HTML-Snapshot stimmt nicht überein')
      db.prepare(
        "INSERT INTO billing_run_document (run_id, kind, bytes, sha256) VALUES (?, 'pdf', ?, ?)"
      ).run(id, bytes, pdfHash)
      return { ...getRun(db, id), excludedCount: prepared.excludedCount }
    })
    .immediate()
}

export function releaseRun(db: Db, runId: number, reason: string): void {
  if (!reason?.trim()) throw new Error('Ein Grund zum Lösen ist erforderlich')
  db.transaction(() => {
    if (getRun(db, runId).status !== 'active') throw new Error('Der Lauf ist bereits gelöst')
    db.prepare(
      "UPDATE billing_run SET status = 'released', released_at = ?, release_reason = ? WHERE id = ?"
    ).run(new Date().toISOString(), reason.trim(), runId)
    db.prepare('UPDATE billing_run_item SET active = 0 WHERE run_id = ?').run(runId)
  }).immediate()
}

export function setInvoiceRef(db: Db, runId: number, ref: string): void {
  getRun(db, runId)
  db.prepare('UPDATE billing_run SET invoice_ref = ? WHERE id = ?').run(ref, runId)
}

/** Reopening always returns the archive, including for released runs. */
export function openRunPdf(db: Db, runId: number): Buffer {
  const run = getRun(db, runId)
  const document = db
    .prepare("SELECT bytes, sha256 FROM billing_run_document WHERE run_id = ? AND kind = 'pdf'")
    .get(runId) as { bytes: Buffer; sha256: string } | undefined
  if (
    !document ||
    sha256(document.bytes) !== run.pdf_sha256 ||
    document.sha256 !== run.pdf_sha256
  ) {
    throw new Error('SHA-256 des archivierten PDFs stimmt nicht überein')
  }
  return document.bytes
}
