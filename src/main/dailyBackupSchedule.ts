import { powerMonitor } from 'electron'

/** Schedule local daily backups without coupling the clock to a database handle. */
export function startDailyBackupSchedule(run: () => Promise<void>): () => void {
  let timer: ReturnType<typeof setTimeout>
  let stopped = false
  let inFlight = false
  let pending = false

  // A trigger during a run is remembered, not dropped: a run that started
  // before midnight (or before sleep) may still be busy when the new day's
  // trigger comes, and that day would otherwise get no backup. The rerun is
  // cheap, `runDailyBackupIfNeeded` skips a day that already has one.
  async function trigger(): Promise<void> {
    if (stopped) return
    if (inFlight) {
      pending = true
      return
    }
    inFlight = true
    try {
      do {
        pending = false
        try {
          await run()
        } catch (err) {
          console.warn('[backup] Scheduled daily backup failed (non-fatal):', err)
        }
      } while (pending && !stopped)
    } finally {
      inFlight = false
    }
  }

  function arm(): void {
    clearTimeout(timer)
    if (stopped) return
    const now = new Date()
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    timer = setTimeout(
      () => {
        void trigger()
        arm()
      },
      midnight.getTime() + 1000 - Date.now()
    )
  }

  function onResume(): void {
    void trigger()
    arm()
  }

  powerMonitor.on('resume', onResume)
  arm()
  return () => {
    stopped = true
    clearTimeout(timer)
    powerMonitor.removeListener('resume', onResume)
  }
}
