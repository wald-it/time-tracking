import { powerMonitor } from 'electron'

/** Schedule local daily backups without coupling the clock to a database handle. */
export function startDailyBackupSchedule(run: () => Promise<void>): () => void {
  let timer: ReturnType<typeof setTimeout>
  let stopped = false
  let inFlight = false

  async function trigger(): Promise<void> {
    if (stopped || inFlight) return
    inFlight = true
    try {
      await run()
    } catch (err) {
      console.warn('[backup] Scheduled daily backup failed (non-fatal):', err)
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
