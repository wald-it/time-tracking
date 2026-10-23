/**
 * Q8 (2.0.0): the description field suggests the user's own recent texts for
 * the same client and project — recognition instead of recall, no model.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seed } from '../test/bridgeKit'
import { parseSuggestionArgs, readDescriptionSuggestions } from './descriptionSuggestions'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

/** seed(): clients 1 + 2, projects 10 + 30 of client 1, 20 of client 2. */
function freshDb(): Database.Database {
  const db = new DatabaseImpl(':memory:')
  seed(db)
  return db
}

function entry(
  db: Database.Database,
  e: { client: number; project: number | null; description: string; day: string; deleted?: boolean }
): void {
  db.prepare(
    `INSERT INTO entries (client_id, project_id, description, started_at, stopped_at, heartbeat_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    e.client,
    e.project,
    e.description,
    `${e.day}T08:00:00.000Z`,
    `${e.day}T09:00:00.000Z`,
    `${e.day}T09:00:00.000Z`,
    e.deleted ? `${e.day}T10:00:00.000Z` : null
  )
}

describe('readDescriptionSuggestions', () => {
  it('names the texts of the same client and project, newest use first, each once', () => {
    const db = freshDb()
    entry(db, { client: 1, project: 10, description: 'Rollout: Planung', day: '2026-10-20' })
    entry(db, { client: 1, project: 10, description: 'Rollout: Abstimmung', day: '2026-10-21' })
    entry(db, { client: 1, project: 10, description: 'Rollout: Planung', day: '2026-10-22' })
    // Other project, other client, no project: not this pair.
    entry(db, { client: 1, project: 30, description: 'Altlast', day: '2026-10-22' })
    entry(db, { client: 2, project: 20, description: 'Audit', day: '2026-10-22' })
    entry(db, { client: 1, project: null, description: 'Ohne Projekt', day: '2026-10-22' })

    expect(readDescriptionSuggestions(db, 1, 10)).toEqual([
      'Rollout: Planung',
      'Rollout: Abstimmung'
    ])
    db.close()
  })

  it('treats "no project" as a pair of its own', () => {
    const db = freshDb()
    entry(db, { client: 1, project: null, description: 'Ohne Projekt', day: '2026-10-22' })
    entry(db, { client: 1, project: 10, description: 'Mit Projekt', day: '2026-10-22' })

    expect(readDescriptionSuggestions(db, 1, null)).toEqual(['Ohne Projekt'])
    db.close()
  })

  it('leaves out empty texts and entries in the trash, and trims', () => {
    const db = freshDb()
    entry(db, { client: 1, project: 10, description: '   ', day: '2026-10-20' })
    entry(db, { client: 1, project: 10, description: 'Gelöscht', day: '2026-10-21', deleted: true })
    entry(db, { client: 1, project: 10, description: '  Review  ', day: '2026-10-22' })
    entry(db, { client: 1, project: 10, description: 'Review', day: '2026-10-19' })

    expect(readDescriptionSuggestions(db, 1, 10)).toEqual(['Review'])
    db.close()
  })

  it('gives at most eight', () => {
    const db = freshDb()
    for (let d = 1; d <= 12; d++) {
      entry(db, {
        client: 1,
        project: 10,
        description: `Text ${d}`,
        day: `2026-10-${String(d).padStart(2, '0')}`
      })
    }

    const got = readDescriptionSuggestions(db, 1, 10)
    expect(got).toHaveLength(8)
    expect(got[0]).toBe('Text 12')
    db.close()
  })
})

describe('parseSuggestionArgs', () => {
  it('takes integer ids, and null for "no project"', () => {
    expect(parseSuggestionArgs({ clientId: 1, projectId: 10 })).toEqual({
      clientId: 1,
      projectId: 10
    })
    expect(parseSuggestionArgs({ clientId: 1, projectId: null })).toEqual({
      clientId: 1,
      projectId: null
    })
  })

  it('refuses anything else', () => {
    for (const bad of [
      undefined,
      null,
      'x',
      {},
      { clientId: '1', projectId: null },
      { clientId: 1.5, projectId: null },
      { clientId: null, projectId: null },
      { clientId: 1 },
      { clientId: 1, projectId: '10' },
      { clientId: 1, projectId: 2.5 },
      { clientId: Number.NaN, projectId: null }
    ]) {
      expect(parseSuggestionArgs(bad)).toBeNull()
    }
  })
})
