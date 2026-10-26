import { localDateKey } from '../shared/dateRanges'

/**
 * The entry the packaged smoke test (`--smoke-test` in index.ts) seeds for
 * its PDF check, and the local day the PDF is asked for: 08:00 to 09:00
 * local on the day before `now`. Pure, so the choice of day is tested: the
 * range must lie in the past at any hour, because `writeEntry` refuses a
 * start in the future and the smoke runs at whatever hour the release
 * pipeline reaches it (Codex counter-check on P2; with "today" the smoke was
 * red before 08:00).
 */
export function smokeEntryRange(now: Date): { startIso: string; stopIso: string; dayKey: string } {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  return {
    startIso: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 8).toISOString(),
    stopIso: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9).toISOString(),
    dayKey: localDateKey(day)
  }
}
