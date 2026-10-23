/**
 * Minimal i18n runtime (v1.5 PR D).
 *
 * No runtime deps, fully tree-shakeable. Locale files are plain TS objects
 * so TypeScript catches dead/missing keys at compile time.
 *
 * Interpolation: single-brace `{key}` syntax.
 *   translate(strings, 'update.available', { version: '1.5.1' })
 *   → "Version 1.5.1 verfügbar — wird heruntergeladen …"
 */

export type Locale = 'de' | 'en'

/**
 * The app language from the `language` setting: `en` is English, anything
 * else (including no value yet) German, the app default (migration 002).
 * The one rule for renderer and main process (#296).
 */
export function localeFromSetting(value: string | null | undefined): Locale {
  return value === 'en' ? 'en' : 'de'
}

/**
 * Translate a single key with optional variable substitution.
 *
 * Falls back to the key string itself when no translation is found so the
 * UI never shows `undefined`.
 *
 * Every `{name}` slot is filled in one pass (#296): a value that itself
 * contains `{…}` (a client name, an error text, a path) stays as written
 * instead of being filled in turn. An unknown slot stays as written too.
 */
export function translate(
  strings: Record<string, string>,
  key: string,
  vars: Record<string, string | number> = {}
): string {
  return (strings[key] ?? key).replace(/\{(\w+)\}/g, (slot, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : slot
  )
}
