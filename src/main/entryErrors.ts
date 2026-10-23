/**
 * Why a write to an entry was refused (#296 part B): a code and its values,
 * no text and no language. The entry write path (entryMutations.ts) is shared
 * by the app, the calendar import and the MCP bridge, and each boundary words
 * the refusal itself: the IPC handlers and the import in the app language,
 * the MCP bridge in German (its replies are client API). mainI18n.entryErrorText
 * turns a code into text; the wording lives in the locale files as
 * `mainError.<code>`.
 *
 * The 2.0 write path (design doc docs/design/2.0-entry-lifecycle.md, #321)
 * can reuse these codes and add its own (a billed entry, a version mismatch).
 */
import type { IpcResult } from '../shared/types'

/** Every code, also at run time: a test checks each has a de and an en text. */
export const ENTRY_ERROR_CODES = [
  'entry.startInvalid',
  'entry.endInvalid',
  'entry.startInFuture',
  'entry.endBeforeStart',
  'entry.tooLong',
  'entry.descriptionTooLong',
  'entry.referenceTooLong',
  'entry.noteTooLong',
  'entry.clientMissing',
  'entry.projectNotOfClient',
  'entry.overlap',
  'entry.missing',
  'entry.splitEdge',
  'entry.splitGap',
  'entry.staleEdit',
  'entry.timerStartInFuture',
  'entry.startBeforeRunning'
] as const

export type EntryErrorCode = (typeof ENTRY_ERROR_CODES)[number]

export interface EntryError {
  code: EntryErrorCode
  /** Values the wording needs, e.g. `{ max: 500 }` for a length limit. */
  vars?: Record<string, string | number>
}

/** A result of the entry write path: the data, or the refusal as a code. */
export type EntryResult<T> = { ok: true; data: T } | { ok: false; error: EntryError }

export function entryError(code: EntryErrorCode, vars?: EntryError['vars']): EntryError {
  return vars ? { code, vars } : { code }
}

/** Turn an entry result into an IPC result, wording a refusal with `text`. */
export function toIpcResult<T>(res: EntryResult<T>, text: (e: EntryError) => string): IpcResult<T> {
  return res.ok ? res : { ok: false, error: text(res.error) }
}
