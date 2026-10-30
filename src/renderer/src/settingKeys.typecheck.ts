/**
 * Compile-time guard for the renderer settings allow-list (#293).
 * This file is never imported or bundled. tsconfig.web.json includes it in
 * `pnpm typecheck`. If a forbidden key becomes writable, its @ts-expect-error
 * directive has no error to suppress and the typecheck fails.
 */
import type { RendererSettingKey } from '../../shared/settingKeys'

export function rendererCannotWriteMainOnlyKeys(): void {
  // @ts-expect-error backup_path is written only through its folder dialog
  void window.api.settings.set('backup_path', 'C:\\elsewhere')
  // @ts-expect-error pdf_logo_path is written only through the file dialog
  void window.api.settings.set('pdf_logo_path', 'x')
  // @ts-expect-error window_bounds is written by the main process
  void window.api.settings.set('window_bounds', '{}')
  // @ts-expect-error ical_feed_token only changes through icalFeed:regenerate
  void window.api.settings.set('ical_feed_token', 'x')
  // @ts-expect-error an unknown key is not a setting
  void window.api.settings.set('something_new', 'x')
}

export const allowed: RendererSettingKey[] = ['theme_mode', 'webhook_targets']
