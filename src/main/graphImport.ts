/**
 * The bracket around the calendar import (#130b): time range in, proposal list
 * out. Wires together what the other modules deliberately keep apart —
 * `graphAccount.getAccessToken` (token, refreshed if needed),
 * `graphCalendar.fetchCalendarView` (the I/O), `clientDomains.domainMapping`
 * (domain → client), the dedupe set from `entries.graph_event_id`, and finally
 * `shared/graphCalendar.mapEvents` (the rules).
 *
 * Nothing here decides anything; it only fetches inputs and hands them to the
 * pure mapping. That keeps this file small enough that the one thing it must
 * get right is visible: WHICH rows count as already imported. Soft-deleted
 * entries do not — deleting an imported entry is "I did not mean this one",
 * and the event must be offered again (see migration 021).
 */
import type Database from 'better-sqlite3'
import { getAccessToken, getStatus, type GraphAccountDeps } from './graphAccount'
import { fetchCalendarView, GraphCalendarError, type CalendarRange } from './graphCalendar'
import { domainMapping } from './clientDomains'
import { insertEntrySegments, validateManualEntry } from './entryMutations'
import { appLocale, entryErrorText } from './mainI18n'
import { splitAtMidnight } from '../shared/midnightSplit'
import { domainOf, mapEvents, type FilterOptions, type MappedEvents } from '../shared/graphCalendar'

export interface PreviewDeps {
  account: GraphAccountDeps
  fetchFn?: typeof fetch
  log?: (message: string) => void
}

/** Graph event ids of entries that still exist — the dedupe input. */
export function importedEventIds(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      `SELECT graph_event_id AS id FROM entries
       WHERE graph_event_id IS NOT NULL AND deleted_at IS NULL`
    )
    .all() as Array<{ id: string }>
  return new Set(rows.map((r) => r.id))
}

/**
 * The user's own mail domain, used to strip internal attendees. Empty when no
 * account is connected or the username carries no usable domain — then no
 * domain is "own" and every attendee counts as external, which is the honest
 * fallback.
 */
export function ownDomains(deps: GraphAccountDeps): string[] {
  const domain = domainOf(getStatus(deps).account?.username)
  return domain ? [domain] : []
}

function validRange(range: CalendarRange): boolean {
  const start = Date.parse(range?.startIso ?? '')
  const end = Date.parse(range?.endIso ?? '')
  return Number.isFinite(start) && Number.isFinite(end) && start < end
}

/**
 * Fetch the range and translate it into entry drafts. Throws
 * `GraphCalendarError` with a user-facing message on every failure mode the
 * user can do something about; the IPC layer only stringifies.
 */
export async function previewCalendarImport(
  db: Database.Database,
  range: CalendarRange,
  deps: PreviewDeps,
  filters?: FilterOptions
): Promise<MappedEvents> {
  if (!validRange(range)) {
    throw new GraphCalendarError('Der Zeitraum ist ungültig: Beginn muss vor dem Ende liegen.')
  }

  const token = await getAccessToken(deps.account)
  if (!token) {
    throw new GraphCalendarError(
      'Kein Microsoft-Konto verbunden. Bitte in den Einstellungen verbinden.'
    )
  }

  const events = await fetchCalendarView(token, range, { fetchFn: deps.fetchFn, log: deps.log })
  return mapEvents(events, {
    ownDomains: ownDomains(deps.account),
    mapping: domainMapping(db),
    alreadyImported: importedEventIds(db),
    filters
  })
}

/** One confirmed draft from the dialog — times possibly reviewed, client chosen. */
export interface ImportEntryItem {
  graphEventId: string
  description: string
  startedAt: string
  stoppedAt: string
  clientId: number
  /** Project within that client, or null (#176). */
  projectId?: number | null
}

export interface ImportResult {
  created: number
  /** Per-event failures, with the same messages the manual-entry form shows. */
  failed: Array<{ graphEventId: string; error: string }>
}

/**
 * Turn confirmed drafts into entries (#130c).
 *
 * Each event commits in its own transaction on purpose: calendars contain
 * overlapping meetings, and the overlap validation would sink an all-or-nothing
 * batch because of one double-booked slot. This way the user gets four entries
 * and one explained failure instead of five failures.
 *
 * Soft-deleted entries holding the same event id give up their anchor first —
 * they are the "imported this once, then deleted it" case, and without the
 * release the unique index would refuse the re-import the preview just offered.
 */
export function importCalendarEntries(
  db: Database.Database,
  items: ImportEntryItem[]
): ImportResult {
  let created = 0
  const failed: ImportResult['failed'] = []
  // A refused row is worded in the app language (#296 part B). The import
  // writes to `db`, so it is open; the empty system-language list only
  // stands in for a fallback this module has no Electron access for.
  const locale = appLocale(
    () => db,
    () => []
  )

  for (const item of items) {
    const graphEventId = item.graphEventId?.trim()
    if (!graphEventId) {
      failed.push({ graphEventId: item.graphEventId ?? '', error: 'Termin ohne Event-ID.' })
      continue
    }
    const tx = db.transaction((): void => {
      const dupe = db
        .prepare(`SELECT id FROM entries WHERE graph_event_id = ? AND deleted_at IS NULL`)
        .get(graphEventId)
      if (dupe) throw new Error('Termin wurde bereits übernommen.')

      db.prepare(
        `UPDATE entries SET graph_event_id = NULL
         WHERE graph_event_id = ? AND deleted_at IS NOT NULL`
      ).run(graphEventId)

      const input = {
        client_id: item.clientId,
        description: item.description ?? '',
        started_at: item.startedAt,
        stopped_at: item.stoppedAt
      }
      const err = validateManualEntry(db, input)
      if (err) throw new Error(entryErrorText(err, locale))

      const projectId = item.projectId ?? null
      if (projectId !== null) {
        // Same rule as learnDomain: a project from another client would book
        // the time onto the wrong customer's budget.
        const project = db
          .prepare(`SELECT id FROM projects WHERE id = ? AND client_id = ?`)
          .get(projectId, item.clientId)
        if (!project) throw new Error('Projekt gehört nicht zum gewählten Kunden.')
      }

      const segments = splitAtMidnight(new Date(item.startedAt), new Date(item.stoppedAt))
      insertEntrySegments(db, input, segments, '', '', 1, '', projectId, graphEventId)
    })
    try {
      tx()
      created++
    } catch (e) {
      failed.push({ graphEventId, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return { created, failed }
}
