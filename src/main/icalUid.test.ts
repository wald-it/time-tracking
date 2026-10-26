/**
 * iCal UIDs per segment (2.0 P3, design sections 6 and 11.8, #372 item 3):
 * `timetrack-entry-<id>-<segment_date>@wald-it.com`. The two days of an entry
 * across midnight get distinct UIDs, and an edit that adds a day in front
 * leaves the UID of the existing day alone.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seed } from '../test/bridgeKit'
import { formatIcal } from '../shared/ical'
import { createManualEntry, updateManualEntry } from './entryMutations'
import type { Client, Entry } from '../shared/types'

let Ctor: DatabaseCtor
beforeAll(async () => {
  Ctor = await loadSqlite()
})

const uidsOf = (db: Database.Database): string[] => {
  const rows = db.prepare(`SELECT * FROM entries ORDER BY id, segment_seq`).all() as Entry[]
  const clients = new Map<number, Client>(
    (db.prepare(`SELECT * FROM clients`).all() as Client[]).map((c) => [c.id, c])
  )
  const ics = formatIcal(rows, clients, new Map())
  return [...ics.matchAll(/^UID:(.+)$/gm)].map((m) => m[1].trim())
}

describe('iCal UID per segment', () => {
  it('a midnight entry gets one UID per day, built from the entry id and the segment date', () => {
    const db = new Ctor(':memory:')
    seed(db)
    const night = createManualEntry(db, {
      client_id: 1,
      description: 'Nacht',
      started_at: new Date(2026, 5, 10, 23, 0, 0).toISOString(),
      stopped_at: new Date(2026, 5, 11, 1, 0, 0).toISOString()
    })
    if (!night.ok) throw new Error(night.error)
    const id = night.data.id
    expect(uidsOf(db)).toEqual([
      `timetrack-entry-${id}-2026-06-10@wald-it.com`,
      `timetrack-entry-${id}-2026-06-11@wald-it.com`
    ])
    db.close()
  })

  it('an edit that adds a day in front keeps the UID of the existing day', () => {
    const db = new Ctor(':memory:')
    seed(db)
    const e = createManualEntry(db, {
      client_id: 1,
      description: 'Arbeit',
      started_at: new Date(2026, 5, 10, 9, 0, 0).toISOString(),
      stopped_at: new Date(2026, 5, 10, 10, 0, 0).toISOString()
    })
    if (!e.ok) throw new Error(e.error)
    const id = e.data.id
    expect(uidsOf(db)).toEqual([`timetrack-entry-${id}-2026-06-10@wald-it.com`])

    const edited = updateManualEntry(db, {
      id,
      started_at: new Date(2026, 5, 9, 22, 0, 0).toISOString()
    })
    if (!edited.ok) throw new Error(edited.error)
    expect(uidsOf(db)).toEqual([
      `timetrack-entry-${id}-2026-06-09@wald-it.com`,
      `timetrack-entry-${id}-2026-06-10@wald-it.com`
    ])
    db.close()
  })
})
