/**
 * Texts of the native dialogs the main process shows (#270). They come from
 * the same locale files as the renderer and follow the `language` setting.
 *
 * Electron-free on purpose, so the dialog builders stay testable. A dialog
 * that fires before the database is open (migration and database errors at
 * start) cannot read the setting; index.ts falls back to the system language
 * for those.
 */
import type Database from 'better-sqlite3'
// A type import, not the global `Electron` namespace: renderer tests reach this
// module through src/test/bridgeKit.ts, and the web project has no such global.
import type { MessageBoxOptions } from 'electron'
import { localeFromSetting, translate, type Locale } from '../shared/i18n'
import type { TranslationKey } from '../shared/locales/de'
import { LOCALE_STRINGS } from '../shared/locales'

export { localeFromSetting }

export type DialogT = (key: TranslationKey, vars?: Record<string, string | number>) => string

/** The app language from an open database. Throws when the handle is closed. */
export function readLanguage(db: Database.Database): Locale {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'language'`).get() as
    | { value: string }
    | undefined
  return localeFromSetting(row?.value)
}

/** The text function for one locale. Values are filled in literally (one pass). */
export function dialogT(locale: Locale): DialogT {
  return (key, vars) => translate(LOCALE_STRINGS[locale], key, vars)
}

/**
 * `readLanguage` for a dialog that must still show when the handle is
 * closed (a restore attempt closes it): the system language then, as at start.
 */
export function readLanguageOr(db: Database.Database, fallback: () => Locale): Locale {
  // Only the closed handle falls back; any other database error still throws.
  return db.open ? readLanguage(db) : fallback()
}

/**
 * The app language for any text of the main process, never throwing (#296):
 * the setting; with the handle closed or the read failing, the first system
 * language; if even that cannot be read, German, the app default. A dialog,
 * a tray label or a file name must not fail because a settings read did.
 */
export function appLocale(
  getDb: () => Database.Database,
  systemLanguages: () => readonly string[]
): Locale {
  try {
    return readLanguageOr(getDb(), () => localeFromSystem(systemLanguages()))
  } catch {
    try {
      return localeFromSystem(systemLanguages())
    } catch {
      return 'de'
    }
  }
}

/**
 * The MCP write confirmation (mcpBridge.ts). `summary` is the text
 * mcpBridgeCore built in the same language. Button order, default and cancel
 * are part of the guard: index 1 approves, Enter approves, Esc denies.
 */
export function mcpConfirmDialog(
  locale: Locale,
  summary: string
): MessageBoxOptions & { buttons: string[] } {
  const t = dialogT(locale)
  return {
    type: 'question',
    buttons: [t('mainDialog.mcp.deny'), t('mainDialog.mcp.allow')],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
    title: t('mainDialog.mcp.title'),
    message: t('mainDialog.mcp.message'),
    detail: summary,
    checkboxLabel: t('mainDialog.mcp.remember'),
    checkboxChecked: false
  }
}

/** The hotkey conflict at start (index.ts), as message box options. */
export function hotkeyConflictDialog(
  locale: Locale,
  hotkey: string
): { title: string; message: string; detail: string; buttons: string[] } {
  const t = dialogT(locale)
  return {
    title: t('mainDialog.hotkey.title'),
    message: t('mainDialog.hotkey.message', { hotkey }),
    detail: t('mainDialog.hotkey.detail'),
    buttons: [t('mainDialog.ok')]
  }
}

/** The migration error at start (index.ts), as error box title and text. */
export function migrationErrorDialog(
  locale: Locale,
  e: { version: number; name: string; cause: string; backupPath: string }
): { title: string; message: string } {
  const t = dialogT(locale)
  return {
    title: t('mainDialog.migration.title'),
    message: t('mainDialog.migration.message', e)
  }
}

/** The database error at start (index.ts), as error box title and text. */
export function dbErrorDialog(locale: Locale, cause: string): { title: string; message: string } {
  const t = dialogT(locale)
  return {
    title: t('mainDialog.dbError.title'),
    message: t('mainDialog.dbError.message', { cause })
  }
}

/**
 * The language for a dialog before the database is open: the first system
 * language (`app.getPreferredSystemLanguages()`), German for `de` and its
 * regional forms, English for everything else.
 */
export function localeFromSystem(languages: readonly string[]): Locale {
  // `de`, `de-DE`, and the `de_DE` / `de_DE.UTF-8` forms some Linux setups report.
  return /^de([-_.]|$)/i.test(languages[0] ?? '') ? 'de' : 'en'
}

// ── #296: texts outside the dialogs ─────────────────────────────────────────

/** Characters Windows and macOS refuse in a file name, replaced by `_`. */
function safeFilePart(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim()
}

/**
 * The suggested name of an export file (the save dialog's `defaultPath`).
 * German keeps the names the app always wrote (`Stundennachweis-Acme-2026-04.pdf`);
 * English writes `Timesheet-Acme-2026-04.pdf` (owner decision on #296).
 */
export function exportFileName(
  locale: Locale,
  kind: 'pdf' | 'csv' | 'ical',
  e: { client: string; project?: string | null; month: string }
): string {
  const t = dialogT(locale)
  return t(kind === 'pdf' ? 'mainFile.pdf' : kind === 'csv' ? 'mainFile.csv' : 'mainFile.ical', {
    client: safeFilePart(e.client) || t('mainFile.fallbackClient'),
    // As the app always did: a given project adds `-<name>`.
    project: e.project != null ? `-${safeFilePart(e.project)}` : '',
    month: e.month
  })
}

/** The merged PDF written next to the invoice; `stamp` when that name is taken. */
export function mergedFileName(locale: Locale, invoiceStem: string, stamp?: string): string {
  const t = dialogT(locale)
  return stamp === undefined
    ? t('mainFile.merged', { name: invoiceStem })
    : t('mainFile.mergedStamped', { name: invoiceStem, stamp })
}

/**
 * The result of a dialog the user closed: the renderer acts on `code`, never
 * on the text, which stays for logs.
 */
export function cancelledResult(
  locale: Locale,
  key: 'mainError.exportCancelled' | 'mainError.selectionCancelled' | 'mainError.saveCancelled'
): { ok: false; error: string; code: 'cancelled' } {
  return { ok: false, error: dialogT(locale)(key), code: 'cancelled' }
}

/** The tray's fixed menu labels. */
export function trayLabels(locale: Locale): {
  idle: string
  stop: string
  quickStart: string
  noClients: string
  showWindow: string
  quit: string
} {
  const t = dialogT(locale)
  return {
    idle: t('mainTray.idle'),
    stop: t('mainTray.stop'),
    quickStart: t('mainTray.quickStart'),
    noClients: t('mainTray.noClients'),
    showWindow: t('mainTray.showWindow'),
    quit: t('mainTray.quit')
  }
}

/** The tray tooltip; `today` is the day's total as `HH:MM`. */
export function trayTooltip(
  locale: Locale,
  running: boolean,
  label: string,
  today: string
): string {
  const t = dialogT(locale)
  return running
    ? t('mainTray.tooltipRunning', { label, today })
    : t('mainTray.tooltipIdle', { today })
}
