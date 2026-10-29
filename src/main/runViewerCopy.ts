/**
 * Viewer copies of archived billing-run PDFs (P6b).
 *
 * The system PDF viewer needs a file on disk. Every copy lands in one fixed
 * folder under the OS temp directory, so customer data does not pile up in a
 * fresh folder per click. Copies older than a day (left by earlier sessions or
 * still locked by a viewer at the time) are removed at app start and before each new write.
 * Deletion failures are swallowed: an open viewer may hold the file.
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

export const VIEWER_COPY_DIR = 'timetrack-runs'
const MAX_AGE_MS = 24 * 60 * 60 * 1000
let copyCount = 0

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // Locked by a viewer; the next prune retries.
  }
}

export function pruneViewerCopies(tempRoot: string, now = Date.now()): void {
  const dir = join(tempRoot, VIEWER_COPY_DIR)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs > MAX_AGE_MS) removeQuietly(path)
    } catch {
      // Vanished in between.
    }
  }
}

/** Removes old copies without letting a cleanup failure interrupt app startup. */
export function pruneViewerCopiesAtStart(tempRoot: string, now?: number): void {
  try {
    pruneViewerCopies(tempRoot, now)
  } catch {
    // Cleanup must never prevent the app from starting.
  }
}

/** Writes a fresh copy and returns its path. Unique per call, so a copy a viewer still holds is never overwritten. */
export function writeViewerCopy(tempRoot: string, runId: number, bytes: Buffer): string {
  pruneViewerCopies(tempRoot)
  const dir = join(tempRoot, VIEWER_COPY_DIR)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `run-${runId}-${Date.now()}-${process.pid}-${++copyCount}.pdf`)
  writeFileSync(path, bytes)
  return path
}

export function discardViewerCopy(path: string): void {
  removeQuietly(path)
}
