import type { Migration } from './index'
import { RATE_EDITOR_CONFLICT_ERROR } from '../../shared/rateEditor'

// Only the update triggers change. The legacy insert/delete and default-profile
// triggers from 030 continue to own their existing paths. The OLD/NEW check from
// 030 stays: a rename sends the column unchanged, which may lag a due editor row.
export const migration033: Migration = {
  version: 33,
  name: 'rate-editor',
  up: `
ALTER TABLE rate ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy'
  CHECK (source IN ('legacy', 'editor'));
${(['client', 'project'] as const)
  .map(
    (kind) => `
DROP TRIGGER trg_rate_sync_${kind}_update;
CREATE TRIGGER trg_rate_sync_${kind}_update AFTER UPDATE OF rate_cent ON ${kind === 'client' ? 'clients' : 'projects'}
  WHEN OLD.rate_cent IS NOT NEW.rate_cent AND NEW.rate_cent IS NOT (SELECT rate_cent FROM rate WHERE ${kind}_id = NEW.id
    AND valid_from <= date('now', 'localtime') ORDER BY valid_from DESC LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, '${RATE_EDITOR_CONFLICT_ERROR.replace(/'/g, "''")}')
    WHERE EXISTS (SELECT 1 FROM rate WHERE ${kind}_id = NEW.id
      AND valid_from = date('now', 'localtime') AND source = 'editor');
  INSERT INTO rate (${kind}_id, rate_cent, valid_from)
    VALUES (NEW.id, NEW.rate_cent, date('now', 'localtime'))
    ON CONFLICT (${kind}_id, valid_from) WHERE ${kind}_id IS NOT NULL
    DO UPDATE SET rate_cent = excluded.rate_cent WHERE rate.source = 'legacy';
END;
`
  )
  .join('')}
`
}
