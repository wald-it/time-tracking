import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { handleRequest } from './mcpBridgeCore'
import { CREATE, makeCtx, seed } from '../test/bridgeKit'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { listEntries } from '../mcp/queries'

const raw = 'Grüße äöü ß\u202E\u200F\u0007\n\tEnde'
const escaped = 'Grüße äöü ß\\u{202E}\\u{200F}\\u{0007}\n\tEnde'

describe('MCP preview text (Q16)', () => {
  let DatabaseImpl: DatabaseCtor
  let db: Database.Database
  beforeAll(async () => {
    DatabaseImpl = await loadSqlite()
  })
  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
    db.prepare("UPDATE settings SET value = '1' WHERE key = 'mcp_expose_private_notes'").run()
    db.prepare('UPDATE clients SET name = ? WHERE id = 1').run(raw)
    db.prepare('UPDATE projects SET name = ? WHERE id = 10').run(raw)
  })
  afterEach(() => db.close())

  it('escapes create preview text but stores and reads the raw entry', async () => {
    const { ctx } = makeCtx(db)
    const request = {
      ...CREATE,
      args: {
        ...CREATE.args,
        description: raw,
        tags: raw,
        reference: raw,
        private_note: raw,
        project_id: 10
      }
    }
    const preview = await handleRequest(ctx, { ...request, preview: true })
    const write = await handleRequest(ctx, request)
    expect(write.ok).toBe(true)
    expect(
      db.prepare('SELECT description, tags, reference, private_note FROM entries').get()
    ).toEqual({
      description: raw,
      tags: raw,
      reference: raw,
      private_note: raw
    })
    const read = listEntries(
      db,
      { exposeRates: false, exposePrivateNotes: true },
      { year: 2026, month: 6 },
      Date.now()
    )
    expect(read.entries?.[0]).toMatchObject({ description: raw, private_note: raw })
    expect(preview).toMatchObject({
      ok: true,
      data: {
        preview: true,
        description: escaped,
        tags: escaped,
        reference: escaped,
        private_note: escaped,
        client_name: escaped,
        project_name: escaped,
        client_id: 1,
        project_id: 10,
        started_at: CREATE.args!.started_at,
        stopped_at: CREATE.args!.stopped_at,
        duration_min: 60
      }
    })
  })

  it('escapes nested changes, including names, without changing ids or timestamps', async () => {
    const { ctx } = makeCtx(db)
    const created = await handleRequest(ctx, {
      ...CREATE,
      args: { ...CREATE.args, description: raw, private_note: raw }
    })
    expect(created.ok).toBe(true)
    const { id } = db.prepare('SELECT id FROM entries').get() as { id: number }
    db.prepare('UPDATE clients SET name = ? WHERE id = 2').run(raw + '2')
    db.prepare('UPDATE projects SET name = ? WHERE id = 20').run(raw + '2')
    const result = await handleRequest(ctx, {
      v: 1,
      token: 'secret',
      op: 'update_entry_fields',
      preview: true,
      args: {
        id,
        description: raw + '2',
        private_note: raw + '2',
        tags: raw,
        reference: raw,
        client_id: 2,
        project_id: 20
      }
    })
    expect(result).toMatchObject({
      ok: true,
      data: {
        id,
        before: { description: escaped, started_at: CREATE.args!.started_at },
        after: { description: escaped + '2', started_at: CREATE.args!.started_at },
        changes: {
          description: { before: escaped, after: escaped + '2' },
          private_note: { before: escaped, after: escaped + '2' },
          tags: { before: '', after: escaped },
          reference: { before: '', after: escaped },
          client_id: { before: { id: 1, name: escaped }, after: { id: 2, name: escaped + '2' } },
          project_id: { before: null, after: { id: 20, name: escaped + '2' } }
        }
      }
    })
  })

  it('escapes start preview text and the nested client name of the timer it stops', async () => {
    const { ctx } = makeCtx(db)
    const request = {
      v: 1,
      token: 'secret',
      op: 'start_timer',
      args: { client_id: 1, description: raw, started_at: '2026-06-10T09:00:00.000Z' }
    }
    expect((await handleRequest(ctx, request)).ok).toBe(true)
    const result = await handleRequest(ctx, { ...request, preview: true })
    expect(result).toMatchObject({
      ok: true,
      data: { description: escaped, stops: { client_name: escaped, id: expect.any(Number) } }
    })
  })

  it('escapes every hidden character while preserving other Unicode and whitespace', async () => {
    const codes = [
      ...Array.from({ length: 9 }, (_, i) => i),
      11,
      12,
      ...Array.from({ length: 18 }, (_, i) => i + 14),
      ...Array.from({ length: 33 }, (_, i) => i + 127),
      0x061c,
      0x200e,
      0x200f,
      0x202a,
      0x202b,
      0x202c,
      0x202d,
      0x202e,
      0x2066,
      0x2067,
      0x2068,
      0x2069
    ]
    const unchanged = 'ÄÖÜ ß 😀\r\n\t\u2028\u2029'
    const { ctx } = makeCtx(db)
    const result = await handleRequest(ctx, {
      ...CREATE,
      preview: true,
      args: { ...CREATE.args, reference: String.fromCodePoint(...codes) + unchanged }
    })
    expect(result).toMatchObject({
      ok: true,
      data: {
        reference:
          codes.map((c) => `\\u{${c.toString(16).toUpperCase().padStart(4, '0')}}`).join('') +
          unchanged
      }
    })
  })
})
