import type Database from 'better-sqlite3'
import { dueRateSql } from '../shared/dueRate'
import {
  PROFILE_CHOICES,
  PROFILE_CHOICE_ERROR,
  PROFILE_INTERVAL_ERROR,
  PROFILE_MINIMUM_ERROR,
  RATE_BASELINE_ERROR,
  RATE_DATE_ERROR,
  RATE_DELETE_ERROR,
  RATE_OWNER_ERROR,
  RATE_ROW_ERROR,
  RATE_VALUE_ERROR,
  type ProfileEditorData,
  type ProfileFields,
  type ResolvedProfileFields,
  type RateRow,
  type RateTarget,
  type SaveRateInput,
  type RateEditorData
} from '../shared/rateEditor'

type Db = Database.Database

/** Validate the IPC boundary before choosing any table/column names. */
function owner(
  db: Db,
  target: RateTarget
): { table: string; column: string; clientId: number | null } {
  if (
    !target ||
    !['client', 'project'].includes(target.kind) ||
    !Number.isSafeInteger(target.id) ||
    target.id < 1
  ) {
    throw new Error(RATE_OWNER_ERROR)
  }
  const table = target.kind === 'client' ? 'clients' : 'projects'
  const row = db
    .prepare(
      `SELECT ${target.kind === 'client' ? 'id AS client_id' : 'client_id'} FROM ${table} WHERE id = ?`
    )
    .get(target.id) as { client_id: number | null } | undefined
  if (!row) throw new Error(RATE_OWNER_ERROR)
  return { table, column: `${target.kind}_id`, clientId: row.client_id }
}

function validDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01')
    return false
  const date = new Date(value + 'T00:00:00.000Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function listRates(db: Db, target: RateTarget): RateRow[] {
  const { column } = owner(db, target)
  return db
    .prepare(`SELECT id, valid_from, rate_cent FROM rate WHERE ${column} = ? ORDER BY valid_from`)
    .all(target.id) as RateRow[]
}

function findRow(db: Db, target: RateTarget, id: number): RateRow {
  const row = listRates(db, target).find((r) => r.id === id)
  if (!row) throw new Error(RATE_ROW_ERROR)
  return row
}

export function readRates(db: Db, target: RateTarget): RateEditorData {
  const { table } = owner(db, target)
  const current = db.prepare(`SELECT rate_cent FROM ${table} WHERE id = ?`).get(target.id) as {
    rate_cent: number | null
  }
  return { rows: listRates(db, target), current_rate_cent: current.rate_cent }
}

function syncCurrent(db: Db, target: RateTarget): RateEditorData {
  const { table, column } = owner(db, target)
  // Deleting the final project row clears the override instead of retaining
  // its old column (the fallback used by readers and the periodic sync).
  const due = listRates(db, target).length === 0 ? 'NULL' : dueRateSql(table, column)
  db.prepare(`UPDATE ${table} SET rate_cent = ${due} WHERE id = ?`).run(target.id)
  return readRates(db, target)
}

/**
 * A future editor row becomes due without any write, so the 1.x columns are
 * moved to the rate valid today on open and before the lists are read. The
 * update triggers stay quiet because the new value is the due rate.
 */
export function syncDueRates(db: Db): void {
  db.transaction(() => {
    for (const [table, column] of [
      ['clients', 'client_id'],
      ['projects', 'project_id']
    ]) {
      const due = dueRateSql(table, column)
      db.prepare(
        `UPDATE ${table} SET rate_cent = ${due}
        WHERE EXISTS (SELECT 1 FROM rate WHERE ${column} = ${table}.id) AND rate_cent IS NOT ${due}`
      ).run()
    }
  })()
}

export function saveRate(db: Db, target: RateTarget, input: SaveRateInput): RateEditorData {
  const { column } = owner(db, target)
  if (!input || !validDate(input.valid_from)) throw new Error(RATE_DATE_ERROR)
  if (
    !(target.kind === 'project' && input.rate_cent === null) &&
    (!Number.isSafeInteger(input.rate_cent) || (input.rate_cent as number) < 0)
  )
    throw new Error(RATE_VALUE_ERROR)
  return db.transaction(() => {
    if (input.id !== undefined) {
      const row = findRow(db, target, input.id)
      if (
        target.kind === 'client' &&
        row.valid_from === '0001-01-01' &&
        input.valid_from !== row.valid_from
      )
        throw new Error(RATE_BASELINE_ERROR)
      // A moved row onto an existing date replaces that date, just like add.
      if (row.valid_from !== input.valid_from)
        db.prepare('DELETE FROM rate WHERE id = ?').run(row.id)
    }
    db.prepare(
      `INSERT INTO rate (${column}, valid_from, rate_cent, source) VALUES (?, ?, ?, 'editor')
      ON CONFLICT (${column}, valid_from) WHERE ${column} IS NOT NULL
      DO UPDATE SET rate_cent = excluded.rate_cent, source = 'editor'`
    ).run(target.id, input.valid_from, input.rate_cent)
    return syncCurrent(db, target)
  })()
}

export function deleteRate(db: Db, target: RateTarget, id: number): RateEditorData {
  return db.transaction(() => {
    const row = findRow(db, target, id)
    if (
      target.kind === 'client' &&
      (row.valid_from === '0001-01-01' || listRates(db, target).length <= 1)
    )
      throw new Error(RATE_DELETE_ERROR)
    db.prepare('DELETE FROM rate WHERE id = ?').run(id)
    return syncCurrent(db, target)
  })()
}

const PROFILE_DEFAULTS: ResolvedProfileFields = {
  interval_min: 0,
  min_unit_min: 0,
  columns: 'times',
  language: 'de',
  fee_column: 'auto',
  group_by: 'none'
}
const PROFILE_KEYS = Object.keys(PROFILE_DEFAULTS) as (keyof ProfileFields)[]

function profileFields(db: Db, column: string, id?: number): Required<ProfileFields> {
  return (
    (db
      .prepare(`SELECT ${PROFILE_KEYS.join(', ')} FROM billing_profile WHERE ${column}`)
      .get(...(id === undefined ? [] : [id])) as Required<ProfileFields> | undefined) ?? {
      interval_min: null,
      min_unit_min: null,
      columns: null,
      language: null,
      fee_column: null,
      group_by: null
    }
  )
}

export function readProfile(db: Db, target: RateTarget): ProfileEditorData {
  const { column, clientId } = owner(db, target)
  const defaults = profileFields(db, 'client_id IS NULL AND project_id IS NULL')
  const parent =
    target.kind === 'project' && clientId !== null
      ? profileFields(db, 'client_id = ?', clientId)
      : null
  return {
    ...profileFields(db, `${column} = ?`, target.id),
    inherited: Object.fromEntries(
      PROFILE_KEYS.map((key) => [key, parent?.[key] ?? defaults[key] ?? PROFILE_DEFAULTS[key]])
    ) as ResolvedProfileFields,
    inherited_source: Object.fromEntries(
      PROFILE_KEYS.map((key) => [key, parent?.[key] != null ? 'client' : 'default'])
    ) as ProfileEditorData['inherited_source']
  }
}

export function saveProfile(db: Db, target: RateTarget, fields: ProfileFields): ProfileEditorData {
  const { column } = owner(db, target)
  for (const [key, max, message] of [
    ['interval_min', 60, PROFILE_INTERVAL_ERROR],
    ['min_unit_min', Number.MAX_SAFE_INTEGER, PROFILE_MINIMUM_ERROR]
  ] as const) {
    if (fields && !Object.hasOwn(fields, key)) continue
    const value = fields?.[key]
    if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > max))
      throw new Error(message)
  }
  for (const key of Object.keys(PROFILE_CHOICES) as (keyof typeof PROFILE_CHOICES)[]) {
    if (!Object.hasOwn(fields, key)) continue
    const value = fields[key]
    const allowed: readonly string[] = PROFILE_CHOICES[key]
    if (value !== null && (typeof value !== 'string' || !allowed.includes(value)))
      throw new Error(PROFILE_CHOICE_ERROR)
  }
  // Write only supplied editor fields, including on conflict; never write alignment or defaults.
  const keys = PROFILE_KEYS.filter((key) => Object.hasOwn(fields, key))
  if (keys.length === 0) return readProfile(db, target)
  db.prepare(
    `INSERT INTO billing_profile (${column}, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})
    ON CONFLICT (${column}) WHERE ${column} IS NOT NULL DO UPDATE
    SET ${keys.map((key) => `${key} = excluded.${key}`).join(', ')}`
  ).run(target.id, ...keys.map((key) => fields[key]))
  return readProfile(db, target)
}
