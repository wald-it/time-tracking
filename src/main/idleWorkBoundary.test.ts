import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { createManualEntry, readEntry, startTimer, stopEntryAt } from './entryMutations'

let Sqlite: DatabaseCtor
const previousTz = process.env.TZ
beforeAll(async () => {
  process.env.TZ = 'Europe/Berlin'
  Sqlite = await loadSqlite()
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})
afterEach(() => vi.useRealTimers())

it('books idle work for the same client at the exact stop boundary, including milliseconds', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const now = new Date(2026, 10, 2, 12)
  vi.setSystemTime(now)
  const db = new Sqlite(':memory:')
  try {
    applyMigrations(db)
    db.exec("INSERT INTO clients (id, name) VALUES (1, 'Client')")
    const running = startTimer(db, {
      client_id: 1,
      description: 'Work',
      started_at: new Date(2026, 10, 2, 10).toISOString()
    })
    expect(running.ok).toBe(true)
    if (!running.ok) throw new Error(running.error)
    const boundary = new Date(2026, 10, 2, 11, 23, 45, 678).toISOString()
    const stopped = stopEntryAt(db, running.data.id, boundary, { source: 'idle' })
    expect(stopped).toMatchObject({ ok: true, data: { stopped_at: boundary } })
    const booked = createManualEntry(db, {
      client_id: 1,
      project_id: null,
      description: '',
      started_at: boundary,
      stopped_at: now.toISOString(),
      source: 'idle'
    })
    expect(booked).toMatchObject({
      ok: true,
      data: { started_at: boundary, stopped_at: now.toISOString(), billable: 1 }
    })
    if (!booked.ok) throw new Error(booked.error)
    expect(readEntry(db, booked.data.id)?.source).toBe('idle')
    expect(readEntry(db, running.data.id)?.stopped_at).toBe(booked.data.started_at)
  } finally {
    db.close()
  }
})
