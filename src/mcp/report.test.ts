import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { writeEntry, type EntryView, type WriteOp } from '../main/entryMutations'
import {
  getAnalytics,
  getReport,
  type McpReport,
  type ReportGroup,
  type ReportQuery
} from './queries'
import { buildServer } from './server'

let Ctor: DatabaseCtor
let db: Database.Database
let dir: string
let client: Client
const SHOW = { exposeRates: true, exposePrivateNotes: true }
const HIDE = { exposeRates: false, exposePrivateNotes: false }
const month = { from: '2026-10-01', to: '2026-10-31' }
const local = (d: number, h = 10, m = 0): string => new Date(2026, 9, d, h, m).toISOString()

function write(op: WriteOp): EntryView {
  const result = writeEntry(db, op, { source: 'mcp', now: local(33, 23) })
  if (!result.ok) throw new Error(result.error)
  return result.data
}

function add(
  day: number,
  seconds: number,
  clientId = 1,
  projectId: number | null = null,
  billable = 1
): EntryView {
  const start = local(day)
  return write({
    op: 'create',
    fields: {
      client_id: clientId,
      project_id: projectId,
      description: 'Secret description',
      private_note: 'Secret note',
      started_at: start,
      stopped_at: new Date(Date.parse(start) + seconds * 1000).toISOString(),
      billable
    }
  })
}

function report(
  groupBy: ReportGroup[] = [],
  extra: Partial<ReportQuery> = {},
  privacy = SHOW
): McpReport {
  return getReport(db, privacy, { ...month, groupBy, ...extra })
}

beforeAll(async () => {
  Ctor = await loadSqlite()
})
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(local(33, 23)))
  dir = mkdtempSync(join(tmpdir(), 'timetrack-report-'))
  const path = join(dir, 'test.db')
  db = new Ctor(path)
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  db.exec(`INSERT INTO clients (id, name, color, rate_cent) VALUES
    (1, 'Alpha', '#111', 9000), (2, 'Beta', '#222', 6000);
    INSERT INTO projects (id, client_id, name, rate_cent) VALUES
    (10, 1, 'Zeta', 18000), (11, 1, 'Free', 0), (20, 2, 'Zeta', NULL);
    INSERT INTO rate (client_id, rate_cent, valid_from) VALUES (1, 12000, '2026-10-15');
    INSERT INTO rate (project_id, rate_cent, valid_from) VALUES (10, NULL, '2026-10-15');
    INSERT INTO billing_profile (client_id, interval_min, min_unit_min) VALUES (1, 15, 30);
    INSERT INTO billing_profile (project_id, interval_min, min_unit_min) VALUES (10, 10, 20);`)
  // Hand ledger (worked seconds / billed minutes / fee cents):
  add(1, 240) // 240 / 30 / 4500 (old client rate)
  add(6, 660, 1, 10) // 660 / 20 / 6000 (project interval AND minimum)
  add(16, 1260, 1, 10) // 1260 / 30 / 6000 (latest NULL falls back to new client rate)
  add(17, 240, 1, 11) // 240 / 30 / 0 (deliberate free project)
  write({
    op: 'create',
    fields: {
      client_id: 1,
      project_id: 10,
      description: 'Midnight',
      started_at: local(20, 23, 56),
      stopped_at: local(21, 0, 4)
    }
  }) // 480 / 40 / 8000 (two independently rounded segments)
  add(22, 3661, 2) // 3661 / 62 / 6200
  add(23, 600, 2, null, 0) // 600 / 10 / 0
  const edited = add(24, 300, 2, 20)
  write({
    op: 'patch',
    id: edited.id,
    expected_version: edited.version_no,
    patch: { stopped_at: local(24, 10, 7) }
  }) // current: 420 / 7 / 700
  add(31, 120) // 120 / 30 / 6000 (new client rate)
  const deleted = add(25, 3600)
  write({ op: 'delete', id: deleted.id })
  add(0, 3600) // adjacent days excluded
  add(32, 3600)
  write({ op: 'start', fields: { client_id: 2, description: 'Running', started_at: local(26) } })
  vi.stubEnv('TIMETRACK_DB_PATH', path)
  vi.stubEnv('TIMETRACK_MCP_EXPOSE_RATES', '')
  vi.stubEnv('TIMETRACK_MCP_EXPOSE_PRIVATE_NOTES', '')
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await buildServer().connect(st)
  client = new Client({ name: 'report-test', version: '0.0.0' })
  await client.connect(ct)
})
afterEach(async () => {
  await client?.close()
  db.close()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('get_report hand-calculated ledger', () => {
  it('totals use dated rates, profiles, billability and only the current live versions', () => {
    expect(report().totals).toEqual({
      entry_count: 9,
      seconds: 7681,
      billable_seconds: 7081,
      rounded_seconds: 15540,
      billable_rounded_seconds: 14940,
      revenue_cent: 37400
    })
  })

  it('project figures honor NULL fallback, a zero rate and both profile overrides', () => {
    expect(report(['project']).rows).toEqual([
      {
        client_id: 1,
        project_id: null,
        project_name: '(kein Projekt)',
        entry_count: 2,
        seconds: 360,
        billable_seconds: 360,
        rounded_seconds: 3600,
        billable_rounded_seconds: 3600,
        revenue_cent: 10500
      },
      {
        client_id: 2,
        project_id: null,
        project_name: '(kein Projekt)',
        entry_count: 2,
        seconds: 4261,
        billable_seconds: 3661,
        rounded_seconds: 4320,
        billable_rounded_seconds: 3720,
        revenue_cent: 6200
      },
      {
        client_id: 1,
        project_id: 11,
        project_name: 'Free',
        entry_count: 1,
        seconds: 240,
        billable_seconds: 240,
        rounded_seconds: 1800,
        billable_rounded_seconds: 1800,
        revenue_cent: 0
      },
      {
        client_id: 1,
        project_id: 10,
        project_name: 'Zeta',
        entry_count: 3,
        seconds: 2400,
        billable_seconds: 2400,
        rounded_seconds: 5400,
        billable_rounded_seconds: 5400,
        revenue_cent: 20000
      },
      {
        client_id: 2,
        project_id: 20,
        project_name: 'Zeta',
        entry_count: 1,
        seconds: 420,
        billable_seconds: 420,
        rounded_seconds: 420,
        billable_rounded_seconds: 420,
        revenue_cent: 700
      }
    ])
  })

  it('splits local midnight, rounds each segment and counts the entry once outside day groups', () => {
    const range = { from: '2026-10-20', to: '2026-10-21' }
    const result = report(['day'], range)
    expect(result.rows).toEqual(
      ['2026-10-20', '2026-10-21'].map((day) => ({
        day,
        entry_count: 1,
        seconds: 240,
        billable_seconds: 240,
        rounded_seconds: 1200,
        billable_rounded_seconds: 1200,
        revenue_cent: 4000
      }))
    )
    expect(result.totals).toEqual({
      entry_count: 1,
      seconds: 480,
      billable_seconds: 480,
      rounded_seconds: 2400,
      billable_rounded_seconds: 2400,
      revenue_cent: 8000
    })
    for (const keys of [['client'], ['project']] as ReportGroup[][]) {
      expect(report(keys, range).rows[0].entry_count).toBe(1)
    }
    expect(report(['day'], { ...range, from: range.to }).totals).toEqual({
      entry_count: 1,
      seconds: 240,
      billable_seconds: 240,
      rounded_seconds: 1200,
      billable_rounded_seconds: 1200,
      revenue_cent: 4000
    })
  })

  it('includes both range ends and excludes the days immediately outside', () => {
    expect(report(['day']).rows.map((r) => r.day)).toEqual([
      '2026-10-01',
      '2026-10-06',
      '2026-10-16',
      '2026-10-17',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-31'
    ])
    expect(report([], { from: month.from, to: month.from }).totals.revenue_cent).toBe(4500)
    expect(report([], { from: month.to, to: month.to }).totals.revenue_cent).toBe(6000)
  })
})

describe('get_report contract', () => {
  it.each([false, true])(
    'equals get_analytics for a whole month (exposeRates=%s)',
    (exposeRates) => {
      const privacy = { ...HIDE, exposeRates }
      const analytics = getAnalytics(db, privacy, 2026, 10)
      const result = report(['client'], {}, privacy)
      expect(result.totals).toMatchObject({
        seconds: analytics.total_seconds,
        billable_seconds: analytics.billable_seconds,
        rounded_seconds: analytics.rounded_seconds,
        billable_rounded_seconds: analytics.billable_rounded_seconds
      })
      expect(result.totals.revenue_cent).toBe(analytics.revenue_cent)
      for (const row of result.rows) {
        const a = analytics.by_client.find((c) => c.client_id === row.client_id)!
        expect([row.seconds, row.revenue_cent]).toEqual([a.seconds, a.revenue_cent])
      }
      // Analytics collapses all no-project entries into one row. Recombine that
      // bucket only; report deliberately keeps those entries apart per client.
      const projects = report(['project'], {}, privacy).rows
      expect(new Set(projects.map((p) => p.project_id)).size).toBe(analytics.by_project.length)
      for (const a of analytics.by_project) {
        const rows = projects.filter((p) => p.project_id === a.project_id)
        expect(rows.reduce((sum, r) => sum + r.seconds, 0)).toBe(a.seconds)
        if (exposeRates)
          expect(rows.reduce((sum, r) => sum + r.revenue_cent!, 0)).toBe(a.revenue_cent)
        else expect(rows.every((r) => !('revenue_cent' in r))).toBe(true)
      }
    }
  )

  const orders: ReportGroup[][] = [
    [],
    ['client'],
    ['project'],
    ['day'],
    ['client', 'project'],
    ['project', 'client'],
    ['client', 'day'],
    ['day', 'client'],
    ['project', 'day'],
    ['day', 'project'],
    ['client', 'project', 'day'],
    ['client', 'day', 'project'],
    ['project', 'client', 'day'],
    ['project', 'day', 'client'],
    ['day', 'client', 'project'],
    ['day', 'project', 'client']
  ]
  it.each(orders.map((keys) => [keys.join(',') || 'totals', keys] as const))(
    'accepts ordered subset %s and sorts by that order',
    (_name, keys) => {
      const result = report(keys)
      expect(result.group_by).toEqual(keys)
      expect(result.totals.entry_count).toBe(9)
      expect(result).not.toHaveProperty('rounding_minutes')
      if (!keys.length) {
        expect(result.rows).toEqual([])
        return
      }
      expect(result.rows.length).toBe(keys.includes('day') ? 10 : keys.includes('project') ? 5 : 2)
      for (const row of result.rows) {
        expect('client_name' in row).toBe(keys.includes('client'))
        expect('project_name' in row).toBe(keys.includes('project'))
        expect('day' in row).toBe(keys.includes('day'))
      }
      const compare = (
        a: (typeof result.rows)[number],
        b: (typeof result.rows)[number]
      ): number => {
        for (const key of keys) {
          const tuples =
            key === 'client'
              ? [
                  [a.client_name!, a.client_id!],
                  [b.client_name!, b.client_id!]
                ]
              : key === 'project'
                ? [
                    [a.project_name!, a.project_id ?? -1, a.client_id!],
                    [b.project_name!, b.project_id ?? -1, b.client_id!]
                  ]
                : [[a.day!], [b.day!]]
          for (let i = 0; i < tuples[0].length; i++) {
            if (tuples[0][i] < tuples[1][i]) return -1
            if (tuples[0][i] > tuples[1][i]) return 1
          }
        }
        return 0
      }
      expect(result.rows).toEqual([...result.rows].sort(compare))
    }
  )

  it('filters by client, project and billability, including their intersection', () => {
    expect(report([], { clientId: 1 }).totals).toEqual({
      entry_count: 6,
      seconds: 3000,
      billable_seconds: 3000,
      rounded_seconds: 10800,
      billable_rounded_seconds: 10800,
      revenue_cent: 30500
    })
    expect(report([], { projectId: 10 }).totals).toEqual({
      entry_count: 3,
      seconds: 2400,
      billable_seconds: 2400,
      rounded_seconds: 5400,
      billable_rounded_seconds: 5400,
      revenue_cent: 20000
    })
    expect(report([], { billableOnly: true }).totals).toEqual({
      entry_count: 8,
      seconds: 7081,
      billable_seconds: 7081,
      rounded_seconds: 14940,
      billable_rounded_seconds: 14940,
      revenue_cent: 37400
    })
    expect(report([], { clientId: 2, projectId: 10, billableOnly: true }).totals.entry_count).toBe(
      0
    )
  })

  it('returns zero totals and no rows for an empty range', () => {
    expect(report(['client'], { from: '2027-01-01', to: '2027-01-31' })).toEqual({
      from: '2027-01-01',
      to: '2027-01-31',
      group_by: ['client'],
      rows: [],
      totals: {
        entry_count: 0,
        seconds: 0,
        billable_seconds: 0,
        rounded_seconds: 0,
        billable_rounded_seconds: 0,
        revenue_cent: 0
      }
    })
  })

  it('omits revenue everywhere with hidden rates and never returns descriptions or notes', () => {
    const hidden = report(['client', 'project', 'day'], {}, HIDE)
    expect(hidden.totals.seconds).toBe(7681)
    expect(JSON.stringify(hidden)).not.toMatch(
      /revenue_cent|rate_cent|description|private_note|Secret/
    )
    expect(JSON.stringify(report(['client', 'project', 'day']))).not.toMatch(
      /description|private_note|Secret/
    )
  })

  it('keeps sub-second billable groups even at zero rates, but omits non-billable zero-work groups', () => {
    add(7, 0.4, 1, 11)
    add(8, 0.4, 2, null, 0)
    const extra = { from: '2026-10-07', to: '2026-10-08' }
    expect(report(['day'], extra, HIDE).rows).toEqual([
      {
        day: '2026-10-07',
        entry_count: 1,
        seconds: 0,
        billable_seconds: 0,
        rounded_seconds: 1800,
        billable_rounded_seconds: 1800
      }
    ])
    expect(report(['day'], extra).totals.entry_count).toBe(2)
  })

  it('does not reveal a revenue-only group even if the view returns such a row', () => {
    // Defensive privacy contract: independent of any future view/money change.
    // Entry data was written through writeEntry; only the view is replaced.
    db.exec(`CREATE TEMP VIEW billing_lines AS SELECT entry_id, client_id, project_id, segment_date,
        billable, started_at, started_at AS stopped_at, 0 AS billed_minutes, 123 AS fee_cent
      FROM main.billing_lines WHERE segment_date = '2026-10-01'`)
    for (const privacy of [HIDE, SHOW]) {
      const result = report(['client'], {}, privacy)
      expect(result.rows).toEqual([])
      expect(result.totals.entry_count).toBe(1)
      expect(result.totals.revenue_cent).toBe(privacy.exposeRates ? 123 : undefined)
    }
  })

  it('accepts 366 calendar days across DST and leap day', () => {
    expect(report([], { from: '2026-01-01', to: '2027-01-01' }).totals.entry_count).toBe(11)
    expect(report([], { from: '2028-01-01', to: '2028-12-31' }).totals.entry_count).toBe(0)
  })

  it.each(['2026-02-30', '2026-6-01', '2026-10-01T00:00:00Z', '', '2026-13-01'])(
    'rejects invalid dates with check_period wording: %j',
    (date) => {
      for (const field of ['from', 'to'])
        expect(() => report([], { [field]: date })).toThrow(`Ungültiges Datum: ${date}`)
    }
  )
  it('rejects more than 366 days', () => {
    expect(() => report([], { from: '2026-01-01', to: '2027-01-02' })).toThrow(
      'at most 366 days, requested: 367'
    )
  })
  it('rejects reversed ranges', () => {
    expect(() => report([], { from: '2026-11-01' })).toThrow('is after to')
  })
  it('rejects duplicate grouping keys', () => {
    expect(() => report(['day', 'day'])).toThrow('group_by names a group twice')
  })

  it('serves the report through MCP with filters, defaults and privacy resolved afresh', async () => {
    const call = async (args: Record<string, unknown>): Promise<McpReport> => {
      const result = await client.callTool({ name: 'get_report', arguments: { ...month, ...args } })
      expect(result.isError).not.toBe(true)
      return JSON.parse((result.content as { text: string }[])[0].text)
    }
    expect(await call({})).toEqual(report([], {}, HIDE))
    db.prepare("UPDATE settings SET value = '1' WHERE key = 'mcp_expose_rates'").run()
    expect(
      await call({
        group_by: ['day', 'project'],
        client_id: 1,
        project_id: 10,
        billable_only: true
      })
    ).toEqual(report(['day', 'project'], { clientId: 1, projectId: 10, billableOnly: true }))
    expect(client.getInstructions()).toContain('get_report')
    const tool = (await client.listTools()).tools.find((t) => t.name === 'get_report')!
    expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: false })
    expect(tool.description).toContain('once in totals')
  })

  it.each([
    [{ from: '2026-02-30' }, 'Ungültiges Datum'],
    [{ from: '2026-11-01' }, 'is after to'],
    [{ from: '2025-01-01' }, 'at most 366 days'],
    [{ group_by: ['client', 'client'] }, 'group_by names a group twice'],
    [{ group_by: ['invalid'] }, ''],
    [{ client_id: 1.5 }, '']
  ])('rejects invalid MCP input %j', async (args, message) => {
    const result = await client.callTool({ name: 'get_report', arguments: { ...month, ...args } })
    expect(result.isError).toBe(true)
    expect((result.content as { text: string }[])[0].text).toContain(message)
  })
})
