/**
 * Codex counter-check on 2.0 P2 (round 2): the packaged smoke test seeded an
 * entry at 08:00 local of the current day. Run before 08:00, `writeEntry`
 * refused it as a start in the future, and PR packaging and the release smoke
 * went red for no reason but the hour.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seed } from '../test/bridgeKit'
import { writeEntry } from './entryMutations'
import { buildPdfPayload } from './pdf'
import { smokeEntryRange } from './smokeSeed'

let DatabaseImpl: DatabaseCtor
beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

describe('the smoke entry (smokeEntryRange)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new DatabaseImpl(':memory:')
    seed(db)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Every hour of a day, in the local zone: the range lies in the past.
  it.each([0, 6, 7, 8, 9, 12, 23])('lies in the past at %i:00 local', (hour) => {
    const now = new Date(2026, 5, 10, hour, 0)
    const r = smokeEntryRange(now)
    expect(Date.parse(r.stopIso)).toBeLessThanOrEqual(now.getTime())
    expect(Date.parse(r.stopIso) - Date.parse(r.startIso)).toBe(3_600_000)
  })

  it('is accepted by writeEntry at 06:00 local, and the PDF for its day holds it', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 5, 10, 6, 0))
    const r = smokeEntryRange(new Date())
    const seeded = writeEntry(
      db,
      {
        op: 'create',
        fields: {
          client_id: 1,
          description: 'smoke',
          started_at: r.startIso,
          stopped_at: r.stopIso
        }
      },
      { source: 'app' }
    )
    expect(seeded).toMatchObject({ ok: true })
    const payload = buildPdfPayload(db, { clientId: 1, fromIso: r.dayKey, toIso: r.dayKey }, '')
    expect(payload.rows).toHaveLength(1)
  })
})
