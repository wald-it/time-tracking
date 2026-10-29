import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'

const previousTz = process.env.TZ
let Sqlite: DatabaseCtor
beforeAll(async () => {
  process.env.TZ = 'Europe/Berlin'
  vi.resetModules()
  Sqlite = await loadSqlite()
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
  vi.resetModules()
})
it('documents timezone-dependent re-rendering while the archived PDF stays unchanged (section 12)', async () => {
  const berlin = await import('./billingRuns')
  const db = new Sqlite(':memory:')
  try {
    applyMigrations(db)
    db.exec("INSERT INTO clients (id, name, short_code) VALUES (1, 'A', 'A')")
    seedEntry(db, {
      client_id: 1,
      started_at: '2026-10-20T09:00:00Z',
      stopped_at: '2026-10-20T10:00:00Z'
    })
    const created = await berlin.createRun(
      db,
      { clientId: 1, fromIso: '2026-10-01', toIso: '2026-10-31' },
      async (html) => Buffer.from(html)
    )
    const original = berlin.renderRunHtml(db, created.id)
    expect(original).toContain('11:00')
    const bytes = berlin.openRunPdf(db, created.id)
    process.env.TZ = 'America/New_York'
    vi.resetModules()
    const newYork = await import('./billingRuns')
    const changed = newYork.renderRunHtml(db, created.id)
    expect(changed).toContain('05:00')
    expect(changed).not.toBe(original)
    expect(newYork.verifyRunHtml(db, created.id)).toBe(false)
    expect(newYork.openRunPdf(db, created.id)).toEqual(bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(created.pdf_sha256)
  } finally {
    db.close()
  }
})
