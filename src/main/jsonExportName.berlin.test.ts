import { expect, it } from 'vitest'
import { jsonExportFileName } from './jsonExportName'

it('uses November 5 in the JSON export name in Berlin when UTC is still November 4', () => {
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Berlin')
  expect(jsonExportFileName(new Date('2026-11-04T23:30:00Z'))).toBe(
    'timetrack-export-2026-11-05.json'
  )
})
