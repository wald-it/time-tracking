/**
 * MCP contracts of 2.0 P3 over the real bridge (`handleRequest`) and the real
 * read layer: acceptance criterion 4 (an id stays valid, `update_entry_fields`
 * returns it with a higher version), #372 item 1 (the shrink case of an entry
 * across midnight), `expected_version`, `reason` and the lookup of 1.x ids.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { handleRequest, type BridgeRequest } from './mcpBridgeCore'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { makeCtx, seed } from '../test/bridgeKit'
import { seedEntry } from '../test/entryFixtures'
import { listEntries } from '../mcp/queries'
import type { PrivacyConfig } from '../mcp/privacy'

const HIDE: PrivacyConfig = { exposeRates: false, exposePrivateNotes: false }
let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

let db: Database.Database
beforeEach(() => {
  db = new DatabaseImpl(':memory:')
  seed(db)
})
afterEach(() => db.close())

const local = (d: number, h: number): string => new Date(2026, 5, d, h, 0, 0).toISOString()
const req = (op: string, args: Record<string, unknown>): BridgeRequest => ({
  v: 1,
  token: 'secret',
  op: op as BridgeRequest['op'],
  args
})
const rangeOf = (id: number): { started_at: string; stopped_at: string } =>
  db
    .prepare(
      `SELECT MIN(started_at) AS started_at, MAX(stopped_at) AS stopped_at FROM entries WHERE id = ?`
    )
    .get(id) as { started_at: string; stopped_at: string }
const versionRow = (id: number): { version_no: number; reason: string | null } =>
  db
    .prepare(
      `SELECT v.version_no, v.reason FROM entry e JOIN entry_version v ON v.id = e.current_version_id WHERE e.id = ?`
    )
    .get(id) as { version_no: number; reason: string | null }

/** An entry 20:00 to 04:00 across midnight, created through the bridge. */
async function createNight(): Promise<number> {
  const { ctx } = makeCtx(db)
  const made = await handleRequest(
    ctx,
    req('create_manual_entry', {
      client_id: 1,
      description: 'Nachtschicht',
      started_at: local(20, 20),
      stopped_at: local(21, 4)
    })
  )
  if (!made.ok) throw new Error(made.error)
  return (made.data as { id: number }).id
}

describe('MCP contracts (2.0 P3)', () => {
  it('create returns the id and version 1', async () => {
    const { ctx } = makeCtx(db)
    const res = await handleRequest(
      ctx,
      req('create_manual_entry', {
        client_id: 1,
        started_at: local(22, 9),
        stopped_at: local(22, 10)
      })
    )
    expect(res.ok && res.data).toMatchObject({ version: 1 })
  })

  it('update returns the same id with a higher version, and the id stays valid after several edits (criterion 4)', async () => {
    const id = await createNight()
    const { ctx } = makeCtx(db)
    for (let i = 1; i <= 3; i++) {
      const res = await handleRequest(
        ctx,
        req('update_entry_fields', { id, description: `Stand ${i}` })
      )
      expect(res.ok && res.data).toMatchObject({ id, version: 1 + i })
    }
    expect(versionRow(id).version_no).toBe(4)
  })

  it('#372 shrink case: reading list_entries and writing the item back does not shorten the entry', async () => {
    const id = await createNight()
    const before = rangeOf(id)
    const list = listEntries(db, HIDE, { from: local(20, 0), to: local(23, 0) }, Date.now())
    const items = list.entries!.filter((e) => e.id === id)
    // One item with the whole range, not two halves with one id.
    expect(items).toHaveLength(1)
    const item = items[0]
    expect(item.started_at).toBe(before.started_at)
    expect(item.stopped_at).toBe(before.stopped_at)

    const { ctx } = makeCtx(db)
    const res = await handleRequest(
      ctx,
      req('update_entry_fields', {
        id,
        started_at: item.started_at,
        stopped_at: item.stopped_at,
        expected_version: item.version
      })
    )
    expect(res.ok).toBe(true)
    expect(rangeOf(id)).toEqual(before)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE id = ?`).get(id)).toEqual({ n: 2 })
  })

  it('#372: the preview of a time change shows the whole range as "before", not one half', async () => {
    const id = await createNight()
    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, {
      ...req('update_entry_fields', { id, started_at: local(21, 1) }),
      preview: true
    })
    expect(res.ok).toBe(true)
    const data = res.ok
      ? (res.data as { before: { started_at: string; stopped_at: string } })
      : null
    expect(data!.before.started_at).toBe(local(20, 20))
    expect(data!.before.stopped_at).toBe(local(21, 4))
  })

  it('expected_version: a stale version is refused and nothing changes', async () => {
    const id = await createNight()
    const { ctx } = makeCtx(db)
    await handleRequest(ctx, req('update_entry_fields', { id, description: 'zweite Fassung' }))
    const res = await handleRequest(
      ctx,
      req('update_entry_fields', { id, description: 'veraltet', expected_version: 1 })
    )
    expect(res).toMatchObject({ ok: false, code: 'invalid' })
    expect(versionRow(id).version_no).toBe(2)
    const row = db.prepare(`SELECT description FROM entries WHERE id = ? LIMIT 1`).get(id) as {
      description: string
    }
    expect(row.description).toBe('zweite Fassung')
  })

  it('expected_version equal to the current version is accepted', async () => {
    const id = await createNight()
    const { ctx } = makeCtx(db)
    const res = await handleRequest(
      ctx,
      req('update_entry_fields', { id, description: 'passt', expected_version: 1 })
    )
    expect(res.ok && res.data).toMatchObject({ id, version: 2 })
  })

  it('reason is stored on the version it writes', async () => {
    const id = await createNight()
    const { ctx } = makeCtx(db)
    await handleRequest(
      ctx,
      req('update_entry_fields', { id, description: 'korrigiert', reason: 'Tippfehler' })
    )
    expect(versionRow(id)).toEqual({ version_no: 2, reason: 'Tippfehler' })
  })

  describe('ids from 1.x', () => {
    // A 1.x pair 10 / 11 became entry 10; 11 resolves through entry_legacy_id.
    function legacyPair(): number {
      const id = seedEntry(db, {
        id: 10,
        client_id: 1,
        description: 'Altbestand',
        segments: [
          { started_at: local(20, 20), stopped_at: local(21, 0) },
          { started_at: local(21, 0), stopped_at: local(21, 4) }
        ]
      })
      db.prepare(
        `INSERT OR IGNORE INTO entry_legacy_id (legacy_id, entry_id) VALUES (10, 10)`
      ).run()
      db.prepare(`INSERT INTO entry_legacy_id (legacy_id, entry_id) VALUES (11, 10)`).run()
      return id
    }

    it('the id of a second half resolves to its entry', async () => {
      const id = legacyPair()
      const { ctx } = makeCtx(db)
      const res = await handleRequest(
        ctx,
        req('update_entry_fields', { id: 11, description: 'neu' })
      )
      expect(res.ok && res.data).toMatchObject({ id, version: 2 })
    })

    it('moving the midnight edge through the id of the second half is refused, as in 1.x (#372 shrink)', async () => {
      const id = legacyPair()
      const before = rangeOf(id)
      const { ctx } = makeCtx(db)
      const res = await handleRequest(
        ctx,
        req('update_entry_fields', { id: 11, started_at: local(21, 1) })
      )
      expect(res).toMatchObject({ ok: false, code: 'invalid' })
      expect(rangeOf(id)).toEqual(before)
    })

    it('moving the end through the id of the second half moves the end of the entry', async () => {
      const id = legacyPair()
      const { ctx } = makeCtx(db)
      const res = await handleRequest(
        ctx,
        req('update_entry_fields', { id: 11, stopped_at: local(21, 5) })
      )
      expect(res.ok).toBe(true)
      expect(rangeOf(id)).toEqual({ started_at: local(20, 20), stopped_at: local(21, 5) })
    })

    it('after the entry shrank to one day, the id of the dropped half still edits the entry fields but not its times', async () => {
      const id = legacyPair()
      const { ctx } = makeCtx(db)
      const shrunk = await handleRequest(
        ctx,
        req('update_entry_fields', { id, started_at: local(20, 20), stopped_at: local(20, 23) })
      )
      expect(shrunk.ok).toBe(true)
      const fields = await handleRequest(
        ctx,
        req('update_entry_fields', { id: 11, description: 'nach dem Kürzen' })
      )
      expect(fields.ok && fields.data).toMatchObject({ id })
      const times = await handleRequest(
        ctx,
        req('update_entry_fields', { id: 11, stopped_at: local(20, 22) })
      )
      expect(times).toMatchObject({ ok: false, code: 'invalid' })
      expect(rangeOf(id)).toEqual({ started_at: local(20, 20), stopped_at: local(20, 23) })
    })

    it('the id of the second half follows its day when an edit drops the first day', async () => {
      const id = legacyPair()
      // The 1.x rows stay in entries_v1; row 11 started on the 21st.
      db.exec('DROP TRIGGER trg_entries_v1_insert') // read-only for the app, not for this fixture
      const v1 = db.prepare(
        `INSERT INTO entries_v1 (id, client_id, started_at, stopped_at) VALUES (?, 1, ?, ?)`
      )
      v1.run(10, local(20, 20), local(21, 0))
      v1.run(11, local(21, 0), local(21, 4))
      const { ctx } = makeCtx(db)
      // Drop the 20th: the 21st is now the entry's only segment, at seq 0.
      const cut = await handleRequest(
        ctx,
        req('update_entry_fields', { id, started_at: local(21, 1), stopped_at: local(21, 4) })
      )
      expect(cut.ok).toBe(true)
      const res = await handleRequest(
        ctx,
        req('update_entry_fields', { id: 11, stopped_at: local(21, 5) })
      )
      expect(res.ok).toBe(true)
      expect(rangeOf(id)).toEqual({ started_at: local(21, 1), stopped_at: local(21, 5) })
    })

    it('an id that is neither an entry nor a legacy id is refused', async () => {
      const { ctx } = makeCtx(db)
      const res = await handleRequest(
        ctx,
        req('update_entry_fields', { id: 999, description: 'x' })
      )
      expect(res).toMatchObject({ ok: false, code: 'invalid' })
    })
  })
})
