import type { Settings } from './types'

/**
 * The settings keys the renderer may write through `settings:set` (#272 / #293).
 * Main, preload and renderer share this list.
 *
 * A positive list: a key the UI does not write is refused, so a compromised
 * renderer cannot plant values the main process trusts elsewhere. Kept out on
 * purpose, because only the main process writes them:
 * - `backup_path` — only through the folder dialog (`backup:set-path`);
 * - `pdf_logo_path` — only through the file dialog (`logo:set`);
 * - `window_bounds` — written by main/windowBounds.ts;
 * - `ical_feed_token` — only through `icalFeed:regenerate`.
 *
 * Renderer writes take RendererSettingKey, so a missing key is a type error.
 * `satisfies` checks that every entry is a Settings key. settingsWrite.test.ts
 * checks that the renderer still writes every key in the list.
 */
export const RENDERER_SETTING_KEYS = [
  'target_hours_week',
  'target_rate_cent',
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
  'feedback_rules',
  'rule_check',
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
] as const satisfies readonly (keyof Settings)[]

export type RendererSettingKey = (typeof RENDERER_SETTING_KEYS)[number]
