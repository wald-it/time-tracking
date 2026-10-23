/**
 * "Als Pause markieren" end to end, renderer and main process together (#298):
 * `useTimer().idleMarkPause` → `entries:update` stops the running entry at
 * idleSince (the real `updateManualEntry`), `entries:create` books the pause
 * from idleSince to now (the real `createManualEntry`) — on a real database.
 *
 * The pause is time the user did not work. It must not be billable, or it
 * lands on the client's timesheet (the PDF attachment takes billable entries
 * only) and in the billable hours of the Auswertung.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type Database from 'better-sqlite3'
import { loadSqlite, type DatabaseCtor } from '../../../test/sqlite'
import { seed } from '../../../test/bridgeKit'
import { createManualEntry, updateManualEntry } from '../../../main/entryMutations'
import { buildPdfPayload } from '../../../main/pdf'
import { localDateKey } from '../../../shared/dateRanges'
import type { Client, CreateManualEntryInput, Entry, UpdateEntryInput } from '../../../shared/types'

let DatabaseImpl: DatabaseCtor

beforeAll(async () => {
  DatabaseImpl = await loadSqlite()
})

// `globals` is off, so Testing Library's auto-cleanup is not registered.
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

type IdleCb = (data: { idleSince: string; idleSeconds: number }) => void

function installApi(db: Database.Database): {
  trayUpdate: ReturnType<typeof vi.fn>
  idle: { current: IdleCb | null }
} {
  const trayUpdate = vi.fn()
  const idle: { current: IdleCb | null } = { current: null }
  const api = {
    clients: {
      getAll: async () => ({
        ok: true as const,
        data: db.prepare(`SELECT * FROM clients ORDER BY id`).all() as Client[]
      })
    },
    entries: {
      getRunning: async () => ({
        ok: true as const,
        data:
          (db
            .prepare(
              `SELECT * FROM entries WHERE stopped_at IS NULL AND deleted_at IS NULL
                ORDER BY started_at DESC LIMIT 1`
            )
            .get() as Entry | undefined) ?? null
      }),
      // The pause is booked closed in one step (#298); starting it as a
      // running timer is the old path that left a billable "Pause" behind.
      start: async () => {
        throw new Error('the idle pause must not be started as a timer')
      },
      create: async (input: CreateManualEntryInput) => createManualEntry(db, input),
      update: async (input: UpdateEntryInput) => updateManualEntry(db, input),
      heartbeat: async () => ({ ok: true as const, data: undefined })
    },
    dashboard: { todayTotal: async () => ({ ok: true as const, data: 0 }) },
    tray: { update: trayUpdate },
    idle: { dismiss: vi.fn() },
    onHotkeyToggle: () => {},
    onTrayQuickStart: () => {},
    onTrayStop: () => {},
    onDataChanged: () => {},
    onIdleDetected: (cb: IdleCb) => {
      idle.current = cb
    }
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { trayUpdate, idle }
}

describe('idle → "Als Pause markieren" (real main-process mutations)', () => {
  it('books the pause as not billable, so it stays off the timesheet', async () => {
    const db = new DatabaseImpl(':memory:')
    seed(db)
    // Local noon today: no entry crosses midnight, which updateManualEntry
    // (the stopped work entry) and createManualEntry (the pause) would each
    // split into two rows. The clock is pinned to it after setup.
    const today = new Date()
    const NOW = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0)
    const startedAt = new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString()
    const idleSince = new Date(NOW.getTime() - 30 * 60_000).toISOString()
    db.prepare(
      `INSERT INTO entries (id, client_id, description, started_at, heartbeat_at)
       VALUES (1, 1, 'Konzept', ?, ?)`
    ).run(startedAt, startedAt)
    const { trayUpdate, idle } = installApi(db)

    // Fresh module instance: useTimer keeps module-level singletons.
    vi.resetModules()
    const { useTimer } = await import('./useTimer')
    const hook = renderHook(() => useTimer({ engine: true }))
    await waitFor(() => expect(trayUpdate).toHaveBeenCalled())
    await waitFor(() => expect(hook.result.current.runningEntry?.id).toBe(1))
    // Only Date, and only after the dynamic import (module-runner trap, see
    // the clock tests in useTimer.test.tsx).
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)

    act(() => idle.current?.({ idleSince, idleSeconds: 30 * 60 }))
    await waitFor(() => expect(hook.result.current.idleEvent).not.toBeNull())

    await act(async () => {
      await hook.result.current.idleMarkPause()
    })

    expect(hook.result.current.runningEntry).toBeNull()
    const rows = db
      .prepare(
        `SELECT description, started_at, stopped_at, billable FROM entries
          WHERE deleted_at IS NULL ORDER BY started_at`
      )
      .all() as Array<{
      description: string
      started_at: string
      stopped_at: string | null
      billable: number
    }>
    expect(rows.map((r) => [r.description, r.started_at, r.billable])).toEqual([
      ['Konzept', startedAt, 1],
      ['Pause', idleSince, 0]
    ])
    expect(rows[0].stopped_at).toBe(idleSince)
    expect(rows[1].stopped_at).toBe(NOW.toISOString())

    // The client's timesheet (PDF attachment) lists the work, not the pause.
    const sheet = buildPdfPayload(
      db,
      { clientId: 1, fromIso: localDateKey(NOW), toIso: localDateKey(NOW) },
      ''
    )
    expect(sheet.rows.map((r) => r.description)).not.toContain('Pause')
    expect(sheet.rows.map((r) => r.description)).toContain('Konzept')
    db.close()
  })
})

// #313: stopping the running entry at idleSince goes through entries:update,
// which re-inserts the row and defaults every field it is not given. Both idle
// actions must keep the stopped entry as it was. Of the optional fields, a
// running entry only ever carries a project (switchTimer sets no other), so
// the seed is a running entry with a project; the other fields are checked to
// stay at what the entry had. useTimer.test.tsx pins that they are sent along.
describe('idle prompt keeps the stopped entry as it was (#313)', () => {
  async function runIdle(action: 'idleStopAtIdle' | 'idleMarkPause'): Promise<{
    db: Database.Database
    idleSince: string
  }> {
    const db = new DatabaseImpl(':memory:')
    seed(db)
    // Local noon, as above: nothing may cross midnight.
    const today = new Date()
    const NOW = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0)
    const startedAt = new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString()
    const idleSince = new Date(NOW.getTime() - 30 * 60_000).toISOString()
    // The row switchTimer writes for a timer started on project 10.
    db.prepare(
      `INSERT INTO entries (id, client_id, project_id, description, started_at, heartbeat_at)
       VALUES (1, 1, 10, 'Konzept', ?, ?)`
    ).run(startedAt, startedAt)
    const { trayUpdate, idle } = installApi(db)

    vi.resetModules()
    const { useTimer } = await import('./useTimer')
    const hook = renderHook(() => useTimer({ engine: true }))
    await waitFor(() => expect(trayUpdate).toHaveBeenCalled())
    await waitFor(() => expect(hook.result.current.runningEntry?.id).toBe(1))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)

    act(() => idle.current?.({ idleSince, idleSeconds: 30 * 60 }))
    await waitFor(() => expect(hook.result.current.idleEvent).not.toBeNull())
    await act(async () => {
      await hook.result.current[action]()
    })
    expect(hook.result.current.runningEntry).toBeNull()
    return { db, idleSince }
  }

  function stoppedWork(db: Database.Database): unknown {
    return db
      .prepare(
        `SELECT client_id, project_id, description, stopped_at, billable, reference,
                private_note, tags
           FROM entries WHERE description = 'Konzept' AND deleted_at IS NULL`
      )
      .all()
  }

  it('"Beim Leerlauf stoppen"', async () => {
    const { db, idleSince } = await runIdle('idleStopAtIdle')
    expect(stoppedWork(db)).toEqual([
      {
        client_id: 1,
        project_id: 10,
        description: 'Konzept',
        stopped_at: idleSince,
        billable: 1,
        reference: '',
        private_note: '',
        tags: ''
      }
    ])
    db.close()
  })

  it('"Als Pause markieren"', async () => {
    const { db, idleSince } = await runIdle('idleMarkPause')
    expect(stoppedWork(db)).toEqual([
      {
        client_id: 1,
        project_id: 10,
        description: 'Konzept',
        stopped_at: idleSince,
        billable: 1,
        reference: '',
        private_note: '',
        tags: ''
      }
    ])
    db.close()
  })
})
