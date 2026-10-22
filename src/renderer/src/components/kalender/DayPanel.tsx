import type { Client, Entry } from '../../../../shared/types'
import { DayDetails } from './DayDetails'

/**
 * Kalender — persistent day panel in the aside (HANDOFF §3.13, B4), shown
 * from 1100 px window width instead of the overlay drawer. `DayDetails`
 * already brings the section pattern, so no extra frame is needed here.
 *
 * Keyed by the date: selecting another day starts with a clean state (no
 * half-finished edit, backfill form or tag filter carried over to a day it
 * does not belong to). The drawer gets the same by unmounting `DayDetails`
 * when it closes.
 * No `onEscape`: there is nothing to close, Escape only cancels an open edit.
 */
export function DayPanel({
  dateISO,
  entries,
  clients
}: {
  dateISO: string
  entries: Entry[]
  clients: Client[]
}): React.JSX.Element {
  return <DayDetails key={dateISO} dateISO={dateISO} entries={entries} clients={clients} />
}
