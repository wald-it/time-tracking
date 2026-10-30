import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry, type SeedEntryInput } from '../test/entryFixtures'
import type { IpcResult } from '../shared/types'
import { writeEntry, type CreateFields } from './entryMutations'
import { createRun, releaseRun, type BillingRun } from './billingRuns'
import { changedSinceLastRun } from './changedSinceRun'
import { registerIpcHandlers, type IpcHooks } from './ipc'

const { handlers, dbRef } = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: unknown, ...args: unknown[]) => IpcResult<unknown> | Promise<IpcResult<unknown>>
  >(),
  dbRef: { current: undefined as Database.Database | undefined }
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
vi.mock('./db', () => ({ getDb: () => dbRef.current, getDbPath: () => 'test.sqlite' }))

let Ctor: DatabaseCtor
let db: Database.Database
let runDay: number
const request = { clientId: 1, fromIso: '2026-10-01', toIso: '2026-10-31' }
const before = '2026-10-31T12:00:00.000Z'
const atRun = '2026-11-01T12:00:00.000Z'
const after = '2026-11-02T12:00:00.000Z'
const newest = '2026-11-03T12:00:00.000Z'
const local = (month: number, day: number, hour = 8): string =>
  new Date(2026, month - 1, day, hour).toISOString()
const renderer = async (html: string): Promise<Buffer> => Buffer.from('PDF:' + html)
const summary = (
  run: BillingRun
): NonNullable<ReturnType<typeof changedSinceLastRun>['lastRun']> => ({
  id: run.id,
  number: run.number,
  createdAt: run.created_at
})

beforeAll(async () => {
  Ctor = await loadSqlite()
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(atRun)
  db = new Ctor(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  db.exec(`INSERT INTO clients (id, name, rate_cent, short_code) VALUES
    (1, 'First', 6000, 'ONE'), (2, 'Second', 6000, 'TWO');
    INSERT INTO projects (id, client_id, name) VALUES
    (1, 1, 'Review'), (2, 1, 'Other project')`)
  dbRef.current = db
  runDay = 0
  handlers.clear()
  registerIpcHandlers({} as IpcHooks)
})
afterEach(() => {
  db.close()
  vi.useRealTimers()
})

function entry(day: number, writtenAt = before, fields: Partial<CreateFields> = {}): number {
  const result = writeEntry(
    db,
    {
      op: 'create',
      fields: {
        client_id: 1,
        project_id: 1,
        description: 'Work',
        started_at: local(10, day),
        stopped_at: local(10, day, 9),
        ...fields
      }
    },
    { source: 'app', now: writtenAt }
  )
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error)
  return result.data.id
}

function edit(id: number, writtenAt: string): void {
  expect(
    writeEntry(
      db,
      { op: 'patch', id, patch: { description: 'Edited at ' + writtenAt } },
      { source: 'app', reason: 'Correct work description', now: writtenAt }
    ).ok
  ).toBe(true)
}

// Real runs in another period/project still provide the client's reference.
async function run(createdAt = atRun, clientId = 1): Promise<BillingRun> {
  const day = ++runDay
  const projectId = clientId === 1 ? 2 : null
  entry(1, before, {
    client_id: clientId,
    project_id: projectId,
    started_at: local(9, day),
    stopped_at: local(9, day, 9)
  })
  vi.setSystemTime(createdAt)
  const date = `2026-09-${String(day).padStart(2, '0')}`
  return createRun(db, { clientId, projectId, fromIso: date, toIso: date }, renderer)
}

describe('changedSinceLastRun', () => {
  it('uses strictly later version writes, classifies the first version, and returns the newest change in start order', async () => {
    const earlierEdit = entry(1)
    edit(earlierEdit, before)
    const equalEdit = entry(2)
    const changed = entry(4)
    const firstEqual = entry(5, atRun)
    const billed = await run()
    edit(equalEdit, atRun)
    edit(changed, after)
    edit(changed, newest)
    edit(firstEqual, after)
    const created = entry(3, after)
    edit(created, newest)

    expect(changedSinceLastRun(db, request)).toEqual({
      lastRun: summary(billed),
      entries: [
        { entryId: created, change: 'created', changedAt: newest },
        { entryId: changed, change: 'changed', changedAt: newest },
        { entryId: firstEqual, change: 'changed', changedAt: after }
      ]
    })
  })

  it('billing a segment creates no entry version and does not count as an edit', async () => {
    const id = entry(1)
    edit(id, before)
    const versions = db.prepare('SELECT * FROM entry_version ORDER BY id').all()
    const billed = await createRun(db, request, renderer)
    expect(db.prepare('SELECT * FROM entry_version ORDER BY id').all()).toEqual(versions)
    expect(
      db.prepare('SELECT billed_run_id FROM billing_lines WHERE entry_id = ?').get(id)
    ).toEqual({
      billed_run_id: billed.id
    })
    expect(changedSinceLastRun(db, request)).toEqual({ lastRun: summary(billed), entries: [] })
  })

  it('uses the latest active client run by timestamp across projects and periods, ignoring a newer released run', async () => {
    const id = entry(1)
    await run()
    edit(id, after)
    const latestActive = await run(newest)
    // A higher id with an older timestamp must not displace the latest run.
    await run(after)
    const withdrawn = await run('2026-11-05T12:00:00.000Z')
    releaseRun(db, withdrawn.id, 'Withdraw invoice')
    const changedAt = '2026-11-04T12:00:00.000Z'
    const created = entry(2, changedAt)
    expect(changedSinceLastRun(db, { ...request, projectId: 1 })).toEqual({
      lastRun: summary(latestActive),
      entries: [{ entryId: created, change: 'created', changedAt }]
    })
  })

  it('returns no reference or entries when there is no run', () => {
    entry(1, after)
    expect(changedSinceLastRun(db, request)).toEqual({ lastRun: null, entries: [] })
  })

  it('ignores another client run and returns no reference when all own runs are released', async () => {
    entry(1, after)
    await run(atRun, 2)
    expect(changedSinceLastRun(db, request)).toEqual({ lastRun: null, entries: [] })
    const own = await run()
    releaseRun(db, own.id, 'Withdraw invoice')
    expect(changedSinceLastRun(db, request)).toEqual({ lastRun: null, entries: [] })
  })

  it('selects stored inclusive segment dates, optional project and client, excluding deleted and whole running entries', async () => {
    const billed = await run()
    const seed = (extra: Partial<SeedEntryInput>): number =>
      seedEntry(db, {
        client_id: 1,
        project_id: 1,
        created_at: after,
        started_at: local(10, 2),
        stopped_at: local(10, 2, 9),
        ...extra
      })
    // Stored dates differ from current local dates, as after changing time zone.
    const first = seed({
      segments: [
        { started_at: local(10, 2), stopped_at: local(10, 2, 9), segment_date: '2026-10-01' },
        { started_at: local(10, 3), stopped_at: local(10, 3, 9), segment_date: '2026-10-02' }
      ]
    })
    const last = seed({
      segments: [
        { started_at: local(11, 1), stopped_at: local(11, 1, 9), segment_date: '2026-10-31' }
      ]
    })
    seed({ started_at: local(9, 30), stopped_at: local(9, 30, 9) })
    seed({ started_at: local(11, 1), stopped_at: local(11, 1, 9) })
    const otherProject = seed({ project_id: 2 })
    const noProject = seed({ project_id: null, billable: 0 })
    seed({ client_id: 2, project_id: null })
    seed({ deleted_at: newest })
    seed({ stopped_at: null })
    seed({
      segments: [
        { started_at: local(10, 1, 23), stopped_at: local(10, 2, 0) },
        { started_at: local(10, 2, 0), stopped_at: null }
      ]
    })
    const changed = (entryId: number): object => ({ entryId, change: 'created', changedAt: after })
    expect(changedSinceLastRun(db, { ...request, projectId: 1 })).toEqual({
      lastRun: summary(billed),
      entries: [first, last].map(changed)
    })
    expect(changedSinceLastRun(db, request).entries).toEqual(
      [first, otherProject, noProject, last].map(changed)
    )
    expect(changedSinceLastRun(db, { ...request, projectId: null }).entries).toEqual(
      [first, otherProject, noProject, last].map(changed)
    )
    expect(changedSinceLastRun(db, { ...request, projectId: 99 }).entries).toEqual([])
  })

  it('reads deterministically without any database writes', async () => {
    const billed = await run()
    const id = entry(1, after)
    const changes = db.prepare('SELECT total_changes() AS n').get()
    db.pragma('query_only = ON')
    const expected = {
      lastRun: summary(billed),
      entries: [{ entryId: id, change: 'created', changedAt: after }]
    }
    expect(changedSinceLastRun(db, request)).toEqual(expected)
    expect(changedSinceLastRun(db, request)).toEqual(expected)
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes)
  })
})

describe('review:changedSinceRun IPC', () => {
  it('returns the query result for a valid request, including project and single-day bounds', async () => {
    const billed = await run()
    const id = entry(1, after)
    entry(2, after)
    db.pragma('query_only = ON')
    expect(
      await handlers.get('review:changedSinceRun')!(null, {
        ...request,
        projectId: 1,
        toIso: request.fromIso
      })
    ).toEqual({
      ok: true,
      data: {
        lastRun: summary(billed),
        entries: [{ entryId: id, change: 'created', changedAt: after }]
      }
    })
    expect(
      await handlers.get('review:changedSinceRun')!(null, { ...request, clientId: 2 })
    ).toEqual({
      ok: true,
      data: { lastRun: null, entries: [] }
    })
  })

  it.each([
    undefined,
    null,
    {},
    { ...request, clientId: 0 },
    { ...request, clientId: -1 },
    { ...request, clientId: 1.5 },
    { ...request, clientId: '1' },
    { ...request, clientId: NaN },
    { ...request, clientId: Infinity },
    { ...request, projectId: 0 },
    { ...request, projectId: -1 },
    { ...request, projectId: 1.5 },
    { ...request, projectId: '1' },
    { ...request, fromIso: '2026-10-1' },
    { ...request, fromIso: '2026-10-01T00:00:00.000Z' },
    { ...request, fromIso: '2026-02-30' },
    { ...request, fromIso: 20261001 },
    { ...request, fromIso: undefined },
    { ...request, toIso: '2026-13-01' },
    { ...request, toIso: '2026-10-32' },
    { ...request, toIso: null },
    { ...request, fromIso: '2026-10-02', toIso: '2026-10-01' }
  ])('rejects invalid request %#', async (input) => {
    expect(await handlers.get('review:changedSinceRun')!(null, input)).toEqual({
      ok: false,
      error: 'Ungültige Anfrage für den Abrechnungsvergleich'
    })
  })
})
