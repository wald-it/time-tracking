import { useEffect, useMemo, useState } from 'react'
import { getISOWeek } from 'date-fns'
import type { Client, DashboardSummary, Entry, Project } from '../../../shared/types'
import { useEntriesStore } from '../store/entriesStore'
import { useProjectsStore } from '../store/projectsStore'
import { useUiPrefsStore } from '../store/uiPrefsStore'
import { useToastStore } from '../store/toastStore'
import { useSettingsStore } from '../store/settingsStore'
import { useTimer } from '../hooks/useTimer'
import { useWeekStart } from '../hooks/useWeekStart'
import { Dialog } from '../components/Dialog'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { EntryEditForm } from '../components/EntryEditForm'
import { StartTimerModal } from '../components/StartTimerModal'
import { TimerDisplay } from '../components/heute/TimerDisplay'
import { BigKey } from '../components/heute/BigKey'
import { SummaryColumn } from '../components/heute/SummaryColumn'
import { DayScale } from '../components/heute/DayScale'
import { EntryTable } from '../components/heute/EntryTable'
import { QuickStart } from '../components/heute/QuickStart'
import type { TFunction } from '../contexts/I18nContext'
import { useT } from '../contexts/I18nContext'
import { useRounding } from '../contexts/RoundingContext'
import { useNow } from '../contexts/NowContext'
import { billedMinutes } from '../../../shared/currency'

/**
 * `Heute` — the Messinstrument layout (HANDOFF §4.1):
 *   1. Hero row: display · STOPP/START key · Summen column (today, week,
 *      WeekMeter).
 *   2. Tagesverlauf: the day as a scale with every entry at its clock time.
 *   3. Lower row: entry table · quick start.
 *
 * Data: `dashboard:summary`, re-fetched on mount, on `entriesStore.version`
 * and when the running entry starts/stops. Totals tick live from the shared
 * clock (`useNow`) between fetches — no polling, no second interval.
 */
export default function TodayView(): React.JSX.Element {
  const t = useT()
  const { roundMinutes } = useRounding()
  const { runningEntry, clients, startWithClient, stop } = useTimer()
  const version = useEntriesStore((s) => s.version)
  const projectsVersion = useProjectsStore((s) => s.version)
  const showProjectNumber = useUiPrefsStore((s) => s.showProjectNumber)
  const hotkey = useSettingsStore((s) => s.settings?.hotkey_toggle) ?? 'Alt+Shift+S'
  const weekStart = useWeekStart()
  const showToast = useToastStore((s) => s.show)
  const nowMs = useNow()

  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [fetchedAt, setFetchedAt] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [projectsById, setProjectsById] = useState<Map<number, Project>>(new Map())

  // Edit / create / delete / start dialog state
  const [createOpen, setCreateOpen] = useState(false)
  const [editEntry, setEditEntry] = useState<Entry | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<Entry | null>(null)
  const [startOpen, setStartOpen] = useState(false)

  // The local date; a change re-fetches, so a view left open across midnight
  // does not show yesterday's entries under today's date.
  const dayKey = new Date(nowMs).toDateString()

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      setStatus((s) => (s === 'ready' ? s : 'loading'))
      const res = await window.api.dashboard.summary()
      if (cancelled) return
      if (res.ok) {
        setSummary(res.data)
        setFetchedAt(Date.now())
        setStatus('ready')
        setErrorMsg(null)
      } else {
        setStatus('error')
        setErrorMsg(res.error)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [version, runningEntry?.id, dayKey])

  const clientsById = useMemo(() => {
    const map = new Map<number, Client>()
    for (const c of clients) map.set(c.id, c)
    return map
  }, [clients])

  // Load all projects for name lookup — re-fetch when projects are added/edited
  useEffect(() => {
    void window.api.projects.getAll({}).then((res) => {
      if (res.ok) {
        const map = new Map<number, Project>()
        for (const p of res.data) map.set(p.id, p)
        setProjectsById(map)
      }
    })
  }, [projectsVersion])

  // Seconds the running entry has added since the summary was read. The
  // fetched totals already include it up to `fetchedAt`.
  // Only once the summary already contains the running entry: right after a
  // start (or stop) the old summary is still on screen for a moment.
  const liveDelta =
    runningEntry && summary && summary.todayEntries.some((e) => e.id === runningEntry.id)
      ? Math.max(0, Math.floor((nowMs - fetchedAt) / 1000))
      : 0

  const todayIndex = weekdayIndex(new Date(nowMs), weekStart)
  const weekDaySeconds = useMemo(() => {
    if (!summary) return [0, 0, 0, 0, 0, 0, 0]
    return summary.weekDaySeconds.map((s, i) => (i === todayIndex ? s + liveDelta : s))
  }, [summary, todayIndex, liveDelta])

  // Today as the invoice bills it: each entry rounded up to the step.
  const todayRoundedSeconds = useMemo(() => {
    if (!summary || roundMinutes <= 0) return undefined
    return summary.todayEntries.reduce((sum, e) => {
      const stop = e.stopped_at ? Date.parse(e.stopped_at) : nowMs
      return sum + billedMinutes(Math.max(0, stop - Date.parse(e.started_at)), roundMinutes) * 60
    }, 0)
  }, [summary, roundMinutes, nowMs])

  // Only an active client can be started; the modal lists active ones only.
  const lastEntry = summary?.recentEntries[0]
  const lastUsed =
    lastEntry && clientsById.get(lastEntry.client_id)?.active === 1
      ? { clientId: lastEntry.client_id, projectId: lastEntry.project_id ?? null }
      : null

  const runningClient = runningEntry ? clientsById.get(runningEntry.client_id) : undefined
  const runningProject =
    runningEntry?.project_id != null ? projectsById.get(runningEntry.project_id) : undefined

  async function confirmDelete(entry: Entry): Promise<void> {
    setDeleteCandidate(null)
    const res = await window.api.entries.delete(entry.id)
    if (!res.ok) {
      showToast(t('common.entryDeleteFailed', { error: res.error }))
      return
    }
    useEntriesStore.getState().bumpVersion()
    showToast(t('common.entryDeleted'), {
      label: t('common.undo'),
      type: 'undo_delete',
      data: { entryId: entry.id }
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-12 px-4 pb-10 pt-3">
      {/* 1 — Hero row */}
      <div className="flex flex-wrap items-stretch gap-6">
        <div className="flex min-w-0 flex-[999_1_520px]">
          <TimerDisplay
            runningEntry={runningEntry}
            client={runningClient}
            project={runningProject}
            nowMs={nowMs}
            roundMinutes={roundMinutes}
            hotkey={hotkey}
          />
        </div>
        <div className="flex flex-[0_0_148px]">
          <BigKey
            running={runningEntry !== null}
            hotkey={hotkey}
            onStart={() => setStartOpen(true)}
            onStop={() => void stop()}
          />
        </div>
        {status === 'ready' && summary ? (
          <SummaryColumn
            todaySeconds={summary.todaySeconds + liveDelta}
            weekSeconds={summary.weekSeconds + liveDelta}
            weekDaySeconds={weekDaySeconds}
            weekNumber={getISOWeek(new Date(nowMs))}
            todayIndex={todayIndex}
            roundMinutes={roundMinutes}
            todayRoundedSeconds={todayRoundedSeconds}
          />
        ) : (
          <div className="flex-[1_1_260px] border-t-2 border-[var(--ink)]" />
        )}
      </div>

      {status === 'loading' && <SummarySkeleton />}
      {status === 'error' && (
        <div className="rounded-[var(--r-key)] border border-[var(--danger)] bg-[var(--danger-bg)] p-4 text-sm text-[var(--danger)]">
          <p className="mb-2 font-medium">{t('today.error.title')}</p>
          {errorMsg && <p className="mb-2 text-xs text-[var(--danger)]">{errorMsg}</p>}
          <button
            type="button"
            className="key-hover min-h-[44px] rounded-[var(--r-key)] bg-[var(--danger)] px-3 text-xs text-[var(--bg)]"
            onClick={() => useEntriesStore.getState().bumpVersion()}
          >
            {t('common.retry')}
          </button>
        </div>
      )}
      {status === 'ready' && summary && (
        <>
          {/* 2 — Tagesverlauf */}
          <DayScale
            entries={summary.todayEntries}
            clientsById={clientsById}
            projectsById={projectsById}
            nowMs={nowMs}
            onSelect={(e) => setEditEntry(e)}
          />

          {/* 3 — Lower row */}
          <div className="flex flex-wrap items-start gap-10">
            <EntryTable
              entries={summary.todayEntries}
              clientsById={clientsById}
              projectsById={projectsById}
              nowMs={nowMs}
              roundMinutes={roundMinutes}
              showProjectNumber={showProjectNumber}
              onEdit={(e) => setEditEntry(e)}
              onDelete={(e) => setDeleteCandidate(e)}
              onAdd={() => setCreateOpen(true)}
            />
            <QuickStart
              topClients={summary.topClients30d}
              running={runningEntry !== null}
              clientsById={clientsById}
              projectsById={projectsById}
              onStart={(id, projectId) => void startWithClient(id, projectId)}
            />
          </div>
        </>
      )}

      {/* B6: START offers the last used client + project, so Enter starts it. */}
      <StartTimerModal open={startOpen} onClose={() => setStartOpen(false)} prefill={lastUsed} />

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('today.dialog.add')}
        widthClass="w-[520px]"
      >
        <EntryEditForm
          clients={clients}
          defaultDate={defaultBackfillStart()}
          onSaved={() => {
            setCreateOpen(false)
            showToast(t('common.entrySaved'))
          }}
          onCancel={() => setCreateOpen(false)}
        />
      </Dialog>

      <Dialog
        open={editEntry !== null}
        onClose={() => setEditEntry(null)}
        title={t('today.dialog.edit')}
        widthClass="w-[520px]"
      >
        {editEntry && (
          <EntryEditForm
            entry={editEntry}
            clients={clients}
            onSaved={() => {
              setEditEntry(null)
              showToast(t('common.entrySaved'))
            }}
            onCancel={() => setEditEntry(null)}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={deleteCandidate !== null}
        title={t('common.deleteEntryTitle')}
        message={
          deleteCandidate
            ? buildDeleteMessage(deleteCandidate, clientsById.get(deleteCandidate.client_id), t)
            : ''
        }
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        variant="danger"
        onConfirm={() => deleteCandidate && void confirmDelete(deleteCandidate)}
        onCancel={() => setDeleteCandidate(null)}
      />
    </div>
  )
}

/** Loading state as hairline blocks (HANDOFF §4.1). */
function SummarySkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 border-t-2 border-[var(--ink)] pt-3.5" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-10 border-b border-[var(--line)]" />
      ))}
    </div>
  )
}

// --- helpers ---

/** Position of `date` in a week that starts on `weekStart` (0–6). */
function weekdayIndex(date: Date, weekStart: 'monday' | 'sunday'): number {
  const day = date.getDay() // 0 = Sunday
  return weekStart === 'sunday' ? day : (day + 6) % 7
}

function durationSeconds(entry: Entry): number {
  const stop = entry.stopped_at ? new Date(entry.stopped_at).getTime() : Date.now()
  return Math.floor((stop - new Date(entry.started_at).getTime()) / 1000)
}

/** Format seconds as HH:MM (no seconds). */
function formatHHMM(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Default `defaultDate` for "+ Eintrag nachtragen": one hour ago. */
function defaultBackfillStart(): Date {
  return new Date(Date.now() - 60 * 60 * 1000)
}

function buildDeleteMessage(entry: Entry, client: Client | undefined, t: TFunction): string {
  const dur = formatHHMM(durationSeconds(entry))
  const date = new Date(entry.started_at)
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const name = client?.name ?? t('common.unknown')
  return t('common.deleteEntryMessage', { client: name, date: dateStr, duration: dur })
}
