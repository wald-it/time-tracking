import type { Gap } from '../../../../shared/gaps'
export { todayGaps } from '../../../../shared/gaps'

const MINUTE_MS = 60_000

/**
 * A gap as backfill-form defaults. The form works in whole minutes, so the
 * start rounds up and the end rounds down: a neighbour that stopped at
 * 10:00:37 must not be overlapped by a backfill starting at 10:00:00, which
 * the overlap check refuses for the same client. Gaps are at least 5 min, so
 * the range stays non-empty.
 */
export function gapFormRange(gap: Gap): { start: Date; end: Date } {
  return {
    start: new Date(Math.ceil(gap.startMs / MINUTE_MS) * MINUTE_MS),
    end: new Date(Math.floor(gap.endMs / MINUTE_MS) * MINUTE_MS)
  }
}
