import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { readEntry, startTimer, stopEntryAt } from './entryMutations'

let Sqlite: DatabaseCtor
let db: Database.Database

beforeAll(async () => {
  Sqlite = await loadSqlite()
})

beforeEach(() => {
  db = new Sqlite(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  db.exec("INSERT INTO clients (id, name) VALUES (1, 'Client')")
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 5, 11, 8))
})

afterEach(() => {
  vi.useRealTimers()
  db.close()
})

it('stopAt after overnight sleep seals 09:00–18:00 on the previous day without a midnight split', () => {
  const startedAt = new Date(2026, 5, 10, 9).toISOString()
  const awaySince = new Date(2026, 5, 10, 18).toISOString()
  const started = startTimer(db, {
    client_id: 1,
    description: 'Work before sleep',
    started_at: startedAt
  })
  if (!started.ok) throw new Error(started.error)
  const stopped = stopEntryAt(db, started.data.id, awaySince, { source: 'idle' })
  expect(stopped).toMatchObject({ ok: true, data: { stopped_at: awaySince } })
  expect(readEntry(db, started.data.id)).toMatchObject({
    state: 'sealed',
    source: 'idle',
    segments: [{ seq: 0, segment_date: '2026-06-10', started_at: startedAt, stopped_at: awaySince }]
  })
})

// Closed-entry midnight splitting is already covered in entryMutations.test.ts:
// 'createManualEntry splits across local midnight into two segments of one entry'.
