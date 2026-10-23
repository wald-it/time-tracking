/**
 * Returns 'sn' if the filename looks like a Stundennachweis,
 * 'invoice' if it looks like a Rechnung, or null if ambiguous.
 *
 * Used by PdfMergeModal to offer a swap when the user drops a file
 * into the wrong slot.
 */
export function detectFilePurpose(filename: string): 'sn' | 'invoice' | null {
  if (!filename) return null
  // `timesheet`: the English name the app writes since #296.
  if (/stundennachweis|nachweis|timesheet|sn[_-]/i.test(filename)) return 'sn'
  if (/rechnung|invoice|inv[_-]/i.test(filename)) return 'invoice'
  return null
}
