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
import { translateLiteral, type Locale } from '../shared/i18n'
import type { TranslationKey } from '../shared/locales/de'
import { LOCALE_STRINGS } from '../shared/locales'
import type { SensitiveSettingChange } from './settingsWrite'

export type DialogT = (key: TranslationKey, vars?: Record<string, string | number>) => string

/** Longest free text shown in the dialog, in characters. */
const DIALOG_TEXT_MAX = 120

/**
 * C0/C1 controls (line breaks are handled before) and the bidi marks,
 * embeddings, overrides and isolates (U+061C, U+200E/F, U+202A–202E,
 * U+2066–2069) that can make text read in another order than it is stored.
 */
const HIDDEN_CHARS =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

/**
 * Free text from the MCP client (or a name) as ONE line for the native
 * confirmation dialog: line breaks become `⏎`, tabs a space, control and bidi
 * characters go, and it is cut at DIALOG_TEXT_MAX with `…`. Otherwise a
 * crafted text could forge lines, push the real change lines out of the
 * visible area with blank lines, or reverse the reading order (owner review
 * #255). Only the dialog text is cleaned; the preview carries the values as
 * they are.
 */
export function dialogText(v: string): string {
  const flat = v
    // U+2028/2029 (line/paragraph separator) break lines in some dialogs too.
    .replace(/\r\n|\r|\n|\u2028|\u2029/g, ' ⏎ ')
    .replace(/\t/g, ' ')
    .replace(HIDDEN_CHARS, '')
  const chars = [...flat]
  return chars.length > DIALOG_TEXT_MAX ? chars.slice(0, DIALOG_TEXT_MAX - 1).join('') + '…' : flat
}

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
  return (key, vars) => translateLiteral(LOCALE_STRINGS[locale], key, vars)
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
 * The MCP write confirmation (mcpBridge.ts). `summary` is the text
 * mcpBridgeCore built in the same language. Button order, default and cancel
 * are part of the guard: index 1 approves, Enter approves, Esc denies.
 */
export function mcpConfirmDialog(
  locale: Locale,
  summary: string,
  // #301: the "allow start and stop for 30 minutes" box, only where it applies.
  offerRemember = true
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
    ...(offerRemember
      ? { checkboxLabel: t('mainDialog.mcp.remember'), checkboxChecked: false }
      : {})
  }
}

/**
 * #272 (A3): the confirmation before a setting widens access to the user's
 * data (settingsWrite.ts → sensitiveSettingChange). Index 1 confirms;
 * cancel and Esc are index 0, and Enter cancels too: the safe answer is the
 * default for a change the renderer asked for.
 */
export function sensitiveSettingDialog(
  locale: Locale,
  change: SensitiveSettingChange
): MessageBoxOptions & { buttons: string[] } {
  const t = dialogT(locale)
  const k = change.kind
  // The values come from the renderer this dialog guards against: each URL is
  // shown as the parser reads it (tabs and newlines gone, IDN as punycode, as
  // delivery will use it), then flattened like every other dialog value.
  // The host leads each line, never shortened: it is where the data goes, and
  // a long address (or userinfo before an '@') must not push it out of view.
  const shownUrl = (u: string): string => {
    try {
      const parsed = new URL(u)
      return `${parsed.host} — ${dialogText(parsed.href)}`
    } catch {
      return dialogText(u)
    }
  }
  const detail =
    change.kind === 'webhook'
      ? t('mainDialog.settingConfirm.webhook.detail', {
          urls: change.urls.map(shownUrl).join('\n')
        })
      : change.kind === 'graphClientId'
        ? t('mainDialog.settingConfirm.graphClientId.detail', { id: dialogText(change.id) })
        : t(`mainDialog.settingConfirm.${k}.detail`)
  return {
    type: 'warning',
    buttons: [t('mainDialog.settingConfirm.cancel'), t(`mainDialog.settingConfirm.${k}.confirm`)],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: t('mainDialog.settingConfirm.title'),
    message: t(`mainDialog.settingConfirm.${k}.message`),
    detail
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
