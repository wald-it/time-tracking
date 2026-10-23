/**
 * Hidden-window PDF renderer.
 *
 * Spawns an offscreen `BrowserWindow`, loads a self-contained HTML
 * string built by `buildPdfHtml()` via a one-shot temp file, calls
 * `webContents.printToPDF()`, writes the buffer to disk, and tears the
 * window down.
 *
 * Why a temp file instead of a `data:` URL: Electron's `loadURL` with
 * data: URLs has historically had flaky behaviour around CSP and
 * relative resource resolution. A `file://` URL to a temp HTML works
 * everywhere and the file is always cleaned up.
 *
 * Why no `webSecurity: false`: the logo is embedded as a base64 data:
 * URL inside the HTML before the window ever loads. The CSP meta tag
 * inside the template (`default-src 'none'; img-src data:`) blocks
 * any other network access by default — defence in depth even though
 * we control the HTML.
 */
import { BrowserWindow } from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { guardWindowLinks } from './externalLinks'

export interface RenderPdfOptions {
  /** Self-contained HTML string (from `buildPdfHtml`). */
  html: string
  /** A4 portrait by default — override only for tests. */
  pageSize?: 'A4' | 'A3' | 'Letter'
}

const PRINT_TIMEOUT_MS = 15_000

/**
 * Render `opts.html` to a PDF buffer using an offscreen Chromium window.
 * Throws on timeout or printToPDF failure. Always cleans up the temp
 * file and the BrowserWindow, even on failure.
 */
export async function renderPdfBuffer(opts: RenderPdfOptions): Promise<Buffer> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'tt-pdf-'))
  const htmlPath = join(tmpDir, 'document.html')
  writeFileSync(htmlPath, opts.html, 'utf8')
  const fileUrl = pathToFileURL(htmlPath).toString()

  const win = new BrowserWindow({
    show: false,
    width: 794, // approximate A4 at 96 DPI
    height: 1123,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // We deliberately keep webSecurity ON. Logo is base64-embedded; no
      // remote resources are needed.
      webSecurity: true
    }
  })

  // The document is our own HTML, but the window gets the same guards as the
  // app windows: no new windows, no navigation away, only web links outside.
  guardWindowLinks(win)

  try {
    const loaded = win.loadURL(fileUrl)
    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('PDF-Render Timeout (15 s)')), PRINT_TIMEOUT_MS)
    )
    await Promise.race([loaded, timer])

    const buffer = await Promise.race([
      win.webContents.printToPDF({
        pageSize: opts.pageSize ?? 'A4',
        printBackground: true,
        // printToPDF takes margins in inches. Electron 44 typed them on their
        // own (#269); the `marginType` key the shared print() type allowed
        // here was never read by printToPDF.
        margins: {
          top: 0.79, // ~2 cm in inches
          bottom: 0.79,
          left: 0.79,
          right: 0.79
        },
        landscape: false
      }),
      timer
    ])

    return buffer
  } finally {
    if (!win.isDestroyed()) win.destroy()
    rmSync(tmpDir, { recursive: true, force: true })
  }
}
