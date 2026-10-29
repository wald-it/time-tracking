/**
 * #297: one rule (shared/startPair.lastStartPair), two feeds. Main decides
 * from the database whether the start hotkey / mini play key can start a pair
 * (startRequest.readStartPair); the renderer starts that pair, or prefills the
 * START dialog with it, from the dashboard summary and the project list
 * (readLastStartPair). For the same database both must name the same pair,
 * or main would forward a start the renderer then refuses (or the reverse).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../../../test/sqlite'
import { seed } from '../../../test/bridgeKit'
import { seedEntry } from '../../../test/entryFixtures'
import { readRecentEntries } from '../../../main/dashboardTotals'
import { readStartPair } from '../../../main/startRequest'
import type { Client, Project } from '../../../shared/types'
import { readLastStartPair } from './startTimerModalStore'
import { useTimerStore } from './timerStore'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

afterEach(() => {
  useTimerStore.setState({ clients: [] })
})

/** The renderer's view of `db`: the summary, the project list, the store's clients. */
function feedRenderer(db: Database.Database): void {
  const api = {
    dashboard: {
      summary: async () => ({
        ok: true as const,
        data: { recentEntries: readRecentEntries(db, 5) }
      })
    },
    projects: {
      // projects:getAll returns every status; the rule looks at `active`.
      getAll: async ({ clientId }: { clientId?: number }) => ({
        ok: true as const,
        data: db.prepare(`SELECT * FROM projects WHERE client_id = ?`).all(clientId) as Project[]
      })
    }
  }
  ;(window as unknown as { api: typeof api }).api = api
  useTimerStore.setState({
    clients: db.prepare(`SELECT * FROM clients ORDER BY id`).all() as Client[]
  })
}

function entry(
  db: Database.Database,
  client: number,
  project: number | null,
  day: string,
  deleted = false
): void {
  // 2.0 P2: `entries` is a read-only view; the fixture writes the entry tables
  // (a trashed entry is a deleted version, written at day T10:00).
  seedEntry(db, {
    client_id: client,
    project_id: project,
    started_at: `${day}T08:00:00.000Z`,
    stopped_at: `${day}T09:00:00.000Z`,
    heartbeat_at: `${day}T09:00:00.000Z`,
    deleted_at: deleted ? `${day}T10:00:00.000Z` : null
  })
}

// seed(): clients 1 + 2 active; projects 10 (active) and 30 (archived) of
// client 1, 20 (active) of client 2.
const CASES: Array<{ name: string; arrange: (db: Database.Database) => void }> = [
  { name: 'no entry yet', arrange: () => {} },
  { name: 'last entry with an active project', arrange: (db) => entry(db, 2, 20, '2026-10-22') },
  { name: 'last entry without a project', arrange: (db) => entry(db, 1, null, '2026-10-22') },
  { name: 'last entry on an archived project', arrange: (db) => entry(db, 1, 30, '2026-10-22') },
  {
    name: 'last entry’s client archived, an older one active',
    arrange: (db) => {
      entry(db, 1, 10, '2026-10-21')
      entry(db, 2, 20, '2026-10-22')
      db.prepare(`UPDATE clients SET active = 0 WHERE id = 2`).run()
    }
  },
  {
    name: 'newest entry in the trash',
    arrange: (db) => {
      entry(db, 2, 20, '2026-10-21')
      entry(db, 1, 10, '2026-10-22', true)
    }
  }
]

describe('main and renderer name the same start pair', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const db = new DatabaseImpl(':memory:')
      seed(db)
      c.arrange(db)
      feedRenderer(db)

      expect(await readLastStartPair()).toEqual(readStartPair(db))
      db.close()
    })
  }

  it('the cases cover both outcomes', async () => {
    // A guard against a table where every case is null (or none is), which
    // would agree trivially.
    const outcomes = new Set<boolean>()
    for (const c of CASES) {
      const db = new DatabaseImpl(':memory:')
      seed(db)
      c.arrange(db)
      outcomes.add(readStartPair(db) === null)
      db.close()
    }
    expect([...outcomes].sort()).toEqual([false, true])
  })
})
