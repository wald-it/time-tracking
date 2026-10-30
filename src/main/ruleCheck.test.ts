import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { applyMigrations, loadSqlite, type DatabaseCtor } from '../test/sqlite'
import { seedEntry, type SeedEntryInput } from '../test/entryFixtures'
import { checkPeriod, type RuleCheckRequest } from './ruleCheck'
import { buildPdfPayload } from './pdf'
import { splitAtMidnight } from '../shared/midnightSplit'
import type { RuleCheckId } from '../shared/ruleCheck'

let Ctor: DatabaseCtor
let db: Database.Database
const request = { clientId: 1, fromIso: '2026-06-01', toIso: '2026-06-30' }
const local = (day: number, hour: number, minute = 0): string =>
  new Date(2026, 5, day, hour, minute).toISOString()

beforeAll(async () => {
  Ctor = await loadSqlite()
})
beforeEach(() => {
  db = new Ctor(':memory:')
  applyMigrations(db)
  db.exec(`INSERT INTO clients (id, name, color, rate_cent) VALUES
    (1, 'First', '#111111', 10000), (2, 'Second', '#222222', 0);
    INSERT INTO projects (id, client_id, name) VALUES (1, 1, 'Project')`)
})
afterEach(() => db.close())

function entry(day = 1, start = 8, stop = 9, extra: Partial<SeedEntryInput> = {}): number {
  return seedEntry(db, {
    client_id: 1,
    project_id: 1,
    description: 'Work',
    started_at: local(day, start),
    stopped_at: local(day, stop),
    ...extra
  })
}
function setting(key: string, value: unknown): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    key,
    JSON.stringify(value)
  )
}
function findings(
  rule: RuleCheckId,
  overrides: Partial<RuleCheckRequest> = {}
): ReturnType<typeof checkPeriod> {
  return checkPeriod(db, { ...request, ...overrides }).filter((finding) => finding.rule === rule)
}

describe('checkPeriod', () => {
  it('checks migrated zero-length entries without throwing or adding working time', () => {
    const id = entry(1, 8, 8, { description: '' })
    expect(checkPeriod(db, request)).toEqual([
      { entryId: id, rule: 'missing_description', params: {} }
    ])
  })
  it('reports empty and whitespace descriptions but accepts nonempty text', () => {
    const a = entry(1, 8, 9, { description: '' })
    const b = entry(2, 8, 9, { description: ' \n\t ' })
    entry(3, 8, 9, { description: ' Work ' })
    expect(findings('missing_description').map((f) => f.entryId)).toEqual([a, b])
  })

  it('reports missing projects and informational non-billable entries independently', () => {
    const id = entry(1, 8, 9, { project_id: null, billable: 0, client_id: 2 })
    entry(2)
    expect(checkPeriod(db, { ...request, clientId: 2 })).toEqual([
      { entryId: id, rule: 'missing_project', params: {} },
      { entryId: id, rule: 'not_billable', params: {} }
    ])
    expect(findings('missing_project')).toEqual([])
    expect(findings('not_billable')).toEqual([])
  })

  it('uses dated project overrides, zero rates and client inheritance from billing_lines', () => {
    db.exec(`INSERT INTO rate (project_id, valid_from, rate_cent) VALUES
      (1, '2026-06-02', 0), (1, '2026-06-03', NULL), (1, '2026-06-04', 5000)`)
    entry(1)
    const zero = entry(2)
    entry(3)
    entry(4)
    expect(findings('billable_without_rate').map((f) => f.entryId)).toEqual([zero])
    const missing = entry(5, 8, 9, { client_id: 2, project_id: null })
    db.prepare('DELETE FROM rate WHERE client_id = 2').run()
    expect(findings('billable_without_rate', { clientId: 2 }).map((f) => f.entryId)).toEqual([
      missing
    ])
  })

  it('accepts exactly ten hours and reports one minute over for entry and day', () => {
    entry(1, 6, 16)
    const over = entry(2, 6, 16, { stopped_at: local(2, 16, 1) })
    for (const rule of ['entry_over_threshold', 'day_over_threshold'] as const) {
      expect(findings(rule)).toEqual([
        {
          entryId: over,
          rule,
          params: {
            hours: '10:01',
            threshold: 10,
            ...(rule === 'day_over_threshold' ? { day: '2026-06-02' } : {})
          }
        }
      ])
    }
  })

  it('counts all clients and unassigned projects in the day total, once per checked entry', () => {
    const a = entry(1, 6, 8)
    const b = entry(1, 8, 10)
    entry(1, 10, 16, { client_id: 2, project_id: null, billable: 0 })
    expect(findings('day_over_threshold')).toEqual([])
    // Legacy/orphan relation: no matching client record; still working time.
    db.pragma('foreign_keys = OFF')
    entry(1, 16, 17, { client_id: 999, project_id: null })
    expect(findings('day_over_threshold', { projectId: 1 })).toEqual(
      [a, b].map((entryId) => ({
        entryId,
        rule: 'day_over_threshold',
        params: { day: '2026-06-01', hours: '11:00', threshold: 10 }
      }))
    )
  })

  it.each([
    [6, 0, 8, 0, false],
    [20, 0, 22, 0, false],
    [5, 59, 8, 0, true],
    [20, 0, 22, 1, true]
  ] as const)('checks window %i:%i to %i:%i (outside %s)', (sh, sm, eh, em, outside) => {
    const id = entry(1, sh, eh, { started_at: local(1, sh, sm), stopped_at: local(1, eh, em) })
    expect(findings('outside_window')).toEqual(
      outside
        ? [{ entryId: id, rule: 'outside_window', params: { start: '06:00', end: '22:00' } }]
        : []
    )
  })

  it('splits midnight shares on both days and checks the whole logical entry only once', () => {
    entry(1, 6, 15, { client_id: 2, project_id: null })
    entry(2, 6, 15, { client_id: 2, project_id: null })
    const id = seedEntry(db, {
      client_id: 1,
      project_id: 1,
      description: '',
      segments: splitAtMidnight(new Date(local(1, 22)), new Date(local(2, 11))).map((s) => ({
        started_at: s.start.toISOString(),
        stopped_at: s.stop.toISOString()
      }))
    })
    expect(findings('day_over_threshold')).toEqual([
      {
        entryId: id,
        rule: 'day_over_threshold',
        params: { day: '2026-06-01', hours: '11:00', threshold: 10 }
      },
      {
        entryId: id,
        rule: 'day_over_threshold',
        params: { day: '2026-06-02', hours: '20:00', threshold: 10 }
      }
    ])
    expect(findings('entry_over_threshold')).toEqual([
      { entryId: id, rule: 'entry_over_threshold', params: { hours: '13:00', threshold: 10 } }
    ])
    expect(findings('outside_window')).toHaveLength(1)
    expect(findings('missing_description')).toHaveLength(1)
  })

  it('checks both sides of midnight and treats an exact midnight stop as exclusive', () => {
    const friday = entry(5, 23, 24)
    const intoSaturday = entry(5, 23, 25)
    const sunday = entry(7, 23, 25)
    expect(findings('weekend').map((f) => f.entryId)).toEqual([intoSaturday, sunday])
    expect(findings('outside_window').map((f) => f.entryId)).toEqual([friday, intoSaturday, sunday])
  })

  it('reports Saturday and Sunday, accepts weekdays, and respects weekend off', () => {
    entry(5)
    const saturday = entry(6)
    const sunday = entry(7)
    expect(findings('weekend').map((f) => f.entryId)).toEqual([saturday, sunday])
    setting('rule_check', { weekend: false })
    expect(findings('weekend')).toEqual([])
  })

  it('uses UTF-16 length like the write cap and accepts exactly the threshold', () => {
    entry(1, 8, 9, { description: '😀'.repeat(150) })
    const over = entry(2, 8, 9, { description: '😀'.repeat(150) + 'x' })
    expect(findings('too_long')).toEqual([
      { entryId: over, rule: 'too_long', params: { length: 301, threshold: 300 } }
    ])
  })

  it('reads every threshold from settings and falls back on malformed JSON', () => {
    const id = entry(1, 8, 10)
    setting('rule_check', {
      entryMaxHours: 1,
      dayMaxHours: 1,
      windowStart: '09:00',
      windowEnd: '09:30',
      maxDescriptionLength: 3
    })
    expect(checkPeriod(db, request)).toEqual([
      {
        entryId: id,
        rule: 'day_over_threshold',
        params: { day: '2026-06-01', hours: '2:00', threshold: 1 }
      },
      { entryId: id, rule: 'entry_over_threshold', params: { hours: '2:00', threshold: 1 } },
      { entryId: id, rule: 'outside_window', params: { start: '09:00', end: '09:30' } },
      { entryId: id, rule: 'too_long', params: { length: 4, threshold: 3 } }
    ])
    db.prepare("UPDATE settings SET value = '{broken' WHERE key = 'rule_check'").run()
    expect(checkPeriod(db, request)).toEqual([])
  })

  it('maps every feedback finding using current rules and master names', () => {
    db.exec(
      "UPDATE clients SET contact_person = 'Anna' WHERE id = 1; UPDATE projects SET contact_person = 'Ben' WHERE id = 1"
    )
    setting('feedback_rules', { prefixes: ['IT'], separator: ';', forbidden: ['secret'] })
    const id = entry(1, 8, 9, { description: 'Other: Anna Ben; secret;;' })
    expect(checkPeriod(db, request)).toEqual([
      { entryId: id, rule: 'format_forbidden', params: { field: 'secret' } },
      { entryId: id, rule: 'format_name', params: { name: 'Anna' } },
      { entryId: id, rule: 'format_name', params: { name: 'Ben' } },
      { entryId: id, rule: 'format_prefix', params: { field: 'IT' } },
      { entryId: id, rule: 'format_separator', params: { field: '3' } },
      { entryId: id, rule: 'format_separator', params: { field: '4' } }
    ])
  })

  it('matches PDF period/project selection and excludes trash and running entries from totals', () => {
    const id = entry(1, 8, 9, { description: '' })
    entry(2, 8, 23, { deleted_at: local(3, 8) })
    entry(1, 0, 23, { deleted_at: local(3, 8), client_id: 2 })
    entry(1, 0, 23, { stopped_at: null })
    seedEntry(db, {
      client_id: 2,
      segments: [
        { started_at: local(1, 0), stopped_at: local(2, 0) },
        { started_at: local(2, 0), stopped_at: null }
      ]
    })
    entry(1, 9, 10, { project_id: null })
    entry(30, 8, 9, { description: '' })
    const req = { ...request, projectId: 1, toIso: '2026-06-01' }
    expect(buildPdfPayload(db, req, '').rows).toHaveLength(1)
    expect(checkPeriod(db, req)).toEqual([{ entryId: id, rule: 'missing_description', params: {} }])
    expect(checkPeriod(db, { ...req, projectId: 99 })).toEqual([])
    expect(findings('missing_description').map((f) => f.entryId)).toHaveLength(2)
  })

  it('measures a migrated link group by its segments, not across the gap between them', () => {
    // 2026-06-05 is a Friday, 2026-06-08 the Monday after.
    const id = seedEntry(db, {
      client_id: 1,
      project_id: 1,
      description: 'Work',
      segments: [
        { started_at: local(5, 17), stopped_at: local(5, 18) },
        { started_at: local(8, 8), stopped_at: local(8, 9) }
      ]
    })
    expect(checkPeriod(db, request).filter((f) => f.entryId === id)).toEqual([])
  })

  it('reports a day once when two stored segments fall on the same local day', () => {
    // Stored dates differ, as after a time-zone change; both segments are on 2 June locally.
    const id = seedEntry(db, {
      client_id: 1,
      project_id: 1,
      description: 'Work',
      segments: [
        { started_at: local(2, 6), stopped_at: local(2, 12), segment_date: '2026-06-01' },
        { started_at: local(2, 13), stopped_at: local(2, 19), segment_date: '2026-06-02' }
      ]
    })
    expect(findings('day_over_threshold')).toEqual([
      {
        entryId: id,
        rule: 'day_over_threshold',
        params: { day: '2026-06-02', hours: '12:00', threshold: 10 }
      }
    ])
  })

  it('uses stored segment dates for selection even after a time-zone change', () => {
    const id = seedEntry(db, {
      client_id: 1,
      project_id: 1,
      description: '',
      segments: [{ started_at: local(2, 8), stopped_at: local(2, 9), segment_date: '2026-06-01' }]
    })
    expect(findings('missing_description', { toIso: '2026-06-01' }).map((f) => f.entryId)).toEqual([
      id
    ])
  })

  it('sorts by entry start then rule, including ties, regardless of insertion order', () => {
    const later = entry(2, 8, 9, { description: '', project_id: null })
    const earlier = entry(1, 8, 9, { description: '', project_id: null })
    const tie = entry(1, 8, 9, { description: '', project_id: null })
    expect(checkPeriod(db, request).map((f) => [f.entryId, f.rule])).toEqual([
      [earlier, 'missing_description'],
      [tie, 'missing_description'],
      [earlier, 'missing_project'],
      [tie, 'missing_project'],
      [later, 'missing_description'],
      [later, 'missing_project']
    ])
  })

  it('performs no writes, including settings, and is deterministic', () => {
    entry(1, 5, 23, { description: '' })
    const before = db.prepare('SELECT total_changes() AS n').get()
    const first = checkPeriod(db, request)
    expect(checkPeriod(db, request)).toEqual(first)
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
    db.pragma('query_only = ON')
    expect(checkPeriod(db, request)).toEqual(first)
  })
})
