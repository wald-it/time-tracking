import { createContext, useContext, useEffect, useState } from 'react'

/**
 * One clock for the whole window (Messinstrument, HANDOFF §3.8): the running
 * readout in the header, the display digits, the DayScale needle, the running
 * bar and the live totals all read `useNow()` instead of starting their own
 * intervals. It ticks every second while a timer runs and every 30 seconds
 * otherwise (the idle needle only has to keep up with the minute).
 */
const NowContext = createContext<number>(Date.now())

export function NowProvider({
  running,
  children
}: {
  running: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    // Snap to the current time as soon as the cadence changes, so a timer that
    // just started does not show a stale second for up to 30 s.
    const snap = setTimeout(() => setNow(Date.now()), 0)
    const id = setInterval(() => setNow(Date.now()), running ? 1000 : 30_000)
    return () => {
      clearTimeout(snap)
      clearInterval(id)
    }
  }, [running])
  return <NowContext.Provider value={now}>{children}</NowContext.Provider>
}

/** Current time in ms, refreshed by the single NowProvider interval. */
// eslint-disable-next-line react-refresh/only-export-components -- Provider + Hook bewusst im selben Modul, wie RoundingContext/I18nContext.
export function useNow(): number {
  return useContext(NowContext)
}
