/**
 * DRV, Gemeinsame Rechtliche Anweisungen zu § 2 SGB VI:
 * „im Wesentlichen nur für einen Auftraggeber“.
 * https://rvrecht.deutsche-rentenversicherung.de/SharedDocs/rvRecht/01_GRA_SGB/06_SGB_VI/pp_0001_25/gra_sgb006_p_0002.html
 */
export const CLIENT_REVENUE_SHARE_THRESHOLD = 5 / 6

/** Ratio over all worked seconds; no worked time means no share. */
export function nonBillableShare(workedSeconds: number, billableSeconds: number): number | null {
  return workedSeconds > 0 ? (workedSeconds - billableSeconds) / workedSeconds : null
}

/** Pass ALL clients in the window, before the UI groups or limits rows. */
export function revenueShare(
  revenueCent: number,
  clients: ReadonlyArray<{ rev: number }>
): number | null {
  const total = clients.reduce((sum, client) => sum + client.rev, 0)
  return total > 0 ? revenueCent / total : null
}

/** Ruler label step for the 12-month client view: 10, 20, 50, 100, 200, 500 … h, at most five steps. */
export function yearLabelStep(maxHours: number): number {
  for (let base = 10; ; base *= 10) {
    for (const step of [base, base * 2, base * 5]) {
      if (Math.ceil(maxHours / step) <= 5) return step
    }
  }
}
