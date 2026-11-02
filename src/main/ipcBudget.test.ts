import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import type { BudgetStatus, IpcResult, Project } from '../shared/types'
import { listProjects } from '../mcp/queries'
import { registerIpcHandlers, type IpcHooks } from './ipc'

const { handlers, state } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => IpcResult<unknown>>(),
  state: { db: undefined as Database.Database | undefined }
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: never) => handlers.set(channel, handler),
    on: vi.fn()
  },
  app: {},
  shell: {},
  dialog: {}
}))
vi.mock('./db', () => ({ getDb: () => state.db, getDbPath: () => 'test.sqlite' }))
let Sqlite: DatabaseCtor
let db: Database.Database
beforeAll(async () => {
  Sqlite = await loadSqlite()
})
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 15, 12))
  db = new Sqlite(':memory:')
  applyMigrations(db)
  db.exec(`INSERT INTO clients (id, name, rate_cent) VALUES (1, 'Synthetic client', 5000);
    INSERT INTO projects (id, client_id, name, rate_cent, budget_minutes) VALUES (1, 1, 'Synthetic project', 6000, 600);
    INSERT INTO rate (project_id, valid_from, rate_cent, source) VALUES (1, '2026-11-10', 12000, 'editor');
    UPDATE settings SET value = '0' WHERE key = 'pdf_round_minutes';`)
  for (const [date, minutes] of [
    ['2026-10-31', 60],
    ['2026-11-01', 30],
    ['2026-11-10', 45],
    ['2026-12-01', 15]
  ] as const) {
    seedEntry(db, {
      client_id: 1,
      project_id: 1,
      started_at: `${date}T10:00:00Z`,
      stopped_at: new Date(Date.parse(`${date}T10:00:00Z`) + minutes * 60000).toISOString()
    })
  }
  seedEntry(db, {
    client_id: 1,
    project_id: 1,
    segments: [
      {
        segment_date: '2026-10-31',
        started_at: '2026-10-31T22:50:00Z',
        stopped_at: '2026-10-31T23:00:00Z'
      },
      {
        segment_date: '2026-11-01',
        started_at: '2026-10-31T23:00:00Z',
        stopped_at: '2026-10-31T23:20:00Z'
      }
    ]
  })
  seedEntry(db, {
    client_id: 1,
    project_id: 1,
    started_at: '2026-11-02T10:00:00Z',
    stopped_at: '2026-11-02T11:00:00Z',
    billable: 0
  })
  seedEntry(db, {
    client_id: 1,
    project_id: 1,
    started_at: '2026-11-03T10:00:00Z',
    stopped_at: '2026-11-03T11:00:00Z',
    deleted_at: '2026-11-04T10:00:00Z'
  })
  seedEntry(db, { client_id: 1, project_id: 1, started_at: '2026-11-15T10:00:00Z' })
  state.db = db
  handlers.clear()
  registerIpcHandlers({ refreshTrayClients: vi.fn() } as unknown as IpcHooks)
})
afterEach(() => {
  db.close()
  vi.useRealTimers()
})

function invoke<T>(channel: string, ...args: unknown[]): IpcResult<T> {
  return handlers.get(channel)!(null, ...args) as IpcResult<T>
}
function data<T>(result: IpcResult<T>): T {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error)
  return result.data
}
const privacy = { exposeRates: true, exposePrivateNotes: false }
const input = { id: 1, client_id: 1, name: 'Synthetic project', color: '', active: 1 }

describe('Q11 budget readers and writes', () => {
  // Hand calculation: 60+30+45+15+10+20 = 180 minutes;
  // fees: 6000+3000+9000+3000+1000+2000 = 24000 cents.
  // November only: 30+45+20 = 95 minutes, 3000+9000+2000 = 14000 cents.
  it.each([
    ['hours', 'total', 180, 24000, 600],
    ['eur', 'total', 180, 24000, 30000],
    ['hours', 'month', 95, 14000, 600],
    ['eur', 'month', 95, 14000, 30000]
  ] as const)(
    '%s/%s agrees in getAll, getBudgetStatus and MCP',
    (kind, period, minutes, cent, budget) => {
      data(
        invoke('projects:update', {
          ...input,
          budget_kind: kind,
          budget_period: period,
          budget_minutes: 600,
          budget_cent: 30000
        })
      )
      for (const req of [undefined, { clientId: 1 }]) {
        const project = data(invoke<Project[]>('projects:getAll', req))[0]
        expect(project).toMatchObject({
          budget_kind: kind,
          budget_period: period,
          used_minutes: minutes,
          used_cent: cent
        })
      }
      expect(data(invoke<BudgetStatus>('projects:getBudgetStatus', 1))).toEqual({
        kind,
        period,
        budget,
        used: kind === 'hours' ? minutes : cent
      })
      expect(listProjects(db, privacy)[0]).toMatchObject({
        budget_kind: kind,
        budget_period: period,
        used_minutes: minutes,
        used_cent: cent
      })
      expect(listProjects(db, privacy, { clientId: 1 })[0].used_minutes).toBe(minutes)
    }
  )

  it('MCP omits both euro fields without exposeRates', () => {
    data(
      invoke('projects:update', {
        ...input,
        budget_kind: 'eur',
        budget_period: 'month',
        budget_cent: 30000
      })
    )
    const project = listProjects(db, { ...privacy, exposeRates: false })[0]
    expect(project).toMatchObject({
      budget_kind: 'eur',
      budget_period: 'month',
      used_minutes: 95,
      budget_minutes: null
    })
    expect(project).not.toHaveProperty('budget_cent')
    expect(project).not.toHaveProperty('used_cent')
    expect(project).not.toHaveProperty('rate_cent')
  })

  it.each(['projects:create', 'projects:update'])(
    '%s rejects invalid kind, period and amounts',
    (channel) => {
      for (const invalid of [
        { budget_kind: 'days' },
        { budget_kind: null },
        { budget_period: 'week' },
        { budget_period: null },
        { budget_minutes: -1 },
        { budget_kind: 'eur', budget_cent: -1 },
        { budget_cent: Infinity },
        { budget_minutes: '60' }
      ]) {
        expect(
          invoke(channel, { ...input, name: 'New project', ...invalid }),
          JSON.stringify(invalid)
        ).toMatchObject({ ok: false })
      }
      expect(data(invoke<Project[]>('projects:getAll'))[0].budget_minutes).toBe(600)
    }
  )

  it('switches type both ways, clears the inactive amount, and preserves zero and null', () => {
    const euro = data(
      invoke<Project>('projects:update', {
        ...input,
        budget_kind: 'eur',
        budget_cent: 10000,
        budget_minutes: 600
      })
    )
    expect(euro).toMatchObject({ budget_kind: 'eur', budget_cent: 10000, budget_minutes: null })
    const hours = data(
      invoke<Project>('projects:update', {
        ...input,
        budget_kind: 'hours',
        budget_minutes: 60,
        budget_cent: 10000
      })
    )
    expect(hours).toMatchObject({ budget_kind: 'hours', budget_cent: null, budget_minutes: 60 })
    expect(
      data(
        invoke<Project>('projects:create', {
          ...input,
          name: 'Zero',
          budget_kind: 'eur',
          budget_cent: 0
        })
      )
    ).toMatchObject({ budget_cent: 0, budget_minutes: null })
    data(
      invoke('projects:update', {
        ...input,
        budget_kind: 'eur',
        budget_cent: null,
        budget_minutes: 600
      })
    )
    expect(data(invoke<BudgetStatus>('projects:getBudgetStatus', 1))).toEqual({
      kind: 'eur',
      period: 'total',
      budget: null,
      used: 24000
    })
  })

  it('a euro budget with no rate has zero consumption', () => {
    db.exec('DELETE FROM rate')
    data(invoke('projects:update', { ...input, budget_kind: 'eur', budget_cent: 10000 }))
    expect(data(invoke<BudgetStatus>('projects:getBudgetStatus', 1)).used).toBe(0)
    expect(listProjects(db, privacy)[0].used_cent).toBe(0)
  })
})
