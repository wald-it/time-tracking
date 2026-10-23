import type Database from 'better-sqlite3'
import type { IpcHooks } from './ipc'
import type { HotkeyChange } from './hotkeySlot'
import type { IpcResult } from '../shared/types'
import { appLocale, dialogT, type DialogT } from './mainI18n'
import { parseWebhookTargets } from '../shared/webhooks'
import { DEFAULT_CLIENT_ID } from '../shared/graphAuth'

/**
 * #272 — the settings keys the renderer may write through `settings:set`.
 *
 * A positive list: a key the UI does not write is refused, so a compromised
 * renderer cannot plant values the main process trusts elsewhere. Kept out on
 * purpose, because only the main process writes them:
 * - `backup_path` — only through the folder dialog (`backup:set-path`);
 * - `pdf_logo_path` — only through the file dialog (`logo:set`);
 * - `window_bounds` — written by main/windowBounds.ts;
 * - `ical_feed_token` — only through `icalFeed:regenerate`.
 *
 * `settingsWrite.test.ts` checks every key the renderer source passes against
 * this list, so a new UI setting that is missing here fails a test instead of
 * silently not being saved.
 */
export const RENDERER_WRITABLE_SETTINGS: ReadonlySet<string> = new Set([
  'company_name',
  'idle_threshold_minutes',
  'language',
  'auto_start',
  'hotkey_toggle',
  'pdf_sender_address',
  'pdf_tax_id',
  'pdf_accent_color',
  'pdf_footer_text',
  'pdf_round_minutes',
  'mini_enabled',
  'mini_hotkey',
  'mini_x',
  'mini_y',
  'onboarding_completed',
  'theme_mode',
  'week_start',
  'show_project_number',
  'export_prefs',
  'mcp_expose_rates',
  'mcp_expose_private_notes',
  // Turning these on asks a native confirmation first (sensitiveSettingChange).
  'mcp_write_enabled',
  'mcp_write_confirm_mode',
  'controller_enabled',
  'webhook_targets',
  'graph_client_id',
  'presence_enabled',
  'presence_show_client',
  'ical_feed_enabled',
  'ical_feed_port',
  // #273 — automatic update check switch (read by updater.ts at start; the
  // key is UPDATE_CHECK_SETTING_KEY in shared/updateCheck.ts).
  'update_check_enabled'
])

/** The only key the preload reads synchronously (theme before first paint). */
export const SYNC_READABLE_SETTINGS: ReadonlySet<string> = new Set(['theme_mode'])

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function fail(error: unknown): IpcResult<never> {
  // The message, not `Error: <message>`: the renderer shows it (#296).
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/**
 * The texts in the app language (#296 part B). Electron-free: the setting is
 * read from `db`, which is open here; the empty system-language list only
 * stands in for a fallback this module has no Electron access for.
 */
function tFor(db: Database.Database): DialogT {
  return dialogT(
    appLocale(
      () => db,
      () => []
    )
  )
}

/**
 * #272 (A3) — a settings change that widens what can reach or change the
 * user's data, and so needs a native confirmation the renderer cannot click
 * through on its own. Switching off, clearing or removing never asks.
 */
export type SensitiveSettingChange =
  | { kind: 'mcpWrite' }
  | { kind: 'controller' }
  | { kind: 'silent' }
  | { kind: 'webhook'; urls: string[] }
  | { kind: 'graphClientId'; id: string }

function enabledWebhookUrls(raw: string | undefined): Set<string> {
  return new Set(
    parseWebhookTargets(raw)
      .filter((t) => t.enabled)
      .map((t) => t.url)
  )
}

/** What `value` for `key` would newly allow, compared with the stored value; null if nothing. */
export function sensitiveSettingChange(
  key: string,
  value: string,
  current: string | undefined
): SensitiveSettingChange | null {
  switch (key) {
    case 'mcp_write_enabled':
      return value === '1' && current !== '1' ? { kind: 'mcpWrite' } : null
    case 'controller_enabled':
      return value === '1' && current !== '1' ? { kind: 'controller' } : null
    case 'mcp_write_confirm_mode':
      return value === 'silent' && current !== 'silent' ? { kind: 'silent' } : null
    case 'webhook_targets': {
      // A URL that will now receive entry data and did not before.
      const before = enabledWebhookUrls(current)
      const urls = [...enabledWebhookUrls(value)].filter((u) => !before.has(u))
      return urls.length > 0 ? { kind: 'webhook', urls } : null
    }
    case 'graph_client_id': {
      // Against the id in effect: empty means TimeTrack's own registration.
      const id = value.trim()
      const effective = (current ?? '').trim() || DEFAULT_CLIENT_ID
      return id !== '' && id !== effective ? { kind: 'graphClientId', id } : null
    }
    default:
      return null
  }
}

/** The user declined a confirmation; the renderer shows nothing for it. */
function cancelled(): IpcResult<never> {
  return { ok: false, error: 'Einstellung nicht übernommen (abgelehnt)', code: 'cancelled' }
}

/**
 * #292: a hotkey is stored only once it is registered, so the setting and the
 * active shortcut agree. Refused, the previous one stays in both.
 *
 * Accepted gap: if storing fails after the new one was registered (a locked
 * database), the OS holds the new hotkey while the setting keeps the old one,
 * which comes back at the next start. The error is reported and logged; no
 * rollback, because undoing the registration has its own failure cases.
 */
function writeHotkey(
  db: Database.Database,
  hooks: IpcHooks,
  key: 'hotkey_toggle' | 'mini_hotkey',
  value: string
): IpcResult<void> {
  const change: HotkeyChange =
    key === 'hotkey_toggle' ? hooks.setHotkey(value) : hooks.setMiniHotkey(value)
  if (!change.ok) {
    const t = tFor(db)
    const refused = t('mainError.settings.hotkeyRefused', { hotkey: value })
    return fail(change.previousKept ? refused : `${refused} ${t('mainError.settings.hotkeyLost')}`)
  }
  try {
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value)
  } catch (e) {
    console.error(`[settings] ${key} "${value}" is registered but could not be stored:`, e)
    return fail(e)
  }
  return ok(undefined)
}

/**
 * Settings writes run one after another. A confirmation dialog awaits the
 * user; a second write that overtook it would be overwritten by the first,
 * and the first was decided against a value that is no longer stored.
 */
let queue: Promise<unknown> = Promise.resolve()

/**
 * `settings:set`: store a renderer-written setting and apply its side effect.
 * A sensitive change (see `sensitiveSettingChange`) is stored only after the
 * native confirmation in `hooks.confirmSensitiveSetting`.
 */
export function writeSettingFromRenderer(
  db: Database.Database,
  hooks: IpcHooks,
  key: unknown,
  value: unknown
): Promise<IpcResult<void>> {
  const run = queue.then(() => writeOne(db, hooks, key, value))
  queue = run.catch(() => undefined)
  return run
}

async function writeOne(
  db: Database.Database,
  hooks: IpcHooks,
  key: unknown,
  value: unknown
): Promise<IpcResult<void>> {
  if (typeof key !== 'string' || !RENDERER_WRITABLE_SETTINGS.has(key)) {
    return fail(tFor(db)('mainError.settings.unknownKey', { key: String(key).slice(0, 64) }))
  }
  if (typeof value !== 'string') return fail(tFor(db)('mainError.settings.badValue', { key }))
  try {
    if (key === 'hotkey_toggle' || key === 'mini_hotkey') return writeHotkey(db, hooks, key, value)
    const current = (
      db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
        | { value: string }
        | undefined
    )?.value
    const change = sensitiveSettingChange(key, value, current)
    if (change && !(await hooks.confirmSensitiveSetting(change))) return cancelled()
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value)
    // Apply side-effects for known keys.
    if (key === 'idle_threshold_minutes') {
      const n = parseInt(value, 10)
      if (Number.isFinite(n)) hooks.setIdleThreshold(n)
    } else if (key === 'auto_start') {
      hooks.setAutoStart(value === '1')
    } else if (key === 'mini_enabled') {
      hooks.setMiniEnabled(value === '1')
    } else if (key === 'mcp_write_enabled') {
      hooks.setMcpWriteEnabled(value === '1')
    } else if (key === 'controller_enabled') {
      hooks.setControllerEnabled(value === '1')
    } else if (key === 'mcp_write_confirm_mode') {
      // #301: a confirm-mode change made in Settings ends a start/stop
      // approval, also a switch back to the mode it was granted in. (The
      // approval also only holds for the mode it was granted under.)
      if (value !== current) hooks.forgetMcpApproval()
    } else if (key === 'presence_enabled' || key === 'presence_show_client' || key === 'language') {
      // The setting is saved at this point: a failing side effect is logged,
      // it must neither skip the next one nor report the change as failed.
      // Toggling mirroring off clears our own status message; the language
      // and privacy switches re-render it while a timer runs.
      try {
        hooks.pokePresence()
      } catch (e) {
        console.warn('[presence] re-render after a settings change failed:', e)
      }
      // The tray speaks the app language too (#296).
      if (key === 'language') {
        try {
          hooks.refreshTrayLanguage()
        } catch (e) {
          console.warn('[tray] rebuild after language change failed:', e)
        }
      }
    } else if (key === 'ical_feed_enabled') {
      hooks.setIcalFeedEnabled(value === '1')
    } else if (key === 'ical_feed_port') {
      hooks.restartIcalFeed()
    }
    return ok(undefined)
  } catch (e) {
    return fail(e)
  }
}

/** `settings:getSync`: the value of a sync-readable key, else null. */
export function readSettingSync(db: Database.Database, key: unknown): string | null {
  if (typeof key !== 'string' || !SYNC_READABLE_SETTINGS.has(key)) return null
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}
