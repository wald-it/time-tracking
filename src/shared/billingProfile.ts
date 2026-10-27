/** The slice of a better-sqlite3 handle these readers need (main and MCP share them). */
type Db = { prepare(sql: string): { get(...params: unknown[]): unknown } }

/**
 * Readers of the billing profile (2.0 design section 4.5). Money itself is
 * computed in the view `billing_lines`; these helpers only answer questions
 * about the configuration.
 */

/**
 * The default profile's interval (the 1.x setting `pdf_round_minutes`, which
 * stays the editor of this row until the profile UI of P6). 0 = off.
 */
export function readDefaultIntervalMin(db: Db): number {
  const row = db
    .prepare(
      'SELECT interval_min FROM billing_profile WHERE client_id IS NULL AND project_id IS NULL'
    )
    .get() as { interval_min: number | null } | undefined
  const n = row?.interval_min ?? 0
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** True when any profile rounds: an interval or a minimum unit above 0. */
export function roundingConfigured(db: Db): boolean {
  return (
    db
      .prepare('SELECT 1 FROM billing_profile WHERE interval_min > 0 OR min_unit_min > 0 LIMIT 1')
      .get() !== undefined
  )
}

/** True when any client or project has a rate above 0. */
export function anyRateConfigured(db: Db): boolean {
  return db.prepare('SELECT 1 FROM rate WHERE rate_cent > 0 LIMIT 1').get() !== undefined
}
