import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import log from 'electron-log/main'
import type { IpcResult } from '../shared/types'
import { MAX_TAG_LEN, TAG_RE } from '../shared/tags'
import { readEntry, writeEntry } from './entryMutations'

export interface TagWithCount {
  name: string
  count: number
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: String(error) }
}

function validateTagName(name: string): string | null {
  const trimmed = name.trim().toLowerCase()
  if (trimmed.length === 0) return 'Tag-Name darf nicht leer sein'
  if (trimmed.length > MAX_TAG_LEN) return `Tag-Name darf maximal ${MAX_TAG_LEN} Zeichen haben`
  if (/\s/.test(trimmed)) {
    return 'Tag-Name darf keine Leerzeichen enthalten (nutze "_" oder "-")'
  }
  if (!TAG_RE.test(trimmed)) {
    return 'Tag-Name darf nur Kleinbuchstaben, Ziffern und . _ - enthalten'
  }
  return null
}

/**
 * Returns all tags from the master registry with their entry count.
 * Single-scan: reads all non-deleted entry tags once, aggregates in JS,
 * then merges with the master list (tags with 0 entries are included).
 *
 * Exported for unit testing.
 */
export function getAllTagsWithCount(db: Database.Database): IpcResult<TagWithCount[]> {
  try {
    const masterRows = db.prepare('SELECT name FROM tags ORDER BY name ASC').all() as Array<{
      name: string
    }>

    const entryRows = db
      .prepare(`SELECT tags FROM entries WHERE deleted_at IS NULL AND tags != ''`)
      .all() as Array<{ tags: string }>

    const freq = new Map<string, number>()
    for (const { tags } of entryRows) {
      for (const tag of tags.split(',').filter((t: string) => t.length > 0)) {
        freq.set(tag, (freq.get(tag) ?? 0) + 1)
      }
    }

    const result: TagWithCount[] = masterRows.map((r) => ({
      name: r.name,
      count: freq.get(r.name) ?? 0
    }))

    return ok(result)
  } catch (e) {
    return fail(e)
  }
}

/**
 * Creates a new tag in the master registry.
 * Validates name (non-empty, ≤50 chars, no comma). Fails on duplicate.
 *
 * Exported for unit testing.
 */
export function createTag(db: Database.Database, name: string): IpcResult<void> {
  const trimmed = name.trim().toLowerCase()
  const err = validateTagName(trimmed)
  if (err) return fail(err)

  try {
    const existing = db.prepare('SELECT name FROM tags WHERE name = ?').get(trimmed)
    if (existing) return fail(`Tag '${trimmed}' existiert bereits`)
    db.prepare('INSERT INTO tags (name) VALUES (?)').run(trimmed)
    return ok(undefined)
  } catch (e) {
    return fail(e)
  }
}

/**
 * Replace a tag in every live entry that carries it (2.0 design section 5,
 * "tag rename: a patch per live entry, source tag-rename"): a running entry
 * is amended in place, a sealed one gets a new version. Deleted entries are
 * left alone; an undelete brings the old tag name back with them. Throws
 * with the entry id on the first failure, so the caller's transaction rolls
 * the rename back as a whole.
 */
function retagLiveEntries(db: Database.Database, from: string, to: string): number {
  const rows = db
    .prepare(
      `SELECT DISTINCT id, tags, stopped_at IS NULL AS running FROM entries
        WHERE tags LIKE '%,' || ? || ',%' ORDER BY id`
    )
    .all(from) as Array<{ id: number; tags: string; running: number }>
  for (const row of rows) {
    const tags = row.tags.split(`,${from},`).join(`,${to},`)
    const ctx = {
      source: 'tag-rename' as const,
      reason: readEntry(db, row.id)?.billed ? 'Tag renamed' : undefined
    }
    const res = row.running
      ? writeEntry(db, { op: 'amend', id: row.id, patch: { tags } }, ctx)
      : writeEntry(db, { op: 'patch', id: row.id, patch: { tags } }, ctx)
    if (!res.ok) throw new Error(`Eintrag ${row.id}: ${res.error}`)
  }
  return rows.length
}

/**
 * Renames a tag atomically:
 *   1. No-op if oldName === newName.
 *   2. Fail if newName already exists.
 *   3. UPDATE tags.name.
 *   4. A new version per live entry that carries the tag (retagLiveEntries).
 *
 * Exported for unit testing.
 */
export function renameTag(
  db: Database.Database,
  oldName: string,
  newName: string
): IpcResult<void> {
  const trimmedOld = oldName.trim().toLowerCase()
  const trimmedNew = newName.trim().toLowerCase()

  if (trimmedOld === trimmedNew) return ok(undefined)

  const errNew = validateTagName(trimmedNew)
  if (errNew) return fail(errNew)

  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT name FROM tags WHERE name = ?').get(trimmedNew)
    if (existing) throw new Error(`Ein Tag mit dem Namen '${trimmedNew}' existiert bereits`)

    db.prepare('UPDATE tags SET name = ? WHERE name = ?').run(trimmedNew, trimmedOld)

    const n = retagLiveEntries(db, trimmedOld, trimmedNew)

    log.info(`[tags] renamed '${trimmedOld}' → '${trimmedNew}' (${n} entries)`)
  })

  try {
    tx()
    return ok(undefined)
  } catch (e) {
    return fail(e)
  }
}

/**
 * Merges source tag into target:
 *   1. Fail if source === target.
 *   2. A new version per live entry: replace source with target.
 *   3. DELETE source from tags table.
 *
 * Exported for unit testing.
 */
export function mergeTag(db: Database.Database, source: string, target: string): IpcResult<void> {
  const trimmedSource = source.trim().toLowerCase()
  const trimmedTarget = target.trim().toLowerCase()

  if (trimmedSource === trimmedTarget) return fail('Quell- und Ziel-Tag dürfen nicht gleich sein')

  const tx = db.transaction(() => {
    const n = retagLiveEntries(db, trimmedSource, trimmedTarget)

    db.prepare('DELETE FROM tags WHERE name = ?').run(trimmedSource)

    log.info(`[tags] merged '${trimmedSource}' → '${trimmedTarget}' (${n} entries)`)
  })

  try {
    tx()
    return ok(undefined)
  } catch (e) {
    return fail(e)
  }
}

/**
 * Deletes a tag from the registry — only when entry count is 0.
 * Fails with a descriptive error if any entries still use the tag.
 *
 * Exported for unit testing.
 */
export function deleteTag(db: Database.Database, name: string): IpcResult<void> {
  const trimmed = name.trim().toLowerCase()

  try {
    const rows = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM entries WHERE deleted_at IS NULL AND tags LIKE '%,' || ? || ',%'`
      )
      .get(trimmed) as { cnt: number }

    if (rows.cnt > 0) {
      return fail(
        `Tag '${trimmed}' hat noch ${rows.cnt} Eintrag/Einträge und kann nicht gelöscht werden`
      )
    }

    db.prepare('DELETE FROM tags WHERE name = ?').run(trimmed)
    return ok(undefined)
  } catch (e) {
    return fail(e)
  }
}

/**
 * Registers all tag-related IPC handlers.
 * Called from registerIpcHandlers() in ipc.ts.
 */
export function registerTagHandlers(db: Database.Database): void {
  ipcMain.handle('tags:get-all-with-count', (): IpcResult<TagWithCount[]> => {
    return getAllTagsWithCount(db)
  })

  ipcMain.handle('tags:create', (_e, name: string): IpcResult<void> => {
    return createTag(db, name)
  })

  ipcMain.handle('tags:rename', (_e, oldName: string, newName: string): IpcResult<void> => {
    return renameTag(db, oldName, newName)
  })

  ipcMain.handle('tags:merge', (_e, source: string, target: string): IpcResult<void> => {
    return mergeTag(db, source, target)
  })

  ipcMain.handle('tags:delete', (_e, name: string): IpcResult<void> => {
    return deleteTag(db, name)
  })
}
