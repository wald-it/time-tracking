import * as errors from '../../../shared/rateEditor'
import type { TFunction } from '../contexts/I18nContext'

export function rateEditorError(message: string, t: TFunction): string {
  const clean = message.replace(/^(?:Sqlite)?Error:\s*/, '')
  const messages = [
    [errors.RATE_EDITOR_CONFLICT_ERROR, 'rates.conflict'],
    [errors.RATE_DATE_ERROR, 'rates.dateError'],
    [errors.RATE_VALUE_ERROR, 'rates.valueError'],
    [errors.RATE_BASELINE_ERROR, 'rates.baselineError'],
    [errors.RATE_DELETE_ERROR, 'rates.deleteError'],
    [errors.PROFILE_INTERVAL_ERROR, 'rates.intervalError'],
    [errors.PROFILE_MINIMUM_ERROR, 'rates.minimumError'],
    [errors.RATE_OWNER_ERROR, 'rates.ownerError'],
    [errors.RATE_ROW_ERROR, 'rates.rowError']
  ] as const
  const match = messages.find(([text]) => text === clean)
  return t(match?.[1] ?? 'clients.form.saveFailed')
}
