/**
 * Deleting a client or a project (2.0 P2, owner decision 2026-10-26): refused
 * as soon as ANY entry version points at it, deleted entries and earlier
 * versions included. The history is never cut (design D5, section 4.2), so
 * neither a cascade nor a silent NULL is an option; the user gets a clear
 * message instead of a foreign-key error.
 *
 * Without entries the master record goes, and with it the rate rows and
 * billing profiles the migration seeded for it (they reference the client and
 * the project without an ON DELETE action, and have no life of their own
 * before P4).
 *
 * Electron-free, so ipc.ts and the tests call the same code.
 */
import type Database from 'better-sqlite3'
import type { IpcResult } from '../shared/types'

export const CLIENT_HAS_ENTRIES_ERROR =
  'Kunde hat Einträge (auch gelöschte oder frühere Versionen) und kann nicht gelöscht werden'
export const PROJECT_HAS_ENTRIES_ERROR =
  'Projekt hat Einträge (auch gelöschte oder frühere Versionen) und kann nicht gelöscht werden'

function fail(error: string): IpcResult<never> {
  return { ok: false, error }
}

function versionCount(
  db: Database.Database,
  column: 'client_id' | 'project_id',
  id: number
): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM entry_version WHERE ${column} = ?`).get(id) as {
    n: number
  }
  return row.n
}

export function deleteClientGuarded(db: Database.Database, id: number): IpcResult<void> {
  try {
    const tx = db.transaction((): IpcResult<void> => {
      if (versionCount(db, 'client_id', id) > 0) return fail(CLIENT_HAS_ENTRIES_ERROR)
      const projects = db.prepare(`SELECT id FROM projects WHERE client_id = ?`).all(id) as Array<{
        id: number
      }>
      for (const p of projects) {
        // projects.client_id cascades on the client; a project with versions
        // means versions of the client, which the count above already refused.
        db.prepare(`DELETE FROM billing_profile WHERE project_id = ?`).run(p.id)
        db.prepare(`DELETE FROM rate WHERE project_id = ?`).run(p.id)
      }
      db.prepare(`DELETE FROM billing_profile WHERE client_id = ?`).run(id)
      db.prepare(`DELETE FROM rate WHERE client_id = ?`).run(id)
      db.prepare(`DELETE FROM clients WHERE id = ?`).run(id)
      return { ok: true, data: undefined }
    })
    return tx()
  } catch (e) {
    return fail(String(e))
  }
}

export function deleteProjectGuarded(db: Database.Database, id: number): IpcResult<void> {
  try {
    const tx = db.transaction((): IpcResult<void> => {
      if (versionCount(db, 'project_id', id) > 0) return fail(PROJECT_HAS_ENTRIES_ERROR)
      db.prepare(`DELETE FROM billing_profile WHERE project_id = ?`).run(id)
      db.prepare(`DELETE FROM rate WHERE project_id = ?`).run(id)
      db.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
      return { ok: true, data: undefined }
    })
    return tx()
  } catch (e) {
    return fail(String(e))
  }
}
