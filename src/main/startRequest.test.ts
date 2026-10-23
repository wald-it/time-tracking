/**
 * #297: what the global start hotkey and the mini widget's play key do, and
 * that only an explicit press of one of them brings the window forward.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seed } from '../test/bridgeKit'
import { decideStartRequest, readStartPair } from './startRequest'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

/** seed(): clients 1 Acme + 2 Beta (active), projects 10 + 30 (archived) of 1, 20 of 2. */
function freshDb(): Database.Database {
  const db = new DatabaseImpl(':memory:')
  seed(db)
  return db
}

function addEntry(
  db: Database.Database,
  e: {
    client_id: number
    project_id?: number | null
    started_at: string
    stopped_at?: string | null
  }
): void {
  db.prepare(
    `INSERT INTO entries (client_id, project_id, description, started_at, stopped_at, heartbeat_at)
     VALUES (?, ?, '', ?, ?, ?)`
  ).run(e.client_id, e.project_id ?? null, e.started_at, e.stopped_at ?? null, e.started_at)
}

describe('decideStartRequest', () => {
  it('forwards the toggle when the last entry gives a pair', () => {
    const db = freshDb()
    addEntry(db, {
      client_id: 2,
      project_id: 20,
      started_at: '2026-10-22T08:00:00.000Z',
      stopped_at: '2026-10-22T09:00:00.000Z'
    })
    expect(readStartPair(db)).toEqual({ clientId: 2, projectId: 20 })
    expect(decideStartRequest(db)).toBe('toggle')
    db.close()
  })

  it('opens the START dialog when the last entry’s client is archived', () => {
    const db = freshDb()
    addEntry(db, {
      client_id: 1,
      started_at: '2026-10-21T08:00:00.000Z',
      stopped_at: '2026-10-21T09:00:00.000Z'
    })
    addEntry(db, {
      client_id: 2,
      started_at: '2026-10-22T08:00:00.000Z',
      stopped_at: '2026-10-22T09:00:00.000Z'
    })
    db.prepare(`UPDATE clients SET active = 0 WHERE id = 2`).run()
    // Client 1 is active, but it is not the last pair: no guess.
    expect(readStartPair(db)).toBeNull()
    expect(decideStartRequest(db)).toBe('open-start')
    db.close()
  })

  it('opens the START dialog when there is no entry yet', () => {
    const db = freshDb()
    expect(decideStartRequest(db)).toBe('open-start')
    db.close()
  })

  it('keeps the toggle while a timer runs, also without a pair: the key stops it', () => {
    const db = freshDb()
    addEntry(db, { client_id: 2, started_at: '2026-10-22T08:00:00.000Z' })
    db.prepare(`UPDATE clients SET active = 0 WHERE id = 2`).run()
    expect(decideStartRequest(db)).toBe('toggle')
    db.close()
  })

  it('ignores entries in the trash', () => {
    const db = freshDb()
    addEntry(db, {
      client_id: 2,
      project_id: 20,
      started_at: '2026-10-21T08:00:00.000Z',
      stopped_at: '2026-10-21T09:00:00.000Z'
    })
    addEntry(db, {
      client_id: 1,
      started_at: '2026-10-22T08:00:00.000Z',
      stopped_at: '2026-10-22T09:00:00.000Z'
    })
    db.prepare(
      `UPDATE entries SET deleted_at = '2026-10-22T10:00:00.000Z' WHERE client_id = 1`
    ).run()
    expect(readStartPair(db)).toEqual({ clientId: 2, projectId: 20 })
    db.close()
  })
})

// The window comes forward only on an explicit press of the start hotkey or
// the mini widget's play key — never because of a background event. Main's
// entry file wires Electron and cannot be loaded in a test, so its source is
// checked: one sender of `timer:open-start`, reachable from exactly those two.
describe('timer:open-start is sent only from the start hotkey and mini play', () => {
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')

  it('is sent in one place, onStartKey', () => {
    // String literals only; comments name the channel in backticks.
    const sends = source.match(/['"]timer:open-start['"]/g) ?? []
    expect(sends).toHaveLength(1)
    const body = source.slice(
      source.indexOf('function onStartKey(): void {'),
      source.indexOf('\n}\n', source.indexOf('function onStartKey(): void {'))
    )
    expect(body).toContain("send('timer:open-start')")
  })

  it('onStartKey is used only by the start hotkey and mini:request-start', () => {
    const uses = [...source.matchAll(/^.*\bonStartKey\b.*$/gm)].map((m) => m[0].trim())
    expect(uses).toEqual([
      'function onStartKey(): void {',
      'const ok = globalShortcut.register(accelerator, onStartKey)',
      'globalShortcut.register(currentToggleHotkey, onStartKey)',
      "ipcMain.on('mini:request-start', onStartKey)"
    ])
  })
})
