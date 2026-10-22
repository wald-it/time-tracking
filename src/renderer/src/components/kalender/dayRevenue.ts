import type { Client, Entry, Project } from '../../../../shared/types'
import { billedMinutes, effectiveRateCent, feeCent } from '../../../../shared/currency'

/**
 * Billable revenue of a day in cents, exactly as the invoice bills it:
 * billable entries only (#104), each entry's exact span ceiled to minutes and
 * rounded up to the step, project rate over client rate (#120; an explicit
 * project rate of 0 is goodwill). A running entry counts up to `nowMs`.
 * Shared by the calendar cell and the day details so both show one number.
 */
export function dayRevenueCent(
  entries: Entry[],
  clients: Client[],
  projects: Project[],
  roundStep: number,
  nowMs: number
): number {
  let sum = 0
  for (const e of entries) {
    if (e.billable !== 1) continue
    const clientRate = clients.find((c) => c.id === e.client_id)?.rate_cent ?? 0
    const projectRate =
      e.project_id != null ? projects.find((p) => p.id === e.project_id)?.rate_cent : null
    const rate = effectiveRateCent(projectRate, clientRate)
    if (rate <= 0) continue
    // Milliseconds, not entryDurationSeconds: the invoice ceils the exact span.
    const stop = e.stopped_at ? new Date(e.stopped_at).getTime() : nowMs
    const rawMs = Math.max(0, stop - new Date(e.started_at).getTime())
    sum += feeCent(billedMinutes(rawMs, roundStep), rate)
  }
  return sum
}
