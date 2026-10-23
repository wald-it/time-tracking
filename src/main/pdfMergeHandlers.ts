import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dialog } from 'electron'
import { join, parse, resolve } from 'path'
import { PDFDocument } from 'pdf-lib'
import log from 'electron-log/main'
import type Database from 'better-sqlite3'
import { mergePdfs, mergePdfsMulti } from './pdfMerge'
import { buildPdfPayload, buildPdfHtml } from './pdf'
import type { PdfPayload, PdfRequest } from './pdf'
import { renderPdfBuffer } from './pdfWindow'
import { readLogoAsDataUrl } from './logo'
import {
  validateMergeExportRequest,
  validateMergeOnlyRequest,
  validatePdfPath
} from './pdfMergeValidation'
import type { IpcResult, Settings } from '../shared/types'
import type { Locale } from '../shared/i18n'
import { cancelledResult, dialogT, mergedFileName } from './mainI18n'

const MAX_PDF_BYTES = 50 * 1024 * 1024 // 50 MB

/**
 * Node fs-Fehler tragen einen `code` (z. B. 'EBUSY', 'EPERM', 'EACCES'). Ein
 * `catch`-Wert ist in TS `unknown`; dieser Guard grenzt auf die tatsächliche
 * Node-Fehlerform ein, statt den Wert blind zu casten — so bleibt der
 * `code`-Zugriff typsicher.
 */
function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e
}

// ── Injectable deps (real implementations are the defaults) ──────────────────
// Injecting deps makes the core logic testable without an Electron runtime.

export interface FsDeps {
  existsSync: (path: string) => boolean
  statSync: (path: string) => { size: number }
  readFileSync: (path: string) => Buffer
  writeFileSync: (path: string, data: Buffer) => void
}

export interface DialogDeps {
  showSaveDialog: (opts: Electron.SaveDialogOptions) => Promise<Electron.SaveDialogReturnValue>
  /**
   * The language of the merged file's name (#296) and of the fallback
   * dialog's title (#270). Asked inside the handler's try, so a failing
   * settings read ends as an error result, never as a rejected call.
   */
  locale: () => Locale
}

/** The native save dialog; ipc.ts passes the app language as `locale`. */
export function saveDialogIn(locale: () => Locale): DialogDeps {
  return { showSaveDialog: (o) => dialog.showSaveDialog(o), locale }
}

export const realFsDeps: FsDeps = { existsSync, statSync, readFileSync, writeFileSync }

// ── pdf:merge-only handler ────────────────────────────────────────────────────

export interface MergeOnlyRequest {
  /** @deprecated v1.13 #119 — use stundennachweisPaths to support multi-SN merges. */
  stundennachweisPath?: string
  /** v1.13 #119: one or more Stundennachweis PDFs appended after the invoice, in order. */
  stundennachweisPaths?: string[]
  invoicePath: string
}

export async function mergeOnlyHandler(
  req: unknown,
  fsDeps: FsDeps,
  dialogDeps: DialogDeps
): Promise<IpcResult<{ path: string }>> {
  try {
    // Shape check — invoice + at least one SN path must be present.
    const shapeErr = validateMergeOnlyRequest(req)
    if (shapeErr) return { ok: false, error: shapeErr }

    const typed = req as MergeOnlyRequest
    // Normalize: prefer the new `stundennachweisPaths` array; fall back to the
    // single legacy field. Validation above already ensured at least one is set.
    const snPaths: string[] =
      typed.stundennachweisPaths && typed.stundennachweisPaths.length > 0
        ? typed.stundennachweisPaths
        : [typed.stundennachweisPath as string]
    const { invoicePath } = typed

    // Deep path validation: extension + existence for every SN + the invoice.
    for (let i = 0; i < snPaths.length; i++) {
      const err = validatePdfPath(snPaths[i], fsDeps.existsSync)
      if (err) {
        const label = snPaths.length === 1 ? 'Stundennachweis' : `Stundennachweis ${i + 1}`
        return { ok: false, error: `${label}: ${err}` }
      }
    }

    const invPathErr = validatePdfPath(invoicePath, fsDeps.existsSync)
    if (invPathErr) return { ok: false, error: `Rechnung: ${invPathErr}` }

    const resolvedSnPaths = snPaths.map((p) => resolve(p))
    const resolvedInv = resolve(invoicePath)

    // Size guard — reject before reading large files.
    for (let i = 0; i < resolvedSnPaths.length; i++) {
      if (fsDeps.statSync(resolvedSnPaths[i]).size > MAX_PDF_BYTES) {
        const label = snPaths.length === 1 ? 'Stundennachweis' : `Stundennachweis ${i + 1}`
        return { ok: false, error: `${label}-PDF zu groß (max. 50 MB)` }
      }
    }
    if (fsDeps.statSync(resolvedInv).size > MAX_PDF_BYTES) {
      return { ok: false, error: 'Rechnungs-PDF zu groß (max. 50 MB)' }
    }

    // Read all SN files — guard against locked files (Lexware / Acrobat open).
    const snBuffers: Buffer[] = []
    for (let i = 0; i < resolvedSnPaths.length; i++) {
      try {
        snBuffers.push(fsDeps.readFileSync(resolvedSnPaths[i]))
      } catch (e) {
        if (isErrnoException(e) && (e.code === 'EBUSY' || e.code === 'EPERM')) {
          const label = snPaths.length === 1 ? 'Stundennachweis' : `Stundennachweis ${i + 1}`
          return {
            ok: false,
            error: `${label} ist durch ein anderes Programm gesperrt: ${parse(resolvedSnPaths[i]).base}`
          }
        }
        return { ok: false, error: String(e) }
      }
    }

    let invBuffer: Buffer
    try {
      invBuffer = fsDeps.readFileSync(resolvedInv)
    } catch (e) {
      if (isErrnoException(e) && (e.code === 'EBUSY' || e.code === 'EPERM')) {
        return {
          ok: false,
          error: `Rechnung ist durch ein anderes Programm gesperrt: ${parse(resolvedInv).base}`
        }
      }
      return { ok: false, error: String(e) }
    }

    // Merge: invoice first, then each Stundennachweis in order.
    // Single-SN path keeps using mergePdfs to preserve the historical code path
    // (test coverage + identical output bytes for the v1.5 contract).
    const merged =
      snBuffers.length === 1
        ? await mergePdfs(snBuffers[0], invBuffer, 'append')
        : await mergePdfsMulti(invBuffer, snBuffers)
    log.debug('[pdf:merge-only] merged', {
      snCount: snBuffers.length,
      snBytes: snBuffers.reduce((s, b) => s + b.length, 0),
      invoiceBytes: invBuffer.length,
      mergedBytes: merged.length
    })

    // Derive output path next to the invoice. Append timestamp if file already exists.
    const { dir, name } = parse(resolvedInv)
    const locale = dialogDeps.locale()
    let outputPath = join(dir, mergedFileName(locale, name))
    if (fsDeps.existsSync(outputPath)) {
      const ts = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')
      outputPath = join(dir, mergedFileName(locale, name, ts))
    }

    try {
      fsDeps.writeFileSync(outputPath, merged)
      return { ok: true, data: { path: outputPath } }
    } catch (writeErr) {
      // Target directory is read-only — fall back to a user-chosen path.
      if (isErrnoException(writeErr) && (writeErr.code === 'EPERM' || writeErr.code === 'EACCES')) {
        const fallback = await dialogDeps.showSaveDialog({
          title: dialogT(locale)('mainDialog.pdf.mergeSaveTitle'),
          defaultPath: mergedFileName(locale, name),
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        })
        if (fallback.canceled || !fallback.filePath) {
          return cancelledResult(locale, 'mainError.saveCancelled')
        }
        fsDeps.writeFileSync(fallback.filePath, merged)
        return { ok: true, data: { path: fallback.filePath } }
      }
      return { ok: false, error: String(writeErr) }
    }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

// ── pdf:pdf-info handler ──────────────────────────────────────────────────────

export async function pdfInfoHandler(
  req: unknown,
  fsDeps: FsDeps = realFsDeps
): Promise<IpcResult<{ pageCount: number }>> {
  try {
    const r = req as Record<string, unknown> | null | undefined
    if (!r || !r.filePath) return { ok: false, error: 'Kein Pfad angegeben' }

    const pathErr = validatePdfPath(r.filePath as string, fsDeps.existsSync)
    if (pathErr) return { ok: false, error: pathErr }

    const resolved = resolve(r.filePath as string)

    if (fsDeps.statSync(resolved).size > MAX_PDF_BYTES) {
      return { ok: false, error: 'PDF zu groß (max. 50 MB)' }
    }

    let buf: Buffer
    try {
      buf = fsDeps.readFileSync(resolved)
    } catch (e) {
      if (isErrnoException(e) && (e.code === 'EBUSY' || e.code === 'EPERM')) {
        return {
          ok: false,
          error: `Datei ist durch ein anderes Programm gesperrt: ${parse(resolved).base}`
        }
      }
      return { ok: false, error: String(e) }
    }

    let doc: PDFDocument
    try {
      doc = await PDFDocument.load(buf)
    } catch {
      return { ok: false, error: 'Ungültige oder verschlüsselte PDF-Datei' }
    }

    return { ok: true, data: { pageCount: doc.getPageCount() } }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

// ── pdf:merge-export handler ──────────────────────────────────────────────────
// Re-renders the Stundennachweis from live DB data and merges it with an
// existing invoice PDF. Extracted from ipc.ts for testability.

export interface MergeExportPdfDeps {
  readLogoAsDataUrl: (absolutePath: string) => string
  buildPdfPayload: (db: Database.Database, req: PdfRequest, logoDataUrl: string) => PdfPayload
  buildPdfHtml: (payload: PdfPayload) => string
  renderPdfBuffer: (opts: { html: string }) => Promise<Buffer>
  mergePdfs: (sn: Buffer, invoice: Buffer, mode: 'append') => Promise<Buffer>
}

const realMergeExportPdfDeps: MergeExportPdfDeps = {
  readLogoAsDataUrl,
  buildPdfPayload,
  buildPdfHtml,
  renderPdfBuffer,
  mergePdfs
}

export async function mergeExportHandler(
  db: Database.Database,
  req: unknown,
  fsDeps: FsDeps,
  dialogDeps: DialogDeps,
  pdfDeps: MergeExportPdfDeps = realMergeExportPdfDeps
): Promise<IpcResult<{ path: string }>> {
  try {
    const reqErr = validateMergeExportRequest(req)
    if (reqErr) return { ok: false, error: reqErr }

    const typedReq = req as PdfRequest & { invoicePath: string }
    const pathErr = validatePdfPath(typedReq.invoicePath, fsDeps.existsSync)
    if (pathErr) return { ok: false, error: pathErr }

    const resolvedInvoice = resolve(typedReq.invoicePath)

    if (fsDeps.statSync(resolvedInvoice).size > MAX_PDF_BYTES) {
      return { ok: false, error: 'Rechnungs-PDF zu groß (max. 50 MB)' }
    }

    let invoiceBuffer: Buffer
    try {
      invoiceBuffer = fsDeps.readFileSync(resolvedInvoice)
    } catch (e) {
      if (isErrnoException(e) && (e.code === 'EBUSY' || e.code === 'EPERM')) {
        return {
          ok: false,
          error: `Datei ist durch ein anderes Programm gesperrt: ${parse(resolvedInvoice).base}`
        }
      }
      return { ok: false, error: String(e) }
    }

    const settingsRows = db.prepare(`SELECT key, value FROM settings`).all() as Array<{
      key: string
      value: string
    }>
    const settings = Object.fromEntries(
      settingsRows.map((r) => [r.key, r.value])
    ) as unknown as Settings

    const logoDataUrl = pdfDeps.readLogoAsDataUrl(settings.pdf_logo_path ?? '')
    const payload = pdfDeps.buildPdfPayload(db, typedReq, logoDataUrl)
    const snBuffer = await pdfDeps.renderPdfBuffer({ html: pdfDeps.buildPdfHtml(payload) })
    const merged = await pdfDeps.mergePdfs(snBuffer, invoiceBuffer, 'append')

    log.debug('[pdf:merge-export] merged', {
      invoiceBytes: invoiceBuffer.length,
      snBytes: snBuffer.length,
      mergedBytes: merged.length
    })

    const { dir, name } = parse(resolvedInvoice)
    const locale = dialogDeps.locale()
    let outputPath = join(dir, mergedFileName(locale, name))
    if (fsDeps.existsSync(outputPath)) {
      const ts = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')
      outputPath = join(dir, mergedFileName(locale, name, ts))
    }

    try {
      fsDeps.writeFileSync(outputPath, merged)
      return { ok: true, data: { path: outputPath } }
    } catch (writeErr) {
      // Target directory is read-only — fall back to a user-chosen path.
      if (isErrnoException(writeErr) && (writeErr.code === 'EPERM' || writeErr.code === 'EACCES')) {
        const fallback = await dialogDeps.showSaveDialog({
          title: dialogT(locale)('mainDialog.pdf.mergeSaveTitle'),
          defaultPath: mergedFileName(locale, name),
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        })
        if (fallback.canceled || !fallback.filePath) {
          return cancelledResult(locale, 'mainError.saveCancelled')
        }
        fsDeps.writeFileSync(fallback.filePath, merged)
        return { ok: true, data: { path: fallback.filePath } }
      }
      return { ok: false, error: String(writeErr) }
    }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}
