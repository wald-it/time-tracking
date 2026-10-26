import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, readFileSync, rmSync } from 'fs'
import { buildBudgetStatus } from './budgetHandlers'
import { createManualEntry, startTimer, stopEntry, switchTimer, writeEntry } from './entryMutations'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'

/** An ISO instant `sec` seconds before now (timer starts may not lie in the future). */
function secondsAgo(sec: number): string {
  return new Date(Date.now() - sec * 1000).toISOString()
}

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

describe('buildBudgetStatus', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = join(tmpdir(), `budget-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
    db = new DatabaseImpl(join(tmpDir, 'test.db'))
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    // Seed a client so foreign-key constraints are satisfied
    db.prepare(`INSERT INTO clients (id, name) VALUES (1, 'Test Client')`).run()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns budgetMinutes=null when project has no budget set', () => {
    db.prepare(
      `INSERT INTO projects (id, client_id, name, budget_minutes) VALUES (1, 1, 'App', NULL)`
    ).run()
    const result = buildBudgetStatus(db, 1)
    expect(result).toEqual({ ok: true, data: { budgetMinutes: null, usedMinutes: 0 } })
  })

  it('returns usedMinutes=0 when project has no entries', () => {
    db.prepare(
      `INSERT INTO projects (id, client_id, name, budget_minutes) VALUES (1, 1, 'App', 600)`
    ).run()
    const result = buildBudgetStatus(db, 1)
    expect(result).toEqual({ ok: true, data: { budgetMinutes: 600, usedMinutes: 0 } })
  })

  it('sums the minutes of completed entries', () => {
    db.prepare(
      `INSERT INTO projects (id, client_id, name, budget_minutes) VALUES (1, 1, 'App', 600)`
    ).run()
    // completed entries
    // 2.0 P2: rounded_min (60, 90) is gone from the fixture; the view reports NULL and the sum comes from the timestamps
    seedEntry(db, {
      client_id: 1,
      project_id: 1,
      started_at: '2026-05-01T08:00:00Z',
      stopped_at: '2026-05-01T09:00:00Z'
    })
    seedEntry(db, {
      client_id: 1,
      project_id: 1,
      started_at: '2026-05-02T08:00:00Z',
      stopped_at: '2026-05-02T09:30:00Z'
    })
    const result = buildBudgetStatus(db, 1)
    expect(result).toEqual({ ok: true, data: { budgetMinutes: 600, usedMinutes: 150 } })
  })

  it('excludes the currently running entry (stopped_at IS NULL)', () => {
    db.prepare(
      `INSERT INTO projects (id, client_id, name, budget_minutes) VALUES (1, 1, 'App', 600)`
    ).run()
    // completed entry
    seedEntry(db, {
      client_id: 1,
      project_id: 1,
      started_at: '2026-05-01T08:00:00Z',
      stopped_at: '2026-05-01T09:00:00Z'
    })
    // running entry — no stopped_at
    seedEntry(db, { client_id: 1, project_id: 1, started_at: '2026-05-02T08:00:00Z' })
    const result = buildBudgetStatus(db, 1)
    expect(result).toEqual({ ok: true, data: { budgetMinutes: 600, usedMinutes: 60 } })
  })

  it('returns silent fallback when project does not exist', () => {
    const result = buildBudgetStatus(db, 9999)
    expect(result).toEqual({ ok: true, data: { budgetMinutes: null, usedMinutes: 0 } })
  })

  it('excludes soft-deleted entries (deleted_at IS NOT NULL)', () => {
    db.prepare(
      `INSERT INTO projects (id, client_id, name, budget_minutes) VALUES (1, 1, 'App', 600)`
    ).run()
    // completed + deleted entry — should not count
    seedEntry(db, {
      client_id: 1,
      project_id: 1,
      started_at: '2026-05-01T08:00:00Z',
      stopped_at: '2026-05-01T09:00:00Z',
      deleted_at: '2026-05-02T00:00:00Z'
    })
    // live completed entry — counts (2.0 P2: rounded_min 30 is gone; the 60 minutes come from the timestamps, as the expectation already said)
    seedEntry(db, {
      client_id: 1,
      project_id: 1,
      started_at: '2026-05-03T08:00:00Z',
      stopped_at: '2026-05-03T09:00:00Z'
    })
    const result = buildBudgetStatus(db, 1)
    expect(result).toEqual({ ok: true, data: { budgetMinutes: 600, usedMinutes: 60 } })
  })

  // #285: the budget counts what the invoice bills. These go through the real
  // write paths; fixtures that set `rounded_min` by hand hid that the timer
  // never wrote it.
  describe('counts like the invoice (#285)', () => {
    beforeEach(() => {
      db.prepare(
        `INSERT INTO projects (id, client_id, name, budget_minutes) VALUES (1, 1, 'App', 600)`
      ).run()
    })

    function setStep(step: number): void {
      db.prepare(
        `INSERT OR REPLACE INTO settings (key, value) VALUES ('pdf_round_minutes', ?)`
      ).run(String(step))
    }

    it('counts a timer entry stopped with stopEntry', () => {
      setStep(15)
      const started = startTimer(db, {
        client_id: 1,
        description: 'A',
        started_at: secondsAgo(62 * 60 + 20),
        project_id: 1
      })
      if (!started.ok) throw new Error(started.error)
      expect(stopEntry(db, started.data.id).ok).toBe(true)
      // 62:20 → 63 whole minutes → next 15-minute step: 75, as on the invoice.
      expect(buildBudgetStatus(db, 1)).toEqual({
        ok: true,
        data: { budgetMinutes: 600, usedMinutes: 75 }
      })
    })

    it('counts a timer entry ended by switching to the next one', () => {
      setStep(0)
      const first = startTimer(db, {
        client_id: 1,
        description: 'first',
        started_at: secondsAgo(20 * 60 + 10),
        project_id: 1
      })
      if (!first.ok) throw new Error(first.error)
      // The next timer runs on no project; only the ended entry counts.
      const next = switchTimer(db, {
        client_id: 1,
        description: 'next',
        started_at: new Date().toISOString()
      })
      expect(next.ok).toBe(true)
      // 20:10 → 21 started minutes, no step.
      expect(buildBudgetStatus(db, 1)).toEqual({
        ok: true,
        data: { budgetMinutes: 600, usedMinutes: 21 }
      })
    })

    it('counts billable entries only, each rounded like the invoice', () => {
      setStep(15)
      const started = startTimer(db, {
        client_id: 1,
        description: 'A',
        started_at: secondsAgo(62 * 60 + 20),
        project_id: 1
      })
      if (!started.ok) throw new Error(started.error)
      expect(stopEntry(db, started.data.id).ok).toBe(true)
      const billable = createManualEntry(db, {
        client_id: 1,
        description: 'B',
        started_at: '2026-10-01T08:00:00.000Z',
        stopped_at: '2026-10-01T08:07:40.000Z',
        project_id: 1
      })
      const notBillable = createManualEntry(db, {
        client_id: 1,
        description: 'C',
        started_at: '2026-10-01T09:00:00.000Z',
        stopped_at: '2026-10-01T09:30:00.000Z',
        project_id: 1,
        billable: 0
      })
      expect(billable.ok && notBillable.ok).toBe(true)
      // Invoice: 75 (62:20) + 15 (7:40) = 90; the 30 non-billable minutes are
      // not billed. The old sum of rounded_min said 38.
      expect(buildBudgetStatus(db, 1)).toEqual({
        ok: true,
        data: { budgetMinutes: 600, usedMinutes: 90 }
      })
    })

    // projects:getAll builds its SQL inside the IPC handler, out of a test's
    // reach, so the three budget readers are pinned to the shared fragment here.
    it('every budget reader uses the shared fragment, none sums rounded_min', () => {
      const readers = ['main/budgetHandlers.ts', 'main/ipc.ts', 'mcp/queries.ts']
      for (const rel of readers) {
        const src = readFileSync(join(__dirname, '..', rel), 'utf8')
        expect(src, rel).toContain('budgetUsedMinutesSql(')
        expect(src, rel).not.toMatch(/SUM\(\s*rounded_min\s*\)/)
      }
    })

    it('counts an entry whose stop wrote only stopped_at (crash recovery)', () => {
      setStep(0)
      const id = seedEntry(db, {
        client_id: 1,
        project_id: 1,
        started_at: '2026-05-01T08:00:00.000Z',
        heartbeat_at: '2026-05-01T08:45:00.000Z'
      })
      // What recoverZombieEntries does: stop at the last heartbeat.
      const sealed = writeEntry(
        db,
        { op: 'seal', id, stopped_at: '2026-05-01T08:45:00.000Z' },
        { source: 'app' }
      )
      expect(sealed.ok).toBe(true)
      expect(buildBudgetStatus(db, 1)).toEqual({
        ok: true,
        data: { budgetMinutes: 600, usedMinutes: 45 }
      })
    })
  })
})
