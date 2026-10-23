/**
 * Automatic update check at app start (#273).
 *
 * The one place that turns the stored setting into a decision, read by the
 * main process (updater.ts, at start) and by the Settings toggle. It decides
 * only the check at start: "Check now" stays available either way, and a
 * manual check that finds an update downloads it as before.
 */

export const UPDATE_CHECK_SETTING_KEY = 'update_check_enabled'

/**
 * On unless the stored value is exactly `0`. Existing installations have no
 * row for this key and keep checking, so no migration is needed.
 */
export function isUpdateCheckEnabled(value: string | null | undefined): boolean {
  return value !== '0'
}
