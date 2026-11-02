import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { budgetBounds, budgetForecast, budgetTargetShare } from './currency'
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
  expect(budgetBounds(new Date(2026, month, 1, 0, 30))).toEqual({
    monthStart: `2026-${String(month + 1).padStart(2, '0')}-01`,
    nextMonthStart: month === 11 ? '2027-01-01' : `2026-${String(month + 2).padStart(2, '0')}-01`,
    paceStart: month === 0 ? '2025-12-05' : month === 6 ? '2026-06-04' : '2026-11-04',
    paceEnd: `2026-${String(month + 1).padStart(2, '0')}-02`
  })
})

it('Q11 step 2: bounds span the end of DST with 28 local calendar days', () => {
  expect(budgetBounds(new Date(2026, 10, 2, 12))).toEqual({
    monthStart: '2026-11-01',
    nextMonthStart: '2026-12-01',
    paceStart: '2026-10-06',
    paceEnd: '2026-11-03'
  })
  expect(budgetBounds(new Date(2026, 10, 1, 0, 30))).toEqual({
    monthStart: '2026-11-01',
    nextMonthStart: '2026-12-01',
    paceStart: '2026-10-05',
    paceEnd: '2026-11-02'
  })
})

it.each([
  ['no budget', null, 0, 280],
  ['no pace', 600, 60, 0],
  ['spent', 600, 600, 280],
  ['exceeded', 600, 700, 280],
  ['zero empty', 0, 0, 280],
  ['zero used', 0, 1, 280]
] as const)('Q11 step 2: forecast has no date for %s', (_, budget, used, pace) => {
  expect(
    budgetForecast(
      { kind: 'hours', period: 'total', budget, used },
      pace,
      new Date(2026, 10, 2, 12)
    )
  ).toBeNull()
})

it.each(['hours', 'eur'] as const)('Q11 step 2: %s total forecast floors calendar days', (kind) => {
  // 280 / 28 = 10 units/day; (147 - 20) / 10 = 12.7 days -> Nov 3.
  expect(
    budgetForecast(
      { kind, period: 'total', budget: 147, used: 20 },
      280,
      new Date(2026, 9, 22, 12),
      6000
    )
  ).toEqual({ kind: 'date', date: new Date(2026, 10, 3) })
})

it.each([
  [300, 'monthEnd'],
  [310, 'monthEnd'],
  [290, 'date']
] as const)('Q11 step 2: monthly forecast with %i units remaining', (budget, kind) => {
  const forecast = budgetForecast(
    { kind: 'hours', period: 'month', budget, used: 0 },
    280,
    new Date(2026, 10, 1, 0, 30)
  )
  expect(forecast).toEqual(kind === 'monthEnd' ? { kind } : { kind, date: new Date(2026, 10, 30) })
})

it.each([null, 0, -1])('Q11 step 2: euro forecast requires a positive rate (%s)', (rate) => {
  expect(
    budgetForecast(
      { kind: 'eur', period: 'total', budget: 10000, used: 1000 },
      2800,
      new Date(2026, 10, 2),
      rate
    )
  ).toBeNull()
})

it('Q11 step 2: monthly target includes today', () => {
  expect(budgetTargetShare({ budget_period: 'month' }, new Date(2026, 10, 9, 12))).toBe(0.3)
})

it.each([
  ['2026-10-20', '2026-11-09', 0.65],
  ['2026-11-03', '2026-11-09', 0],
  ['2026-10-20', '2026-11-01', 1],
  ['2026-10-20', null, null],
  [null, '2026-11-09', null],
  ['2026-11-09', '2026-11-09', null],
  ['2026-11-09', '2026-10-20', null]
] as const)('Q11 step 2: total target from %s to %s is %s', (start_date, end_date, expected) => {
  // Oct 20 -> Nov 2 is 13 calendar days; Oct 20 -> Nov 9 is 20, despite DST.
  expect(
    budgetTargetShare(
      {
        budget_period: 'total',
        start_date,
        end_date
      },
      new Date(2026, 10, 2, 12)
    )
  ).toBe(expected)
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
