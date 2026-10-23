import { describe, it, expect, beforeAll } from 'vitest'
import { resolve } from 'path'
import { PDFDocument } from 'pdf-lib'
import { mergeExportHandler, mergeOnlyHandler, pdfInfoHandler } from './pdfMergeHandlers'
import type { FsDeps, DialogDeps, MergeExportPdfDeps } from './pdfMergeHandlers'
import type { PdfPayload } from './pdf'
import type { IpcResult } from '../shared/types'
import type Database from 'better-sqlite3'

function unwrapErr<T>(res: IpcResult<T>): string {
  if (!res.ok) return res.error
  throw new Error('Expected IpcResult to be error, got ok')
}

function unwrapData<T>(res: IpcResult<T>): T {
  if (res.ok) return res.data
  throw new Error(`Expected IpcResult to be ok, got error: ${res.error}`)
}

async function makeMinimalPdf(pageCount = 1): Promise<Buffer> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pageCount; i++) doc.addPage()
  return Buffer.from(await doc.save())
}

let pdf1: Buffer
let pdf2: Buffer
let pdf3page: Buffer

beforeAll(async () => {
  pdf1 = await makeMinimalPdf(1)
  pdf2 = await makeMinimalPdf(2)
  pdf3page = await makeMinimalPdf(3)
})

// Normalize keys via resolve() so forward-slash Windows paths ('C:/foo.pdf') match
// what the handler sees after its own resolve() call.
function mockFs(files: Record<string, Buffer | 'EBUSY' | 'EPERM'>): FsDeps {
  const norm: Record<string, Buffer | 'EBUSY' | 'EPERM'> = {}
  for (const [k, v] of Object.entries(files)) norm[resolve(k)] = v

  return {
    existsSync: (p) => p in norm,
    statSync: (p) => {
      const f = norm[p]
      if (!f || typeof f === 'string') return { size: 0 }
      return { size: f.length }
    },
    readFileSync: (p) => {
      const f = norm[p]
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (f === 'EBUSY') throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      if (f === 'EPERM') throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      return f
    },
    writeFileSync: () => {
      /* no-op by default; override per test */
    }
  }
}

/** The app language for the refusal texts: German, as these tests pin them. */
const de = (): 'de' => 'de'

const noDialog: DialogDeps = {
  // Electron liefert bei Abbruch einen leeren `filePath` (nicht undefined).
  showSaveDialog: async () => ({ canceled: true, filePath: '' }),
  locale: () => 'de'
}

// ── mergeOnlyHandler tests ────────────────────────────────────────────────────

describe('mergeOnlyHandler', () => {
  // #296 part B: refusals in the app language; German word for word as before.
  it('words its refusals in the language it is given', async () => {
    const req = { stundennachweisPaths: ['C:/sn1.pdf', 'C:/sn2.txt'], invoicePath: 'C:/inv.pdf' }
    const fs = mockFs({ 'C:/sn1.pdf': Buffer.from('x'), 'C:/inv.pdf': Buffer.from('x') })
    const de = await mergeOnlyHandler(req, fs, noDialog)
    expect(unwrapErr(de)).toBe('Stundennachweis 2: Die gewählte Datei ist keine PDF')
    const en = await mergeOnlyHandler(req, fs, { ...noDialog, locale: () => 'en' })
    expect(unwrapErr(en)).toBe('Timesheet 2: The chosen file is not a PDF')
    const inv = await mergeOnlyHandler(
      { stundennachweisPath: 'C:/sn1.pdf', invoicePath: 'C:/missing.pdf' },
      fs,
      noDialog
    )
    expect(unwrapErr(inv)).toBe('Rechnung: Datei nicht gefunden')
  })

  it('rejects null request', async () => {
    const res = await mergeOnlyHandler(null, mockFs({}), noDialog)
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/Pfade/)
  })

  it('rejects empty object', async () => {
    const res = await mergeOnlyHandler({}, mockFs({}), noDialog)
    expect(res.ok).toBe(false)
  })

  it('rejects non-pdf extension on SN path', async () => {
    const res = await mergeOnlyHandler(
      { stundennachweisPath: 'C:/file.txt', invoicePath: 'C:/inv.pdf' },
      mockFs({ 'C:/file.txt': pdf1, 'C:/inv.pdf': pdf2 }),
      noDialog
    )
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/keine PDF/)
  })

  it('rejects non-pdf extension on invoice path', async () => {
    const res = await mergeOnlyHandler(
      { stundennachweisPath: 'C:/sn.pdf', invoicePath: 'C:/inv.docx' },
      mockFs({ 'C:/sn.pdf': pdf1, 'C:/inv.docx': pdf2 }),
      noDialog
    )
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/keine PDF/)
  })

  it('rejects SN file over 50 MB', async () => {
    const bigFs: FsDeps = {
      existsSync: () => true,
      statSync: (p) => ({ size: p.includes('sn') ? 51 * 1024 * 1024 : 1024 }),
      readFileSync: () => pdf1,
      writeFileSync: () => {}
    }
    const res = await mergeOnlyHandler(
      { stundennachweisPath: 'C:/sn.pdf', invoicePath: 'C:/inv.pdf' },
      bigFs,
      noDialog
    )
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/zu groß/)
  })

  it('rejects invoice file over 50 MB', async () => {
    const bigFs: FsDeps = {
      existsSync: () => true,
      statSync: (p) => ({ size: p.includes('inv') ? 51 * 1024 * 1024 : 1024 }),
      readFileSync: () => pdf1,
      writeFileSync: () => {}
    }
    const res = await mergeOnlyHandler(
      { stundennachweisPath: 'C:/sn.pdf', invoicePath: 'C:/inv.pdf' },
      bigFs,
      noDialog
    )
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/zu groß/)
  })

  it('returns EBUSY error for locked SN file', async () => {
    const res = await mergeOnlyHandler(
      { stundennachweisPath: 'C:/sn.pdf', invoicePath: 'C:/inv.pdf' },
      mockFs({ 'C:/sn.pdf': 'EBUSY', 'C:/inv.pdf': pdf2 }),
      noDialog
    )
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/gesperrt/)
  })

  it('returns EBUSY error for locked invoice file', async () => {
    const res = await mergeOnlyHandler(
      { stundennachweisPath: 'C:/sn.pdf', invoicePath: 'C:/inv.pdf' },
      mockFs({ 'C:/sn.pdf': pdf1, 'C:/inv.pdf': 'EBUSY' }),
      noDialog
    )
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/gesperrt/)
  })

  it('happy path: merges two PDFs and returns output path', async () => {
    const written: Array<{ path: string; buf: Buffer }> = []
    const fs: FsDeps = {
      existsSync: (p) => p === resolve('C:/sn.pdf') || p === resolve('C:/inv.pdf'),
      statSync: () => ({ size: 1024 }),
      readFileSync: (p) => (p === resolve('C:/sn.pdf') ? pdf1 : pdf2),
      writeFileSync: (p, buf) => written.push({ path: p, buf })
    }
    const res = await mergeOnlyHandler(
      { stundennachweisPath: 'C:/sn.pdf', invoicePath: 'C:/inv.pdf' },
      fs,
      noDialog
    )
    expect(res.ok).toBe(true)
    expect(unwrapData(res).path).toContain('inkl_Stundennachweis')
    expect(written).toHaveLength(1)

    // Verify merged output has 3 pages (pdf2 = 2 + pdf1 = 1).
    const merged = await PDFDocument.load(written[0].buf)
    expect(merged.getPageCount()).toBe(3)
  })

  it('appends timestamp suffix when output file already exists', async () => {
    const written: string[] = []
    const fs: FsDeps = {
      existsSync: () => true, // all paths "exist", including the first output candidate
      statSync: () => ({ size: 1024 }),
      readFileSync: (p) => (p.includes('sn') ? pdf1 : pdf2),
      writeFileSync: (p) => written.push(p)
    }
    const res = await mergeOnlyHandler(
      { stundennachweisPath: 'C:/sn.pdf', invoicePath: 'C:/inv.pdf' },
      fs,
      noDialog
    )
    expect(res.ok).toBe(true)
    expect(unwrapData(res).path).toMatch(/inkl_Stundennachweis_\d{4}-\d{2}-\d{2}/)
  })

  it('falls back to save dialog on EPERM write error', async () => {
    const savedViaDialog: string[] = []
    const fs: FsDeps = {
      existsSync: (p) => p === resolve('C:/sn.pdf') || p === resolve('C:/inv.pdf'),
      statSync: () => ({ size: 1024 }),
      readFileSync: (p) => (p.includes('sn') ? pdf1 : pdf2),
      writeFileSync: (p) => {
        if (p.includes('inkl')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        savedViaDialog.push(p)
      }
    }
    const mockDialog: DialogDeps = {
      showSaveDialog: async () => ({ canceled: false, filePath: 'C:/fallback_merged.pdf' }),
      locale: () => 'de'
    }
    const res = await mergeOnlyHandler(
      { stundennachweisPath: 'C:/sn.pdf', invoicePath: 'C:/inv.pdf' },
      fs,
      mockDialog
    )
    expect(res.ok).toBe(true)
    expect(unwrapData(res).path).toBe('C:/fallback_merged.pdf')
  })

  it('returns error when save dialog is cancelled', async () => {
    const fs: FsDeps = {
      existsSync: (p) => p === resolve('C:/sn.pdf') || p === resolve('C:/inv.pdf'),
      statSync: () => ({ size: 1024 }),
      readFileSync: (p) => (p.includes('sn') ? pdf1 : pdf2),
      writeFileSync: () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      }
    }
    const res = await mergeOnlyHandler(
      { stundennachweisPath: 'C:/sn.pdf', invoicePath: 'C:/inv.pdf' },
      fs,
      noDialog
    )
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/abgebrochen/)
    // #296: the renderer acts on the code, not on the wording.
    expect(res).toMatchObject({ ok: false, code: 'cancelled' })
  })
})

// ── mergeOnlyHandler multi-SN tests (#119) ───────────────────────────────────

describe('mergeOnlyHandler — stundennachweisPaths (multi)', () => {
  it('rejects empty stundennachweisPaths array', async () => {
    const res = await mergeOnlyHandler(
      { stundennachweisPaths: [], invoicePath: 'C:/inv.pdf' },
      mockFs({ 'C:/inv.pdf': pdf1 }),
      noDialog
    )
    expect(res.ok).toBe(false)
  })

  it('rejects non-pdf extension on one of the SN paths', async () => {
    const res = await mergeOnlyHandler(
      { stundennachweisPaths: ['C:/sn1.pdf', 'C:/sn2.txt'], invoicePath: 'C:/inv.pdf' },
      mockFs({ 'C:/sn1.pdf': pdf1, 'C:/sn2.txt': pdf1, 'C:/inv.pdf': pdf2 }),
      noDialog
    )
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/keine PDF/)
  })

  it('happy path: merges invoice + multiple SNs in correct order', async () => {
    const written: Array<{ path: string; buf: Buffer }> = []
    const files: Record<string, Buffer> = {
      'C:/sn1.pdf': pdf1,
      'C:/sn2.pdf': pdf2,
      'C:/sn3.pdf': pdf3page,
      'C:/inv.pdf': pdf2
    }
    const norm: Record<string, Buffer> = {}
    for (const [k, v] of Object.entries(files)) norm[resolve(k)] = v
    const fs: FsDeps = {
      existsSync: (p) => p in norm,
      statSync: () => ({ size: 1024 }),
      readFileSync: (p) => norm[p],
      writeFileSync: (p, buf) => written.push({ path: p, buf })
    }
    const res = await mergeOnlyHandler(
      {
        stundennachweisPaths: ['C:/sn1.pdf', 'C:/sn2.pdf', 'C:/sn3.pdf'],
        invoicePath: 'C:/inv.pdf'
      },
      fs,
      noDialog
    )
    expect(res.ok).toBe(true)
    expect(written).toHaveLength(1)
    const merged = await PDFDocument.load(written[0].buf)
    // invoice (2) + sn1 (1) + sn2 (2) + sn3 (3) = 8
    expect(merged.getPageCount()).toBe(8)
  })

  it('returns EBUSY error if any SN file is locked', async () => {
    const res = await mergeOnlyHandler(
      { stundennachweisPaths: ['C:/sn1.pdf', 'C:/sn2.pdf'], invoicePath: 'C:/inv.pdf' },
      mockFs({ 'C:/sn1.pdf': pdf1, 'C:/sn2.pdf': 'EBUSY', 'C:/inv.pdf': pdf2 }),
      noDialog
    )
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/gesperrt/)
  })

  it('rejects SN file in array that is over 50 MB', async () => {
    const fs: FsDeps = {
      existsSync: () => true,
      statSync: (p) => ({ size: p.includes('sn2') ? 51 * 1024 * 1024 : 1024 }),
      readFileSync: () => pdf1,
      writeFileSync: () => {}
    }
    const res = await mergeOnlyHandler(
      { stundennachweisPaths: ['C:/sn1.pdf', 'C:/sn2.pdf'], invoicePath: 'C:/inv.pdf' },
      fs,
      noDialog
    )
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/zu groß/)
  })

  it('single-element stundennachweisPaths array works (equivalent to legacy)', async () => {
    const written: Buffer[] = []
    const fs: FsDeps = {
      existsSync: (p) => p === resolve('C:/sn.pdf') || p === resolve('C:/inv.pdf'),
      statSync: () => ({ size: 1024 }),
      readFileSync: (p) => (p === resolve('C:/sn.pdf') ? pdf1 : pdf2),
      writeFileSync: (_p, buf) => written.push(buf)
    }
    const res = await mergeOnlyHandler(
      { stundennachweisPaths: ['C:/sn.pdf'], invoicePath: 'C:/inv.pdf' },
      fs,
      noDialog
    )
    expect(res.ok).toBe(true)
    const merged = await PDFDocument.load(written[0])
    expect(merged.getPageCount()).toBe(3)
  })
})

// ── pdfInfoHandler tests ──────────────────────────────────────────────────────

describe('pdfInfoHandler', () => {
  it('rejects null request', async () => {
    const res = await pdfInfoHandler(null, mockFs({}), de)
    expect(res.ok).toBe(false)
  })

  it('rejects empty filePath', async () => {
    const res = await pdfInfoHandler({ filePath: '' }, mockFs({}), de)
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/Pfad/)
  })

  it('rejects non-pdf extension', async () => {
    const res = await pdfInfoHandler({ filePath: 'C:/doc.txt' }, mockFs({ 'C:/doc.txt': pdf1 }), de)
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/keine PDF/)
  })

  it('rejects file over 50 MB', async () => {
    const fs: FsDeps = {
      existsSync: () => true,
      statSync: () => ({ size: 51 * 1024 * 1024 }),
      readFileSync: () => pdf1,
      writeFileSync: () => {}
    }
    const res = await pdfInfoHandler({ filePath: 'C:/big.pdf' }, fs, de)
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/zu groß/)
  })

  it('returns EBUSY error for locked file', async () => {
    const res = await pdfInfoHandler(
      { filePath: 'C:/locked.pdf' },
      mockFs({ 'C:/locked.pdf': 'EBUSY' }),
      de
    )
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/gesperrt/)
  })

  it('returns error for corrupt PDF', async () => {
    const fs: FsDeps = {
      existsSync: () => true,
      statSync: () => ({ size: 100 }),
      readFileSync: () => Buffer.from('this is not a pdf'),
      writeFileSync: () => {}
    }
    const res = await pdfInfoHandler({ filePath: 'C:/corrupt.pdf' }, fs, de)
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/Ungültige|verschlüsselt/)
  })

  it('returns page count for valid 3-page PDF', async () => {
    const fs: FsDeps = {
      existsSync: () => true,
      statSync: () => ({ size: pdf3page.length }),
      readFileSync: () => pdf3page,
      writeFileSync: () => {}
    }
    const res = await pdfInfoHandler({ filePath: 'C:/three.pdf' }, fs, de)
    expect(res.ok).toBe(true)
    expect(unwrapData(res).pageCount).toBe(3)
  })
})

// ── mergeExportHandler tests ──────────────────────────────────────────────────
// Tests cover validation and FS error paths.
// The PDF rendering step (buildPdfPayload, buildPdfHtml, renderPdfBuffer) is
// injected via MergeExportPdfDeps so no Electron runtime is needed.

/** Minimal mock DB — returns empty settings rows. */
function mockDb(): Database.Database {
  return {
    prepare: () => ({ all: () => [] })
  } as unknown as Database.Database
}

/** Mock PdfDeps that returns provided SN buffer without actually rendering. */
function mockPdfDeps(snBuffer: Buffer, mergedBuffer: Buffer): MergeExportPdfDeps {
  return {
    readLogoAsDataUrl: () => '',
    // Throwaway payload: buildPdfHtml is mocked to ignore it, so the value is
    // never read — cast a bare object to the real type rather than build a full
    // PdfPayload just to satisfy the stub.
    buildPdfPayload: () => ({}) as unknown as PdfPayload,
    buildPdfHtml: () => '<html/>',
    renderPdfBuffer: async () => snBuffer,
    mergePdfs: async () => mergedBuffer
  }
}

const validReq = {
  clientId: 1,
  fromIso: '2026-01-01',
  toIso: '2026-01-31',
  invoicePath: 'C:/invoices/rechnung.pdf'
}

describe('mergeExportHandler — request validation', () => {
  it('rejects null request', async () => {
    const res = await mergeExportHandler(mockDb(), null, mockFs({}), noDialog)
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/PDF-Anfrage/)
  })

  it('rejects request with non-number clientId', async () => {
    const res = await mergeExportHandler(
      mockDb(),
      { clientId: '1', fromIso: '2026-01-01', toIso: '2026-01-31', invoicePath: 'C:/a.pdf' },
      mockFs({}),
      noDialog
    )
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/PDF-Anfrage/)
  })

  it('rejects missing invoicePath', async () => {
    const res = await mergeExportHandler(
      mockDb(),
      { clientId: 1, fromIso: '2026-01-01', toIso: '2026-01-31', invoicePath: '' },
      mockFs({}),
      noDialog
    )
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/Rechnungspfad/)
  })

  it('rejects non-pdf extension on invoicePath', async () => {
    const res = await mergeExportHandler(
      mockDb(),
      { ...validReq, invoicePath: 'C:/invoices/rechnung.docx' },
      mockFs({ 'C:/invoices/rechnung.docx': pdf1 }),
      noDialog
    )
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/keine PDF/)
  })

  it('rejects when invoice file not found', async () => {
    const res = await mergeExportHandler(mockDb(), validReq, mockFs({}), noDialog)
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/nicht gefunden/)
  })
})

describe('mergeExportHandler — file error paths', () => {
  it('rejects invoice over 50 MB', async () => {
    const bigFs: FsDeps = {
      existsSync: () => true,
      statSync: () => ({ size: 51 * 1024 * 1024 }),
      readFileSync: () => pdf1,
      writeFileSync: () => {}
    }
    const res = await mergeExportHandler(mockDb(), validReq, bigFs, noDialog)
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/zu groß/)
  })

  it('returns error for EBUSY locked invoice', async () => {
    const res = await mergeExportHandler(
      mockDb(),
      validReq,
      mockFs({ 'C:/invoices/rechnung.pdf': 'EBUSY' }),
      noDialog
    )
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/gesperrt/)
  })

  it('returns error for EPERM locked invoice', async () => {
    const res = await mergeExportHandler(
      mockDb(),
      validReq,
      mockFs({ 'C:/invoices/rechnung.pdf': 'EPERM' }),
      noDialog
    )
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/gesperrt/)
  })
})

describe('mergeExportHandler — successful merge', () => {
  it('writes merged PDF next to invoice and returns path', async () => {
    let written: { path: string; data: Buffer } | null = null
    const merged = await makeMinimalPdf(3)
    const fsDeps: FsDeps = {
      existsSync: (p) => p === resolve('C:/invoices/rechnung.pdf'),
      statSync: () => ({ size: pdf2.length }),
      readFileSync: (p) => {
        if (p === resolve('C:/invoices/rechnung.pdf')) return pdf2
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
      writeFileSync: (p, d) => {
        written = { path: p, data: d }
      }
    }
    const res = await mergeExportHandler(
      mockDb(),
      validReq,
      fsDeps,
      noDialog,
      mockPdfDeps(pdf1, merged)
    )
    expect(res.ok).toBe(true)
    expect(unwrapData(res).path).toMatch(/rechnung_inkl_Stundennachweis\.pdf$/)
    expect(written).not.toBeNull()
    expect(written!.data).toEqual(merged)
  })

  it('appends timestamp suffix when output file already exists', async () => {
    const merged = await makeMinimalPdf(2)
    const existingOutput = resolve('C:/invoices/rechnung_inkl_Stundennachweis.pdf')
    const writtenPaths: string[] = []
    const fsDeps: FsDeps = {
      existsSync: (p) => p === resolve('C:/invoices/rechnung.pdf') || p === existingOutput,
      statSync: () => ({ size: pdf1.length }),
      readFileSync: () => pdf1,
      writeFileSync: (p) => {
        writtenPaths.push(p)
      }
    }
    const res = await mergeExportHandler(
      mockDb(),
      validReq,
      fsDeps,
      noDialog,
      mockPdfDeps(pdf1, merged)
    )
    expect(res.ok).toBe(true)
    // Should NOT overwrite the existing output — timestamp suffix appended.
    expect(writtenPaths[0]).not.toBe(existingOutput)
    expect(writtenPaths[0]).toMatch(/rechnung_inkl_Stundennachweis_\d{4}-\d{2}-\d{2}/)
  })

  it('falls back to save dialog on EPERM write error', async () => {
    const merged = await makeMinimalPdf(1)
    const fallbackPath = resolve('C:/Desktop/merged.pdf')
    let firstWrite = true
    const fsDeps: FsDeps = {
      existsSync: (p) => p === resolve('C:/invoices/rechnung.pdf'),
      statSync: () => ({ size: pdf1.length }),
      readFileSync: () => pdf1,
      writeFileSync: () => {
        if (firstWrite) {
          firstWrite = false
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        }
      }
    }
    // #270/#296: the fallback dialog and the suggested name follow the language.
    const asked: Array<[string | undefined, string | undefined]> = []
    const dialogDeps: DialogDeps = {
      showSaveDialog: async (o) => {
        asked.push([o.title, o.defaultPath])
        return { canceled: false, filePath: fallbackPath }
      },
      locale: () => 'en'
    }
    const res = await mergeExportHandler(
      mockDb(),
      validReq,
      fsDeps,
      dialogDeps,
      mockPdfDeps(pdf1, merged)
    )
    expect(res.ok).toBe(true)
    expect(unwrapData(res).path).toBe(fallbackPath)
    expect(asked).toEqual([['Save merged PDF', 'rechnung_incl_Timesheet.pdf']])
  })

  it('returns error when dialog is canceled after EPERM', async () => {
    const merged = await makeMinimalPdf(1)
    const fsDeps: FsDeps = {
      existsSync: (p) => p === resolve('C:/invoices/rechnung.pdf'),
      statSync: () => ({ size: pdf1.length }),
      readFileSync: () => pdf1,
      writeFileSync: () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      }
    }
    const res = await mergeExportHandler(
      mockDb(),
      validReq,
      fsDeps,
      noDialog,
      mockPdfDeps(pdf1, merged)
    )
    expect(res.ok).toBe(false)
    expect(unwrapErr(res)).toMatch(/abgebrochen/)
    // #296: the renderer acts on the code, not on the wording.
    expect(res).toMatchObject({ ok: false, code: 'cancelled' })
  })
})
