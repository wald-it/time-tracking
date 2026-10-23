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
import { createManualEntry, switchTimer, updateManualEntry } from '../../../main/entryMutations'
import { buildPdfPayload } from '../../../main/pdf'
import type {
  Client,
  CreateEntryInput,
  CreateManualEntryInput,
  Entry,
  UpdateEntryInput
} from '../../../shared/types'

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
      // entries:start answers the new entry only (ipc.ts maps the switch result).
      start: async (input: CreateEntryInput) => {
        const res = switchTimer(db, input)
        return res.ok ? { ok: true as const, data: res.data.entry } : res
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

/** Local calendar date as YYYY-MM-DD, the form the PDF request takes. */
function localDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

describe('idle → "Als Pause markieren" (real main-process mutations)', () => {
  it('books the pause as not billable, so it stays off the timesheet', async () => {
    const db = new DatabaseImpl(':memory:')
    seed(db)
    // Local noon today: no entry crosses midnight, which updateManualEntry
    // would split into two rows. The clock is pinned to it after setup.
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
      { clientId: 1, fromIso: localDate(NOW), toIso: localDate(NOW) },
      ''
    )
    expect(sheet.rows.map((r) => r.description)).not.toContain('Pause')
    expect(sheet.rows.map((r) => r.description)).toContain('Konzept')
    db.close()
  })
})
