/** Optional targets. Hours are decimal hours; money is integer cents. */
function decimalInput(raw: string | undefined): string | null {
  const value = raw?.trim().replace(',', '.') ?? ''
  return /^\+?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? value : null
}

export function parseWeeklyTargetHours(raw: string | undefined): number | null {
  const value = Number(decimalInput(raw))
  return Number.isFinite(value) && value > 0 && value <= 168 ? value : null
}

/** Euros entered by the user → cents, decimal half-up without float drift. */
export function parseTargetRateCent(raw: string | undefined): number | null {
  const value = decimalInput(raw)
  if (value === null) return null
  const [euros, fraction = ''] = value.split('.')
  const cents =
    Number(euros) * 100 +
    Number(fraction.padEnd(2, '0').slice(0, 2)) +
    (Number(fraction[2] ?? '0') >= 5 ? 1 : 0)
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

/** Persisted rate settings already contain cents, not euros. */
export function targetRateFromSetting(raw: string | undefined): number | null {
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** Mon–Fri, without adjusting for public holidays. Month is 1-based. */
export function weekdaysInMonth(year: number, month: number): number {
  const days = new Date(year, month, 0).getDate()
  let weekdays = 0
  for (let day = 1; day <= days; day++) {
    const weekday = new Date(year, month - 1, day).getDay()
    if (weekday !== 0 && weekday !== 6) weekdays++
  }
  return weekdays
}

export function monthlyTargetHours(weeklyHours: number, year: number, month: number): number {
  return (weeklyHours * weekdaysInMonth(year, month)) / 5
}

/** Ratio, not percent. All worked hours belong in the numerator. */
export function utilisation(workedHours: number, targetHours: number): number | null {
  return targetHours > 0 ? workedHours / targetHours : null
}

/** Calendar-day pace; elapsed days include today. Call only for the current month. */
export function monthProjection(actual: number, daysElapsed: number, daysInMonth: number): number {
  return (actual / daysElapsed) * daysInMonth
}

/** Revenue divided by ALL worked hours, including non-billable work. */
export function workedHourlyRateCent(revenueCent: number, workedHours: number): number | null {
  return workedHours > 0 ? revenueCent / workedHours : null
}
