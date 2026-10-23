import { app, ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import log from 'electron-log/main'
import type { IpcResult } from '../shared/types'
import { MAX_TAG_LEN, TAG_RE } from '../shared/tags'
import { appLocale, dialogT, type DialogT } from './mainI18n'

export interface TagWithCount {
  name: string
  count: number
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function fail(error: unknown): IpcResult<never> {
  // The message, not `Error: <message>`: the renderer shows it as a toast (#296).
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/** The tag texts in the app language (#296 part B). */
function tFor(db: Database.Database): DialogT {
  return dialogT(
    appLocale(
      () => db,
      () => app.getPreferredSystemLanguages()
    )
  )
}

function validateTagName(t: DialogT, name: string): string | null {
  const trimmed = name.trim().toLowerCase()
  if (trimmed.length === 0) return t('mainError.tag.empty')
  if (trimmed.length > MAX_TAG_LEN) return t('mainError.tag.tooLong', { max: MAX_TAG_LEN })
  if (/\s/.test(trimmed)) {
    return t('mainError.tag.whitespace')
  }
  if (!TAG_RE.test(trimmed)) {
    return t('mainError.tag.chars')
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
  const t = tFor(db)
  const err = validateTagName(t, trimmed)
  if (err) return fail(err)

  try {
    const existing = db.prepare('SELECT name FROM tags WHERE name = ?').get(trimmed)
    if (existing) return fail(t('mainError.tag.exists', { tag: trimmed }))
    db.prepare('INSERT INTO tags (name) VALUES (?)').run(trimmed)
    return ok(undefined)
  } catch (e) {
    return fail(e)
  }
}

/**
 * Renames a tag atomically:
 *   1. No-op if oldName === newName.
 *   2. Fail if newName already exists.
 *   3. UPDATE tags.name.
 *   4. UPDATE entries.tags via REPLACE() for all affected rows.
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

  const t = tFor(db)
  const errNew = validateTagName(t, trimmedNew)
  if (errNew) return fail(errNew)

  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT name FROM tags WHERE name = ?').get(trimmedNew)
    if (existing) throw new Error(t('mainError.tag.renameExists', { tag: trimmedNew }))

    db.prepare('UPDATE tags SET name = ? WHERE name = ?').run(trimmedNew, trimmedOld)

    db.prepare(
      `UPDATE entries
       SET tags = REPLACE(tags, ',' || ? || ',', ',' || ? || ',')
       WHERE tags LIKE '%,' || ? || ',%'`
    ).run(trimmedOld, trimmedNew, trimmedOld)

    log.info(`[tags] renamed '${trimmedOld}' → '${trimmedNew}'`)
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
 *   2. UPDATE all entries: replace source with target.
 *   3. DELETE source from tags table.
 *
 * Exported for unit testing.
 */
export function mergeTag(db: Database.Database, source: string, target: string): IpcResult<void> {
  const trimmedSource = source.trim().toLowerCase()
  const trimmedTarget = target.trim().toLowerCase()

  if (trimmedSource === trimmedTarget) return fail(tFor(db)('mainError.tag.mergeSame'))

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE entries
       SET tags = REPLACE(tags, ',' || ? || ',', ',' || ? || ',')
       WHERE tags LIKE '%,' || ? || ',%'`
    ).run(trimmedSource, trimmedTarget, trimmedSource)

    db.prepare('DELETE FROM tags WHERE name = ?').run(trimmedSource)

    log.info(`[tags] merged '${trimmedSource}' → '${trimmedTarget}'`)
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
      return fail(tFor(db)('mainError.tag.inUse', { tag: trimmed, count: rows.cnt }))
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
