/**
 * This row's rate today, or its stored column when it has no rate history.
 * A due NULL project rate preserves inheritance; it must not fall back to an
 * older rate or resolve the client's number. Pass trusted table/alias names.
 */
export function dueRateSql(table: string, column: string): string {
  return `CASE WHEN EXISTS (SELECT 1 FROM rate WHERE ${column} = ${table}.id)
    THEN (SELECT rate_cent FROM rate WHERE ${column} = ${table}.id
      AND valid_from <= date('now', 'localtime') ORDER BY valid_from DESC LIMIT 1)
    ELSE ${table}.rate_cent END`
}
