/**
 * IPC surface for the Microsoft account connection (#130).
 *
 * Thin on purpose: everything that decides anything lives in `graphAccount.ts`.
 * What this layer owns is the one thing the renderer cannot — keeping the
 * in-flight sign-in cancellable, so closing the settings page or pressing
 * "cancel" actually tears down the loopback listener instead of leaving it
 * bound until it times out.
 *
 * `graph:status` deliberately returns no token material; see `AccountStatus`.
 */
import { ipcMain, shell } from 'electron'
import type Database from 'better-sqlite3'
import log from 'electron-log/main'
import { getDbPath } from './db'
import { tokenDirForDbPath } from './graphTokenStore'
import type { IpcResult } from '../shared/types'
import {
  connect,
  disconnect,
  getStatus,
  verifyConnection,
  type AccountStatus,
  type VerifyResult,
  type GraphAccountDeps
} from './graphAccount'
import { forgetDomain, learnDomain, listClientDomains, type ClientDomain } from './clientDomains'
import {
  importCalendarEntries,
  previewCalendarImport,
  type ImportEntryItem,
  type ImportResult
} from './graphImport'
import type { CalendarRange } from './graphCalendar'
import type { FilterOptions, MappedEvents } from '../shared/graphCalendar'

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/** The one place these deps are assembled — shared with the presence
 *  reconciler wiring in index.ts (#132). */
export function graphAccountDepsFor(db: Database.Database): GraphAccountDeps {
  return {
    getSetting: (key) => {
      const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
        | { value: string }
        | undefined
      return row?.value
    },
    openExternal: (url) => shell.openExternal(url),
    // Anchored on the database the app actually opened — not on a
    // reconstructed %APPDATA% path, which cannot see an overridden userData.
    store: { dir: tokenDirForDbPath(getDbPath()) },
    log: (m) => log.info(m)
  }
}

export function registerGraphHandlers(db: Database.Database): void {
  const deps: GraphAccountDeps = graphAccountDepsFor(db)

  // Only one sign-in can be in flight; a second "connect" click replaces the
  // first rather than leaving two listeners and two browser tabs behind.
  let inFlight: AbortController | null = null

  ipcMain.handle('graph:status', async (): Promise<IpcResult<AccountStatus>> => {
    try {
      return ok(await getStatus(deps))
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('graph:connect', async (): Promise<IpcResult<AccountStatus>> => {
    inFlight?.abort()
    const ctrl = new AbortController()
    inFlight = ctrl
    try {
      return ok(await connect(deps, ctrl.signal))
    } catch (e) {
      return fail(e)
    } finally {
      if (inFlight === ctrl) inFlight = null
    }
  })

  ipcMain.handle('graph:cancelConnect', (): IpcResult<void> => {
    inFlight?.abort()
    inFlight = null
    return ok(undefined)
  })

  ipcMain.handle('graph:verify', async (): Promise<IpcResult<VerifyResult>> => {
    try {
      return ok(await verifyConnection(deps))
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('graph:disconnect', async (): Promise<IpcResult<AccountStatus>> => {
    try {
      // A sign-in still running would otherwise write its tokens back moments
      // after the user asked to be disconnected.
      inFlight?.abort()
      inFlight = null
      return ok(await disconnect(deps))
    } catch (e) {
      return fail(e)
    }
  })

  // ── Calendar import (#130b) ────────────────────────────────────────────────

  ipcMain.handle(
    'graph:calendarPreview',
    async (_e, range: CalendarRange, filters?: FilterOptions): Promise<IpcResult<MappedEvents>> => {
      try {
        return ok(await previewCalendarImport(db, range, { account: deps, log: deps.log }, filters))
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle('graph:importEntries', (_e, items: ImportEntryItem[]): IpcResult<ImportResult> => {
    try {
      return ok(importCalendarEntries(db, items))
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('graph:listDomains', (): IpcResult<ClientDomain[]> => {
    return listClientDomains(db)
  })

  ipcMain.handle(
    'graph:learnDomain',
    (_e, domain: string, clientId: number, projectId?: number | null): IpcResult<ClientDomain> => {
      return learnDomain(db, domain, clientId, projectId ?? null)
    }
  )

  ipcMain.handle('graph:forgetDomain', (_e, domain: string): IpcResult<void> => {
    return forgetDomain(db, domain)
  })
}
