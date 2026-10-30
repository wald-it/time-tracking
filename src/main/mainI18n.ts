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
 * #255). The preview instead escapes hidden characters as visible Unicode
 * codes, without truncating the text or changing line breaks and tabs.
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

/**
 * Escape hidden characters in preview values, recursively, without mutating
 * the plan. Keys and non-string values stay unchanged; numeric ids and
 * validated timestamps have no hidden characters to escape.
 * Read tools deliberately keep raw text: escaping their results would corrupt
 * an entry when an agent reads its text and writes it back.
 */
export function escapePreviewText<T>(value: T): T {
  const visit = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(
        HIDDEN_CHARS,
        (char) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}}`
      )
    }
    if (Array.isArray(v)) return v.map(visit)
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([key, item]) => [key, visit(item)]))
    }
    return v
  }
  return visit(value) as T
}

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

/** The last language read from the setting, for the moments it cannot be read. */
let lastSettingLocale: Locale | null = null

/**
 * The app language for any text of the main process, never throwing (#296).
 * A dialog, a tray label or a file name must not fail because a settings
 * read did. In order:
 * 1. the setting;
 * 2. if it cannot be read (handle closed after a restore attempt, or the
 *    read fails): the last language read from it in this run, so tray and
 *    dialogs keep speaking one language until the relaunch;
 * 3. if there is none: the first system language (`localeFromSystem`:
 *    English when the system reports none);
 * 4. if even that throws: German, the app default.
 */
export function appLocale(
  getDb: () => Database.Database,
  systemLanguages: () => readonly string[]
): Locale {
  try {
    const db = getDb()
    if (db.open) {
      lastSettingLocale = readLanguage(db)
      return lastSettingLocale
    }
  } catch {
    // falls through to the fallbacks
  }
  if (lastSettingLocale) return lastSettingLocale
  try {
    return localeFromSystem(systemLanguages())
  } catch {
    return 'de'
  }
}

/** Test seam: forget the remembered language. */
export function forgetLastAppLocale(): void {
  lastSettingLocale = null
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
      return parsed.host ? `${parsed.host} — ${dialogText(parsed.href)}` : dialogText(parsed.href)
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

/**
 * The system notification once an update has downloaded (updater.ts, #309).
 * It names the install key with the label the update banner renders, taken
 * from the same locale key, so the two cannot drift apart.
 */
export function updateDownloadedNotification(
  locale: Locale,
  version: string
): { title: string; body: string } {
  const t = dialogT(locale)
  return {
    title: t('mainNotification.update.title'),
    body: t('mainNotification.update.body', { version, button: t('update.ready.install') })
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
  e: { client: string; project?: string | null; month: string; invoiceRef?: string }
): string {
  const t = dialogT(locale)
  const name = t(
    kind === 'pdf' ? 'mainFile.pdf' : kind === 'csv' ? 'mainFile.csv' : 'mainFile.ical',
    {
      client: safeFilePart(e.client) || t('mainFile.fallbackClient'),
      // As the app always did: a given project adds `-<name>`.
      project: e.project != null ? `-${safeFilePart(e.project)}` : '',
      month: e.month
    }
  )
  const invoiceRef = safeFilePart(e.invoiceRef ?? '')
  return kind === 'csv' && invoiceRef ? `${name.slice(0, -4)}-${invoiceRef}.csv` : name
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
