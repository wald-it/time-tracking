/**
 * Domain → client mapping for the calendar import (#130b).
 *
 * One row per attendee domain (`kunde-x.de` → client X), stored lowercase, with
 * a real foreign key so a deleted client takes its domains with it (see
 * migration 021). `learnDomain` is an upsert on purpose: the confirm dialog's
 * "assign this domain to this client from now on" checkbox (#130c) must be able
 * to move a domain to a different client, not fail on the existing row.
 *
 * Pure database functions — IPC registration lives in `graphHandlers.ts`.
 */
import type Database from 'better-sqlite3'
import type { IpcResult } from '../shared/types'
import type { DomainTarget } from '../shared/graphCalendar'
import { appLocale, dialogT, type DialogT } from './mainI18n'

/**
 * The texts in the app language (#296 part B). Electron-free: `db` is open
 * here; the empty system-language list stands in for a fallback this module
 * has no Electron access for.
 */
function tFor(db: Database.Database): DialogT {
  return dialogT(
    appLocale(
      () => db,
      () => []
    )
  )
}

export interface ClientDomain {
  id: number
  domain: string
  clientId: number
  /** Optional project within that client (#176). Null = client only. */
  projectId: number | null
  createdAt: string
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/**
 * Normalize what a user (or the import dialog) hands us into a comparable
 * domain: lowercase, no surrounding whitespace, a leading `@` stripped because
 * "@kunde.de" is how people naturally type it. Returns `null` for anything that
 * does not look like a hostname — the mapping must never contain values that
 * `domainOf()` could not produce, or lookups would silently miss.
 */
export function normalizeDomain(raw: string): string | null {
  let domain = raw.trim().toLowerCase()
  if (domain.startsWith('@')) domain = domain.slice(1)
  if (domain.length === 0 || domain.length > 253) return null
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return null
  return domain
}

export function listClientDomains(db: Database.Database): IpcResult<ClientDomain[]> {
  try {
    const rows = db
      .prepare(
        `SELECT id, domain, client_id AS clientId, project_id AS projectId, created_at AS createdAt
         FROM client_domains ORDER BY domain ASC`
      )
      .all() as ClientDomain[]
    return ok(rows)
  } catch (e) {
    return fail(e)
  }
}

/** The lookup table `resolveClient()` consumes. Internal — not an IPC payload. */
export function domainMapping(db: Database.Database): Map<string, DomainTarget> {
  const rows = db
    .prepare(`SELECT domain, client_id AS clientId, project_id AS projectId FROM client_domains`)
    .all() as Array<{ domain: string; clientId: number; projectId: number | null }>
  return new Map(rows.map((r) => [r.domain, { clientId: r.clientId, projectId: r.projectId }]))
}

/**
 * Remember a domain for a client, optionally with a project (#176). Upsert: an
 * existing row moves to the new combination instead of erroring, because that
 * is what correcting a wrong mapping looks like from the dialog.
 */
export function learnDomain(
  db: Database.Database,
  rawDomain: string,
  clientId: number,
  projectId: number | null = null
): IpcResult<ClientDomain> {
  const domain = normalizeDomain(rawDomain)
  if (!domain) return fail(tFor(db)('mainError.domain.invalid', { domain: rawDomain.trim() }))

  try {
    const client = db.prepare(`SELECT id FROM clients WHERE id = ?`).get(clientId)
    if (!client) return fail(tFor(db)('mainError.domain.clientMissing', { id: clientId }))
    if (projectId !== null) {
      // The project must belong to the client — a mapping pointing across
      // clients would produce entries the overlap check charges to the wrong
      // customer. Orphaned projects (client_id NULL) fail this on purpose.
      const project = db
        .prepare(`SELECT id FROM projects WHERE id = ? AND client_id = ?`)
        .get(projectId, clientId)
      if (!project) {
        return fail(
          tFor(db)('mainError.domain.projectNotOfClient', { project: projectId, client: clientId })
        )
      }
    }
    db.prepare(
      `INSERT INTO client_domains (domain, client_id, project_id) VALUES (?, ?, ?)
       ON CONFLICT(domain) DO UPDATE
         SET client_id = excluded.client_id, project_id = excluded.project_id`
    ).run(domain, clientId, projectId)
    const row = db
      .prepare(
        `SELECT id, domain, client_id AS clientId, project_id AS projectId, created_at AS createdAt
         FROM client_domains WHERE domain = ?`
      )
      .get(domain) as ClientDomain
    return ok(row)
  } catch (e) {
    return fail(e)
  }
}

/** Forget a mapping. Removing a non-existent domain is a no-op, not an error. */
export function forgetDomain(db: Database.Database, rawDomain: string): IpcResult<void> {
  const domain = normalizeDomain(rawDomain)
  if (!domain) return fail(tFor(db)('mainError.domain.invalid', { domain: rawDomain.trim() }))
  try {
    db.prepare(`DELETE FROM client_domains WHERE domain = ?`).run(domain)
    return ok(undefined)
  } catch (e) {
    return fail(e)
  }
}
