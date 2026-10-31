/**
 * CSV export IPC handler (v1.5 PR C, issue #18).
 *
 * Wires the shared `formatCsv` formatter to the main-process IPC layer:
 * - queries DB for entries in the given date range + client
 * - opens a Save dialog
 * - writes the UTF-8+BOM CSV to the user-chosen path
 *
 * Kept separate from ipc.ts to mirror the pattern used by pdf.ts /
 * jsonExport.ts — easier to unit-test in isolation.
 */
import { app, dialog } from 'electron'
import { writeFileSync } from 'fs'
import type Database from 'better-sqlite3'
import { formatCsv, formatDayGridCsv, type CsvOptions } from '../shared/csv'
import type { ReviewSelection } from '../shared/billingPreview'
import { buildBillingPreview } from './billingPreview'
import { validateRuleCheckRequest } from './ruleCheck'
import type { Client, IpcResult } from '../shared/types'
import { exportEntries } from './entryRanges'
import { appLocale, cancelledResult, dialogT, exportFileName } from './mainI18n'
import { exportDefaultPath, rememberExportFolder } from './exportFolders'
import { normalizeInvoiceRef } from './invoiceRef'

export interface CsvRequest {
  invoiceRef?: string
  clientId: number
  /** ISO-date strings, inclusive: '2026-04-01' to '2026-04-30'. */
  fromIso: string
  toIso: string
  /** DE = ';' / ',' (default), US = ',' / '.' */
  format?: 'de' | 'us'
  /** When true, entries are grouped by their first tag with subtotal rows. Default: false. */
  groupByTag?: boolean
  /**
   * v1.9 #75: optional project filter. When set, only entries with this
   * project_id are included. undefined / null = all projects.
   */
  projectId?: number | null
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function fail(e: unknown): IpcResult<never> {
  return { ok: false, error: e instanceof Error ? e.message : String(e) }
}

export async function handleDayGridExport(
  db: Database.Database,
  req: ReviewSelection
): Promise<IpcResult<{ path: string }>> {
  try {
    validateRuleCheckRequest(req)
    const client = db.prepare('SELECT name FROM clients WHERE id = ?').get(req.clientId) as
      | { name: string }
      | undefined
    if (!client) return fail(`Kunde ${req.clientId} nicht gefunden`)
    const project =
      req.projectId == null
        ? undefined
        : (db
            .prepare('SELECT name FROM projects WHERE id = ? AND client_id = ?')
            .get(req.projectId, req.clientId) as { name: string } | undefined)
    if (req.projectId != null && !project) return fail('Projekt gehört nicht zum Kunden')
    const dayGrid = buildBillingPreview(db, req).dayGrid
    const locale = appLocale(
      () => db,
      () => app.getPreferredSystemLanguages()
    )
    const result = await dialog.showSaveDialog({
      title: dialogT(locale)('mainDialog.dayGrid.title'),
      defaultPath: await exportDefaultPath(
        db,
        'csv',
        exportFileName(locale, 'dayGrid', {
          client: client.name,
          project: project?.name,
          month: req.fromIso.slice(0, 7)
        })
      ),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath)
      return cancelledResult(locale, 'mainError.exportCancelled')
    const csv = formatDayGridCsv(
      dayGrid,
      locale === 'en'
        ? { language: 'en', fieldSeparator: ',', decimalSeparator: '.' }
        : { language: 'de' }
    )
    writeFileSync(result.filePath, csv, 'utf8')
    rememberExportFolder(db, 'csv', result.filePath)
    return ok({ path: result.filePath })
  } catch (e) {
    return fail(e)
  }
}

export async function handleCsvExport(
  db: Database.Database,
  req: CsvRequest
): Promise<IpcResult<{ path: string }>> {
  try {
    if (!req || typeof req.clientId !== 'number' || !req.fromIso || !req.toIso) {
      return fail('Ungültige CSV-Anfrage')
    }

    const invoiceRef = normalizeInvoiceRef(req.invoiceRef)
    const client = db
      .prepare(`SELECT id, name, color, active, rate_cent, created_at FROM clients WHERE id = ?`)
      .get(req.clientId) as Client | undefined
    if (!client) return fail(`Kunde ${req.clientId} nicht gefunden`)

    const entries = exportEntries(db, req)

    // When filtered by project, the project name goes into the file name.
    const proj =
      req.projectId != null
        ? (db.prepare(`SELECT name FROM projects WHERE id = ?`).get(req.projectId) as
            | { name: string }
            | undefined)
        : undefined

    const locale = appLocale(
      () => db,
      () => app.getPreferredSystemLanguages()
    )
    const result = await dialog.showSaveDialog({
      title: dialogT(locale)('mainDialog.csv.title'),
      defaultPath: await exportDefaultPath(
        db,
        'csv',
        exportFileName(locale, 'csv', {
          client: client.name,
          project: proj?.name ?? null,
          month: req.fromIso.slice(0, 7),
          invoiceRef
        })
      ),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath) {
      return cancelledResult(locale, 'mainError.exportCancelled')
    }

    // Amounts follow the invoice rule: the money columns of exportEntries.
    const opts: CsvOptions =
      req.format === 'us'
        ? { fieldSeparator: ',', decimalSeparator: '.', groupByTag: req.groupByTag }
        : { fieldSeparator: ';', decimalSeparator: ',', groupByTag: req.groupByTag }

    const profile = db
      .prepare(
        `SELECT COALESCE(p.language, c.language, d.language) AS language
      FROM billing_profile d
      LEFT JOIN billing_profile c ON c.client_id = ?
      LEFT JOIN billing_profile p ON p.project_id = ?
      WHERE d.client_id IS NULL AND d.project_id IS NULL`
      )
      .get(req.clientId, req.projectId ?? null) as { language: 'de' | 'en' }
    opts.language = profile.language

    const clientMap = new Map([[client.id, client]])
    const csv = formatCsv(entries, clientMap, opts)

    writeFileSync(result.filePath, csv, 'utf8')
    rememberExportFolder(db, 'csv', result.filePath)
    return ok({ path: result.filePath })
  } catch (e) {
    return fail(e)
  }
}
