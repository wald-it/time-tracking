/**
 * Q31 — the bridge protocol carries a version both ways. A request names the
 * version it was written for; a request for another version gets the code
 * `unsupported_version` and changes nothing; every response carries the
 * app's version. docs/integration-contract.md describes the protocol.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import {
  BRIDGE_PROTOCOL_VERSION,
  encodeResponse,
  handleRequest,
  type BridgeRequest
} from './mcpBridgeCore'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { CREATE, countEntries, makeCtx, seed } from '../test/bridgeKit'

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

describe('bridge protocol version (Q31)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
  })

  it('speaks version 1', () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(1)
  })

  it('a request for another version is told so, and nothing happens', async () => {
    const { ctx, spies } = makeCtx(db)
    const res = await handleRequest(ctx, { ...CREATE, v: 2 })
    expect(res).toMatchObject({ ok: false, code: 'unsupported_version' })
    expect(res.ok === false && res.error).toMatch(/Version 1/)
    expect(countEntries(db)).toBe(0)
    expect(spies.confirmCalls).toBe(0)
    expect(spies.auditCalls).toBe(0)
  })

  it('the version is checked before the token, so an old client learns why', async () => {
    const { ctx } = makeCtx(db)
    const res = await handleRequest(ctx, { ...CREATE, v: 2, token: 'wrong' })
    expect(res).toMatchObject({ ok: false, code: 'unsupported_version' })
  })

  it('a request without a version, or with a version that is not a number, stays invalid', async () => {
    const { ctx } = makeCtx(db)
    const { v: _omit, ...noVersion } = CREATE
    expect(await handleRequest(ctx, noVersion as BridgeRequest)).toMatchObject({ code: 'invalid' })
    expect(
      await handleRequest(ctx, { ...CREATE, v: '1' } as unknown as BridgeRequest)
    ).toMatchObject({ code: 'invalid' })
  })

  it('version 1 works as before', async () => {
    const { ctx } = makeCtx(db)
    expect((await handleRequest(ctx, CREATE)).ok).toBe(true)
    expect(countEntries(db)).toBe(1)
  })

  it('every response line carries the app version', () => {
    const ok = JSON.parse(encodeResponse({ ok: true, data: { id: 7 } }))
    expect(ok).toEqual({ v: 1, ok: true, data: { id: 7 } })
    const bad = JSON.parse(encodeResponse({ ok: false, error: 'x', code: 'invalid' }))
    expect(bad).toEqual({ v: 1, ok: false, error: 'x', code: 'invalid' })
    expect(encodeResponse({ ok: true, data: null }).endsWith('\n')).toBe(true)
  })
})
