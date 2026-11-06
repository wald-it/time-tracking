import { localDateKey } from '../shared/dateRanges'

export function jsonExportFileName(now: Date): string {
  return `timetrack-export-${localDateKey(now)}.json`
}
