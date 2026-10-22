import type { Client, Entry } from '../../../../shared/types'

/**
 * Pure math behind the month's client breakdown (HANDOFF §3.14).
 *
 * Seconds per client over the given entries, the share of the summed total
 * and a stable order (largest first, ties by name). A running entry counts up
 * to `nowMs` — the caller passes the shared clock from `useNow()`, so there is
 * no own interval. Durations are raw (no rounding): the breakdown shows worked
 * time, like the readouts.
 */
export interface ClientShare {
  clientId: number
  name: string
  /** Client colour; `null` when the client is unknown or has none. */
  color: string | null
  seconds: number
  /** Exact share of the total in percent (0–100) — drives the track width. */
  sharePct: number
}

export function entrySeconds(entry: Entry, nowMs: number): number {
  const start = new Date(entry.started_at).getTime()
  const stop = entry.stopped_at ? new Date(entry.stopped_at).getTime() : nowMs
  return Math.max(0, Math.floor((stop - start) / 1000))
}

export function clientShares(entries: Entry[], clients: Client[], nowMs: number): ClientShare[] {
  const clientsById = new Map(clients.map((c) => [c.id, c]))
  const secondsByClient = new Map<number, number>()
  for (const e of entries) {
    secondsByClient.set(
      e.client_id,
      (secondsByClient.get(e.client_id) ?? 0) + entrySeconds(e, nowMs)
    )
  }

  const total = [...secondsByClient.values()].reduce((sum, s) => sum + s, 0)
  if (total === 0) return []

  return [...secondsByClient.entries()]
    .filter(([, seconds]) => seconds > 0)
    .map(([clientId, seconds]) => {
      const client = clientsById.get(clientId)
      return {
        clientId,
        name: client?.name ?? '',
        color: client?.color || null,
        seconds,
        sharePct: (seconds / total) * 100
      }
    })
    .sort(
      (a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name) || a.clientId - b.clientId
    )
}
