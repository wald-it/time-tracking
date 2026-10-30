/** Shared validation for run creation, later edits and CSV exports. */
export function normalizeInvoiceRef(value: string | undefined): string {
  const ref = (value ?? '').trim()
  if (ref.length > 64) {
    throw new Error('Die Rechnungsnummer darf höchstens 64 Zeichen lang sein.')
  }
  return ref
}
