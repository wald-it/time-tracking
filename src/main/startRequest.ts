import type Database from 'better-sqlite3'
import { lastStartPair, type StartPair } from '../shared/startPair'
import { readRecentEntries } from './dashboardTotals'

type Db = Database.Database

/**
 * lastStartPair fed from the database: the newest entry (the same query as
 * `dashboard:summary`'s recentEntries), all clients and that client's
 * projects. The renderer feeds the same rule from the summary
 * (startTimerModalStore.readLastStartPair); startPairAgreement.test.ts
 * checks that both feeds give the same pair.
 */
export function readStartPair(db: Db): StartPair | null {
  const last = readRecentEntries(db, 1)[0]
  if (!last) return null
  const clients = db.prepare(`SELECT id, active FROM clients`).all() as Array<{
    id: number
    active: number
  }>
  const projects = db
    .prepare(`SELECT id, active FROM projects WHERE client_id = ?`)
    .all(last.client_id) as Array<{ id: number; active: number }>
  return lastStartPair(last, clients, projects)
}

/**
 * What a press of the global start hotkey or the mini widget's play key does
 * (#297), decided in main because only main can bring the window forward:
 * - `toggle`: forward `timer:hotkey-toggle` as before — the renderer stops a
 *   running timer, or starts its selection, else the last pair.
 * - `open-start`: nothing runs and there is no pair to start (no entry yet,
 *   or the last entry's client is archived) — show the window and open the
 *   START dialog instead of booking on a client the user did not choose.
 */
export function decideStartRequest(db: Db): 'toggle' | 'open-start' {
  const running = db
    .prepare(`SELECT id FROM entries WHERE stopped_at IS NULL AND deleted_at IS NULL LIMIT 1`)
    .get()
  if (running) return 'toggle'
  return readStartPair(db) ? 'toggle' : 'open-start'
}
