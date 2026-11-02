import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { budgetMonthBounds } from './currency'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { createManualEntry } from '../main/entryMutations'
import { buildBudgetStatus } from '../main/budgetHandlers'
let Sqlite: DatabaseCtor
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
afterEach(() => vi.useRealTimers())

it.each([0, 6, 11])('uses the new month at local 00:30 on the 1st, month index %i', (month) => {
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Berlin')
  expect(budgetMonthBounds(new Date(2026, month, 1, 0, 30))).toEqual({
    monthStart: `2026-${String(month + 1).padStart(2, '0')}-01`,
    nextMonthStart: month === 11 ? '2027-01-01' : `2026-${String(month + 2).padStart(2, '0')}-01`
  })
})

it('splits a real month-crossing write by segment_date for both monthly budget units', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 1, 0, 30))
  const db = new Sqlite(':memory:')
  try {
    applyMigrations(db)
    db.exec(`INSERT INTO clients (id, name, rate_cent) VALUES (1, 'Synthetic', 6000);
      INSERT INTO projects (id, client_id, name, budget_minutes, budget_period) VALUES (1, 1, 'Midnight', 60, 'month');
      UPDATE settings SET value = '0' WHERE key = 'pdf_round_minutes';`)
    expect(
      createManualEntry(db, {
        client_id: 1,
        project_id: 1,
        description: 'Across midnight',
        started_at: '2026-10-31T23:50:00+01:00',
        stopped_at: '2026-11-01T00:20:00+01:00'
      }).ok
    ).toBe(true)
    expect(db.prepare('SELECT segment_date FROM entry_segment ORDER BY seq').all()).toEqual([
      { segment_date: '2026-10-31' },
      { segment_date: '2026-11-01' }
    ])
    expect(buildBudgetStatus(db, 1)).toEqual({
      ok: true,
      data: { kind: 'hours', period: 'month', budget: 60, used: 20 }
    })
    db.exec("UPDATE projects SET budget_kind = 'eur', budget_cent = 5000, budget_minutes = NULL")
    expect(buildBudgetStatus(db, 1)).toEqual({
      ok: true,
      data: { kind: 'eur', period: 'month', budget: 5000, used: 2000 }
    })
  } finally {
    db.close()
  }
})
