/**
 * Logo storage helpers for the PDF template.
 *
 * The logo lives in `app.getPath('userData')` under a stable filename
 * (`pdf-logo.<ext>`), so it survives app upgrades along with the SQLite
 * database. The settings table holds the absolute path; PDF rendering
 * loads the bytes and embeds them as a data: URL — that's why the PDF
 * pipeline doesn't need `webSecurity: false`.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, statSync } from 'fs'
import { dirname, extname, join } from 'path'

export const MAX_LOGO_BYTES = 1024 * 1024 // 1 MB — keeps PDFs lean and the data: URL manageable

const ALLOWED_EXTS = ['.png', '.jpg', '.jpeg', '.svg', '.webp'] as const
type AllowedExt = (typeof ALLOWED_EXTS)[number]

const MIME_BY_EXT: Record<AllowedExt, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
}

/**
 * A logo that cannot be used: the locale key of the reason and its values,
 * worded by the IPC handler in the app language (#296 part B).
 */
export class LogoError extends Error {
  constructor(
    readonly key: 'mainError.logo.format' | 'mainError.logo.formatNone' | 'mainError.logo.tooBig',
    readonly vars: Record<string, string | number> = {}
  ) {
    super(key)
    this.name = 'LogoError'
  }
}

function normaliseExt(filename: string): AllowedExt {
  const ext = extname(filename).toLowerCase() as AllowedExt
  if (!ALLOWED_EXTS.includes(ext)) {
    throw ext
      ? new LogoError('mainError.logo.format', { ext })
      : new LogoError('mainError.logo.formatNone')
  }
  return ext
}

/**
 * Copy a user-picked logo file into `userData/pdf-logo.<ext>`. Returns
 * the new absolute path so the caller can persist it in
 * `settings.pdf_logo_path`. Validates size + extension; cleans up any
 * previously stored logo (including ones with a different extension).
 */
export function saveLogo(sourcePath: string, userDataDir: string): string {
  const stat = statSync(sourcePath)
  if (stat.size > MAX_LOGO_BYTES) {
    throw new LogoError('mainError.logo.tooBig', { kb: (stat.size / 1024).toFixed(0) })
  }
  const ext = normaliseExt(sourcePath)
  removeLogo(userDataDir)
  if (!existsSync(userDataDir)) {
    mkdirSync(userDataDir, { recursive: true })
  }
  const targetPath = join(userDataDir, `pdf-logo${ext}`)
  const buf = readFileSync(sourcePath)
  writeFileSync(targetPath, buf)
  return targetPath
}

/** Delete every `pdf-logo.*` file under `userDataDir`. Idempotent. */
export function removeLogo(userDataDir: string): void {
  if (!existsSync(userDataDir)) return
  for (const ext of ALLOWED_EXTS) {
    const candidate = join(userDataDir, `pdf-logo${ext}`)
    if (existsSync(candidate)) {
      try {
        unlinkSync(candidate)
      } catch {
        // Best effort — failing to delete an old logo shouldn't block a new upload.
      }
    }
  }
}

/**
 * Read a stored logo and produce a `data:image/...;base64,...` URL for
 * inline embedding in the PDF HTML. Returns the empty string when the
 * path is empty, missing, or unreadable — the template gracefully omits
 * the logo block in that case.
 */
export function readLogoAsDataUrl(absolutePath: string): string {
  if (!absolutePath) return ''
  if (!existsSync(absolutePath)) return ''
  let ext: AllowedExt
  try {
    ext = normaliseExt(absolutePath)
  } catch {
    return ''
  }
  try {
    const buf = readFileSync(absolutePath)
    if (buf.length > MAX_LOGO_BYTES) return ''
    return `data:${MIME_BY_EXT[ext]};base64,${buf.toString('base64')}`
  } catch {
    return ''
  }
}

/** Exposed for tests: which directory will `saveLogo` write into for a given userData. */
export function logoDirFor(absolutePath: string): string {
  return dirname(absolutePath)
}
