import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry } from '../test/entryFixtures'
import { buildServer } from './server'

let Ctor: DatabaseCtor
let db: Database.Database
let dir: string
let client: Client
const local = (day: number, hour: number): string => new Date(2026, 5, day, hour).toISOString()
const month = { client_id: 1, year: 2026, month: 6 }
const dates = { client_id: 1, from: '2026-06-01', to: '2026-06-30' }
const expectedFindings = [
  {
    entry_id: 10,
    started_at: local(1, 8),
    rule: 'missing_description',
    params: {},
    message: 'Beschreibung fehlt.'
  },
  {
    entry_id: 11,
    started_at: local(6, 6),
    rule: 'entry_over_threshold',
    params: { hours: '11:00', threshold: 10 },
    message: 'Eintrag: 11:00 h, über 10 h.'
  },
  {
    entry_id: 11,
    started_at: local(6, 6),
    rule: 'format_name',
    params: { name: 'Alice' },
    message: 'Kontaktperson im Text: Alice.'
  },
  {
    entry_id: 11,
    started_at: local(6, 6),
    rule: 'format_prefix',
    params: { field: 'Work' },
    message: 'Erlaubtes Präfix fehlt: Work.'
  },
  {
    entry_id: 11,
    started_at: local(6, 6),
    rule: 'weekend',
    params: {},
    message: 'Arbeitszeit am Wochenende.'
  }
]
const expected = {
  client_id: 1,
  project_id: null,
  from: '2026-06-01',
  to: '2026-06-30',
  count: expectedFindings.length,
  findings: expectedFindings
}

beforeAll(async () => {
  Ctor = await loadSqlite()
})
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'timetrack-check-period-'))
  const path = join(dir, 'test.db')
  db = new Ctor(path)
  applyMigrations(db)
  db.exec(`INSERT INTO clients (id, name, color, rate_cent, contact_person) VALUES
    (1, 'First', '#111111', 10000, 'Alice'), (2, 'Second', '#222222', 10000, NULL);
    INSERT INTO projects (id, client_id, name) VALUES
    (1, 1, 'First project'), (2, 2, 'Other client'), (3, 1, 'Empty project')`)
  const setting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
  setting.run('rule_check', JSON.stringify({ dayMaxHours: 24 }))
  setting.run('feedback_rules', JSON.stringify({ prefixes: ['Work'] }))
  seedEntry(db, {
    id: 10,
    client_id: 1,
    project_id: 1,
    description: '',
    started_at: local(1, 8),
    stopped_at: local(1, 9),
    private_note: 'Private note'
  })
  seedEntry(db, {
    id: 11,
    client_id: 1,
    project_id: 1,
    description: 'Meeting with Alice',
    started_at: local(6, 6),
    stopped_at: local(6, 17)
  })
  vi.stubEnv('TIMETRACK_DB_PATH', path)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await buildServer().connect(serverTransport)
  client = new Client({ name: 'rule-check-test', version: '0.0.0' })
  await client.connect(clientTransport)
})
afterEach(async () => {
  await client.close()
  db.close()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})
afterAll(() => vi.restoreAllMocks())

async function check(args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name: 'check_period', arguments: args })
  expect(result.isError).not.toBe(true)
  return JSON.parse((result.content as { text: string }[])[0].text)
}
async function error(args: Record<string, unknown>, message: string): Promise<void> {
  const result = await client.callTool({ name: 'check_period', arguments: args })
  expect(result.isError).toBe(true)
  expect((result.content as { text: string }[])[0].text).toContain(message)
}

describe('MCP check_period', () => {
  it('formats the day message while keeping params.day machine-readable', async () => {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
      JSON.stringify({ dayMaxHours: 10 }),
      'rule_check'
    )
    expect(await check(month)).toEqual(
      expect.objectContaining({
        findings: expect.arrayContaining([
          expect.objectContaining({
            rule: 'day_over_threshold',
            params: { day: '2026-06-06', hours: '11:00', threshold: 10 },
            message: '06.06.2026: insgesamt 11:00 h, über 10 h.'
          })
        ])
      })
    )
  })
  it('returns ordered findings with German messages and only the public fields', async () => {
    expect(await check(month)).toEqual(expected)
  })

  it('returns the same findings for a local month and inclusive dates', async () => {
    const byMonth = await check(month)
    expect(byMonth).toEqual(expected)
    expect(await check(dates)).toEqual(byMonth)
  })

  it('checks archived clients normally', async () => {
    db.prepare('UPDATE clients SET active = 0 WHERE id = 1').run()
    expect(await check(dates)).toEqual(expected)
  })

  it('filters by a project of the client and returns its id', async () => {
    expect(await check({ ...month, project_id: 3 })).toEqual({
      ...expected,
      project_id: 3,
      count: 0,
      findings: []
    })
    expect(await check({ ...month, project_id: 1 })).toEqual({ ...expected, project_id: 1 })
  })

  it('includes both boundary dates and excludes the adjacent days', async () => {
    expect(await check({ ...dates, from: '2026-06-06', to: '2026-06-06' })).toEqual({
      ...expected,
      from: '2026-06-06',
      to: '2026-06-06',
      count: 4,
      findings: expectedFindings.slice(1)
    })
  })

  it('returns an empty result for an empty period', async () => {
    expect(await check({ ...month, month: 7 })).toEqual({
      ...expected,
      from: '2026-07-01',
      to: '2026-07-31',
      count: 0,
      findings: []
    })
  })

  it('rejects an unknown client', async () => {
    await error({ ...month, client_id: 999 }, 'Kein Kunde mit der ID 999')
  })
  it('rejects an unknown project', async () => {
    await error({ ...month, project_id: 999 }, 'Kein Projekt mit der ID 999')
  })
  it('rejects a project of another client', async () => {
    await error({ ...month, project_id: 2 }, 'Projekt mit der ID 2 gehört nicht zum Kunden 1')
  })

  it.each([
    { ...month, ...dates },
    { client_id: 1 },
    { client_id: 1, year: 2026 },
    { client_id: 1, month: 6 },
    { client_id: 1, from: '2026-06-01' },
    { client_id: 1, to: '2026-06-30' },
    { ...month, from: '2026-06-01' },
    { ...dates, month: 6 }
  ])('rejects missing, partial or mixed period forms: %j', async (args) => {
    await error(args, 'Genau einen Zeitraum angeben: year und month oder from und to')
  })

  it.each(['2026-02-30', '2026-6-01', '2026-06-01T00:00:00Z', ''])(
    'rejects an invalid local date: %j',
    async (from) => {
      await error({ ...dates, from }, 'Ungültiges Datum')
    }
  )

  it('rejects a reversed date range', async () => {
    await error({ ...dates, from: '2026-07-01' }, 'from darf nicht nach to liegen')
  })
})
