import { useRef, useState } from 'react'
import type { Entry } from '../../../shared/types'
import { formatTimeHHMM, isSameLocalDay, parseTimeToDate } from '../../../shared/date'
import { formatDuration } from '../../../shared/duration'
import { useTimer } from '../hooks/useTimer'
import { useLocale, useT } from '../contexts/I18nContext'
import { useNow } from '../contexts/NowContext'
import { Dialog } from './Dialog'
import { EntryEditForm } from './EntryEditForm'
import { FIELD_LABEL, INPUT, KEY, KEY_INV } from './instrumentClasses'

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Mounted once by App, so the edit form is available from every view. */
export function LongRunModal(): React.JSX.Element | null {
  const timer = useTimer()
  const t = useT()
  const [editEntry, setEditEntry] = useState<Entry | null>(null)
  const entry = timer.runningEntry
  if (!entry) return null
  // The edit form stays mounted under an idle dialog, like Today's edit form,
  // so a draft survives a lock or sleep; only the prompt yields to idle.
  // The form itself carries a saved running entry into the timer store.
  if (editEntry?.id === entry.id) {
    return (
      <Dialog open title={t('today.dialog.edit')} onClose={() => setEditEntry(null)}>
        <EntryEditForm
          entry={editEntry}
          clients={timer.clients}
          onCancel={() => setEditEntry(null)}
          onSaved={() => setEditEntry(null)}
        />
      </Dialog>
    )
  }
  if (timer.idleEvent || timer.longRun?.entryId !== entry.id) return null
  return (
    <LongRunPrompt
      key={entry.id}
      entry={entry}
      onEdit={() => {
        timer.longRunAnswer(entry.id)
        setEditEntry(entry)
      }}
    />
  )
}

function LongRunPrompt({ entry, onEdit }: { entry: Entry; onEdit: () => void }): React.JSX.Element {
  const timer = useTimer()
  const t = useT()
  const { locale } = useLocale()
  // The app clock: a future field becomes valid as time passes. The click
  // itself rechecks against Date.now() (see stop below).
  const now = useNow()
  const keepRef = useRef<HTMLButtonElement>(null)
  const [openedAt] = useState(() => new Date())
  const [date, setDate] = useState(localDate(openedAt))
  const [time, setTime] = useState(formatTimeHHMM(openedAt))
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function stopMs(at: number): number {
    if (!touched) return at
    try {
      return parseTimeToDate(date, time).getTime()
    } catch {
      return NaN
    }
  }
  function valid(at: number): boolean {
    const stop = stopMs(at)
    return stop > Date.parse(entry.started_at) && stop <= at
  }
  const invalid = !valid(now)
  const start = new Date(entry.started_at)
  const startLabel = start.toLocaleString(locale === 'de' ? 'de-DE' : 'en-GB', {
    ...(!isSameLocalDay(start, new Date(now))
      ? ({ weekday: 'short', day: '2-digit', month: '2-digit' } as const)
      : {}),
    hour: '2-digit',
    minute: '2-digit'
  })
  function keep(): void {
    if (!timer.isLoading) timer.longRunAnswer(entry.id)
  }
  async function stop(): Promise<void> {
    // Recheck against the clock at the click, including an untouched default.
    const at = Date.now()
    if (!valid(at)) {
      setError(t('longRun.stopAtInvalid'))
      return
    }
    setError(null)
    const failure = await timer.longRunStopAt(entry.id, new Date(stopMs(at)).toISOString())
    if (failure) setError(failure)
  }
  return (
    <Dialog
      open
      title={t('longRun.title')}
      onClose={keep}
      initialFocusRef={keepRef}
      closeButton={false}
      closeOnBackdrop={false}
    >
      <p className="mb-6 text-sm text-[var(--ink2)]">
        {t('longRun.body', {
          client: timer.clients.find((client) => client.id === entry.client_id)?.name ?? '',
          start: startLabel,
          duration: formatDuration(Math.floor((now - start.getTime()) / 1000))
        })}
      </p>
      <div className="flex flex-col gap-2">
        <button
          ref={keepRef}
          type="button"
          className={KEY_INV}
          disabled={timer.isLoading}
          onClick={keep}
        >
          {t('idle.keep')}
        </button>
        <div className="grid grid-cols-2 gap-2">
          <label className={FIELD_LABEL}>
            {t('entry.date')}
            <input
              type="date"
              className={`${INPUT} w-full`}
              value={date}
              disabled={timer.isLoading}
              onChange={(e) => {
                setTouched(true)
                setDate(e.target.value)
                setError(null)
              }}
            />
          </label>
          <label className={FIELD_LABEL}>
            {t('entry.end')}
            <input
              type="time"
              className={`${INPUT} w-full`}
              value={time}
              disabled={timer.isLoading}
              onChange={(e) => {
                setTouched(true)
                setTime(e.target.value)
                setError(null)
              }}
            />
          </label>
        </div>
        {invalid && (
          <p role="status" className="text-xs text-[var(--danger)]">
            {t('longRun.stopAtInvalid')}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-[var(--danger)]">
            {error}
          </p>
        )}
        <button
          type="button"
          className={KEY}
          disabled={timer.isLoading || invalid}
          onClick={() => void stop()}
        >
          {t('longRun.stopAt')}
        </button>
        <button type="button" className={KEY} disabled={timer.isLoading} onClick={onEdit}>
          {t('common.edit')}
        </button>
      </div>
    </Dialog>
  )
}
