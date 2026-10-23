import { existsSync } from 'fs'
import { extname, resolve } from 'path'
import type { TranslationKey } from '../shared/locales/de'

const MAX_PDF_BYTES = 50 * 1024 * 1024 // 50 MB

/**
 * Why a merge request or file is refused: the locale key of the text, worded
 * by the handler in the app language (#296 part B). No text here.
 */
export type MergeProblem = Extract<TranslationKey, `mainError.merge.${string}`>

/**
 * Validates any PDF file path: non-empty, .pdf extension (case-insensitive), file exists.
 * Used for both invoice and Stundennachweis paths in merge handlers.
 *
 * The optional `existsFn` parameter allows injecting a mock for unit tests.
 * Callers that need the real filesystem omit it (defaults to existsSync).
 */
export function validatePdfPath(
  raw: string,
  existsFn: (p: string) => boolean = existsSync
): MergeProblem | null {
  if (!raw) return 'mainError.merge.noInvoicePath'
  const resolved = resolve(raw)
  if (extname(resolved).toLowerCase() !== '.pdf') return 'mainError.merge.notPdf'
  if (!existsFn(resolved)) return 'mainError.merge.notFound'
  return null
}

/**
 * Validates the size of a loaded PDF buffer (≤ 50 MB).
 */
export function validateInvoiceSize(buf: Buffer): MergeProblem | null {
  return buf.length > MAX_PDF_BYTES ? 'mainError.merge.invoiceTooBig' : null
}

/**
 * Validates the request shape for pdf:merge-export (re-render + merge).
 * Checks that clientId, fromIso, toIso, and invoicePath are present.
 */
export function validateMergeExportRequest(req: unknown): MergeProblem | null {
  const r = req as Record<string, unknown> | null | undefined
  if (!r || typeof r.clientId !== 'number' || !r.fromIso || !r.toIso) {
    return 'mainError.merge.badRequest'
  }
  if (!r.invoicePath) return 'mainError.merge.noInvoicePath'
  return null
}

/**
 * Validates the request shape for pdf:merge-only (merge existing PDFs).
 *
 * Two shapes accepted (v1.13 #119):
 *  - Legacy:  `{ stundennachweisPath: string, invoicePath: string }`
 *  - Multi:   `{ stundennachweisPaths: string[], invoicePath: string }` with ≥1 path
 *
 * Both fields may also be present together; in that case `stundennachweisPaths`
 * takes precedence (callers should send only one shape).
 */
export function validateMergeOnlyRequest(req: unknown): MergeProblem | null {
  const r = req as Record<string, unknown> | null | undefined
  if (!r || !r.invoicePath) {
    return 'mainError.merge.bothRequired'
  }
  if (Array.isArray(r.stundennachweisPaths)) {
    if (r.stundennachweisPaths.length === 0) {
      return 'mainError.merge.timesheetRequired'
    }
    if (!r.stundennachweisPaths.every((p) => typeof p === 'string' && p.length > 0)) {
      return 'mainError.merge.timesheetPathInvalid'
    }
    return null
  }
  if (!r.stundennachweisPath) {
    return 'mainError.merge.bothRequired'
  }
  return null
}
