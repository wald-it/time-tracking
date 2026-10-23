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
import { translateLiteral, type Locale } from '../shared/i18n'
import { de, type TranslationKey } from '../shared/locales/de'
import { en } from '../shared/locales/en'

const LOCALES: Record<Locale, Record<string, string>> = { de, en }

export type DialogT = (key: TranslationKey, vars?: Record<string, string | number>) => string

/** The renderer's rule (I18nContext): 'en' is English, anything else German. */
export function localeFromSetting(value: string | null | undefined): Locale {
  return value === 'en' ? 'en' : 'de'
}

/** The app language from an open database. Throws when the handle is closed. */
export function readLanguage(db: Database.Database): Locale {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'language'`).get() as
    | { value: string }
    | undefined
  return localeFromSetting(row?.value)
}

/** The text function for one locale. Values are filled in literally (translateLiteral). */
export function dialogT(locale: Locale): DialogT {
  return (key, vars) => translateLiteral(LOCALES[locale], key, vars)
}

/**
 * The MCP write confirmation (mcpBridge.ts). `summary` is the text
 * mcpBridgeCore built in the same language. Button order, default and cancel
 * are part of the guard: index 1 approves, Enter approves, Esc denies.
 */
export function mcpConfirmDialog(
  locale: Locale,
  summary: string
): Electron.MessageBoxOptions & { buttons: string[] } {
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
  return /^de(-|$)/i.test(languages[0] ?? '') ? 'de' : 'en'
}
