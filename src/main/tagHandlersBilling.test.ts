import { beforeAll, expect, it } from 'vitest'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import { createRun } from './billingRuns'
import { readEntry } from './entryMutations'
import { mergeTag, renameTag } from './tagHandlers'

let Sqlite: DatabaseCtor
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
it.each(['rename', 'merge'])(
  'adds the automatic reason to billed zero-length recovery and >24h timers (%s)',
  async (operation) => {
    const db = new Sqlite(':memory:')
    try {
      applyMigrations(db)
      db.exec(
        "INSERT INTO clients (id, name, short_code) VALUES (1, 'A', 'A'); INSERT INTO tags (name) VALUES ('old'), ('target')"
      )
      seedEntry(db, {
        id: 1,
        client_id: 1,
        started_at: '2026-10-01T09:00:00Z',
        stopped_at: '2026-10-01T09:00:00Z',
        tags: ',old,',
        source: 'recovery'
      })
      seedEntry(db, {
        id: 2,
        client_id: 1,
        started_at: '2026-10-02T09:00:00Z',
        stopped_at: '2026-10-04T10:00:00Z',
        tags: ',old,'
      })
      await createRun(db, { clientId: 1, fromIso: '2026-10-01', toIso: '2026-10-31' }, async () =>
        Buffer.from('pdf')
      )
      const result =
        operation === 'rename' ? renameTag(db, 'old', 'new') : mergeTag(db, 'old', 'target')
      expect(result).toEqual({ ok: true, data: undefined })
      for (const id of [1, 2])
        expect(readEntry(db, id)).toMatchObject({
          billed: true,
          reason: 'Tag renamed',
          version_no: 2
        })
    } finally {
      db.close()
    }
  }
)
