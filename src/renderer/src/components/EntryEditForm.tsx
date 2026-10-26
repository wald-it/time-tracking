import { useEffect, useId, useMemo, useState } from 'react'
import type { Client, Entry, Project } from '../../../shared/types'
import {
  endsAtNextMidnight,
  formatTimeHHMM,
  parseStopToDate,
  parseTimeToDate
} from '../../../shared/date'
import { useEntriesStore } from '../store/entriesStore'
import { useUiPrefsStore } from '../store/uiPrefsStore'
import { useT } from '../contexts/I18nContext'
import { TagInput } from './TagInput'
import { Toggle } from './Toggle'
import { FIELD_LABEL, INPUT, KEY, KEY_INV, TEXTAREA } from './instrumentClasses'

interface Props {
  /** Existing entry to edit; omit for create-mode. */
  entry?: Entry
  /** Default date used in create-mode when no entry is supplied. */
  defaultDate?: Date
  clients: Client[]
  onSaved: (entry: Entry) => void
  onCancel: () => void
}

type FormState = 'idle' | 'saving' | 'success'

const MAX_DESCRIPTION_LEN = 500
const MAX_REFERENCE_LEN = 200
const MAX_NOTE_LEN = 1000

function toDateInputValue(d: Date): string {
  // <input type="date"> wants YYYY-MM-DD in LOCAL time.
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Inline edit/create form used both inside the Calendar Drawer and inside
 * the Today "+ Eintrag nachtragen" dialog. Validation runs client-side
 * for fast feedback; the server enforces the same rules authoritatively
 * (see `validateManualEntry` in src/main/ipc.ts).
 *
 * v1.3 PR B: cross-midnight entries are now allowed — the IPC auto-splits
 * them into linked halves at local midnight. The previous "folgt in v1.3"
 * banner has been removed.
 */
export function EntryEditForm({
  entry,
  defaultDate,
  clients,
  onSaved,
  onCancel
}: Props): React.ReactElement {
  const t = useT()
  const billableLabelId = useId()
  const showProjectNumber = useUiPrefsStore((s) => s.showProjectNumber)
  const initialStart = entry ? new Date(entry.started_at) : (defaultDate ?? new Date())
  const initialStop = entry?.stopped_at
    ? new Date(entry.stopped_at)
    : new Date(initialStart.getTime() + 60 * 60 * 1000)

  // #334: the first half of an entry across midnight (or a whole day) ends at
  // the next midnight, which the form shows as 00:00 (01:00 where the clock
  // jumps over 00:00).
  // Fixed at mount, like the other initial values below.
  const [untilMidnight] = useState(() =>
    entry?.stopped_at ? endsAtNextMidnight(entry.started_at, entry.stopped_at) : false
  )
  const [date, setDate] = useState(toDateInputValue(initialStart))
  const [startTime, setStartTime] = useState(formatTimeHHMM(initialStart))
  const [stopTime, setStopTime] = useState(formatTimeHHMM(initialStop))
  const [clientId, setClientId] = useState<number>(entry?.client_id ?? clients[0]?.id ?? 0)
  const [projectId, setProjectId] = useState<number | null>(entry?.project_id ?? null)
  const [projects, setProjects] = useState<Project[]>([])
  const [description, setDescription] = useState(entry?.description ?? '')
  const [tags, setTags] = useState(entry?.tags ?? '')
  const [reference, setReference] = useState(entry?.reference ?? '')
  const [billable, setBillable] = useState(entry?.billable ?? 1)

  // Load projects when client changes; reset project if client changes
  useEffect(() => {
    if (!clientId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- #142: dauerhaft — Teilfix möglich, der asynchrone Zweig bleibt Effect
      setProjects([])
      setProjectId(null)
      return
    }
    void window.api.projects.getAll({ clientId }).then((res) => {
      if (res.ok) {
        setProjects(res.data.filter((p) => p.active === 1 || p.id === entry?.project_id))
      }
    })
    // Only re-run when clientId changes (not on initial mount with existing project_id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId])
  const [privateNote, setPrivateNote] = useState(entry?.private_note ?? '')
  const [state, setState] = useState<FormState>('idle')
  const [error, setError] = useState<string | null>(null)
  const bumpVersion = useEntriesStore((s) => s.bumpVersion)

  // Local validation (200ms debounce so it doesn't flicker while typing).
  const [localError, setLocalError] = useState<string | null>(null)
  useEffect(() => {
    const t = setTimeout(() => setLocalError(validateLocal()), 200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, startTime, stopTime, clientId, description])

  function validateLocal(): string | null {
    if (!clientId) return t('entry.validation.clientRequired')
    let start: Date
    let stop: Date
    try {
      start = parseTimeToDate(date, startTime)
      stop = parseStopToDate(date, stopTime, untilMidnight)
    } catch (e) {
      return (e as Error).message
    }
    if (stop.getTime() <= start.getTime()) return t('entry.validation.endAfterStart')
    if (start.getTime() > Date.now()) return t('entry.validation.startNotFuture')
    if (description.length > MAX_DESCRIPTION_LEN) {
      return t('entry.validation.descriptionTooLong', { max: String(MAX_DESCRIPTION_LEN) })
    }
    return null
  }

  const activeClients = useMemo(
    () => clients.filter((c) => c.active === 1 || c.id === clientId),
    [clients, clientId]
  )

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const err = validateLocal()
    if (err) {
      setLocalError(err)
      return
    }
    setState('saving')
    setError(null)
    const start = parseTimeToDate(date, startTime).toISOString()
    const stop = parseStopToDate(date, stopTime, untilMidnight).toISOString()
    const res = entry
      ? await window.api.entries.update({
          id: entry.id,
          client_id: clientId,
          // A patch (2.0): a field left out keeps its value, so "no project"
          // goes as null, never as undefined.
          project_id: projectId,
          description: description.trim(),
          started_at: start,
          stopped_at: stop,
          tags,
          reference: reference.trim(),
          billable,
          private_note: privateNote.trim(),
          // The form shows minutes: a time sent back as displayed is no
          // change and keeps the entry's seconds (#335 case 4). The segment
          // tells the write which half of a midnight-split entry the times
          // belong to (#311).
          from_form: true,
          segment_seq: entry.segment_seq,
          expected_version: entry.version_no
        })
      : await window.api.entries.create({
          client_id: clientId,
          project_id: projectId,
          description: description.trim(),
          started_at: start,
          stopped_at: stop,
          tags,
          reference: reference.trim(),
          billable,
          private_note: privateNote.trim()
        })
    if (!res.ok) {
      setState('idle')
      setError(res.error)
      return
    }
    setState('success')
    bumpVersion()
    // Brief success flash before handing control back to the parent.
    setTimeout(() => onSaved(res.data), 300)
  }

  const isSaving = state === 'saving'
  const visibleError = error ?? localError

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 text-sm">
      {/* Date on a row of its own: in the day panel a third of the width is
          too narrow for a mono date or time plus the picker icon. */}
      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2 flex flex-col gap-1">
          <span className={FIELD_LABEL}>{t('entry.date')}</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={`${INPUT} font-num min-w-0`}
            disabled={isSaving}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>{t('entry.start')}</span>
          <input
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className={`${INPUT} font-num min-w-0`}
            disabled={isSaving}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>{t('entry.end')}</span>
          <input
            type="time"
            value={stopTime}
            onChange={(e) => setStopTime(e.target.value)}
            className={`${INPUT} font-num min-w-0`}
            disabled={isSaving || (entry?.stopped_at == null && entry !== undefined)}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>{t('entry.client')}</span>
        <select
          value={clientId}
          onChange={(e) => setClientId(parseInt(e.target.value, 10))}
          className={INPUT}
          disabled={isSaving}
        >
          {activeClients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {/* Project picker — only shown when there are active projects for the client */}
      {projects.length > 0 && (
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>{t('entry.project')}</span>
          <select
            value={projectId ?? ''}
            onChange={(e) => setProjectId(e.target.value ? parseInt(e.target.value, 10) : null)}
            className={INPUT}
            disabled={isSaving}
          >
            <option value="">{t('entry.project.placeholder')}</option>
            {projects.map((p) => {
              const label =
                showProjectNumber && p.external_project_number
                  ? `${p.name} [${p.external_project_number}]`
                  : p.name
              return (
                <option key={p.id} value={p.id}>
                  {label}
                </option>
              )
            })}
          </select>
        </label>
      )}

      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>
          {t('entry.description')}{' '}
          <span className="font-num" style={{ color: 'var(--ink3)' }}>
            ({description.length}/{MAX_DESCRIPTION_LEN})
          </span>
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={MAX_DESCRIPTION_LEN}
          className={TEXTAREA}
          disabled={isSaving}
        />
      </label>

      <div className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>{t('entry.tags')}</span>
        <TagInput value={tags} onChange={(serialized) => setTags(serialized)} disabled={isSaving} />
        <span className="text-xs" style={{ color: 'var(--ink3)' }}>
          {t('entry.tagsHint')}
        </span>
      </div>

      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>{t('entry.reference.label')}</span>
        <input
          type="text"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          maxLength={MAX_REFERENCE_LEN}
          placeholder={t('entry.reference.placeholder')}
          className={INPUT}
          disabled={isSaving}
        />
        <span className="text-xs" style={{ color: 'var(--ink3)' }}>
          {t('entry.reference.hint')}
        </span>
      </label>

      <div className="flex items-center justify-between">
        <span id={billableLabelId} className={FIELD_LABEL}>
          {t('entry.billable.label')}
        </span>
        <div className="flex items-center gap-2">
          {billable === 0 && (
            <span className="text-xs" style={{ color: 'var(--ink)' }}>
              {t('entry.billable.hint')}
            </span>
          )}
          <Toggle
            checked={billable === 1}
            onChange={(v) => setBillable(v ? 1 : 0)}
            disabled={isSaving}
            labelledBy={billableLabelId}
          />
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL}>{t('entry.privateNote.label')}</span>
        <textarea
          value={privateNote}
          onChange={(e) => setPrivateNote(e.target.value)}
          rows={2}
          maxLength={MAX_NOTE_LEN}
          placeholder={t('entry.privateNote.placeholder')}
          className={TEXTAREA}
          disabled={isSaving}
        />
        <span className="text-xs" style={{ color: 'var(--ink3)' }}>
          {t('entry.privateNote.hint')}
        </span>
      </label>

      {visibleError && (
        <p role="alert" className="text-xs" style={{ color: 'var(--danger)' }}>
          {visibleError}
        </p>
      )}
      {state === 'success' && (
        <p role="status" className="text-xs" style={{ color: 'var(--ink2)' }}>
          {t('entry.saved')}
        </p>
      )}

      <div
        className="sticky bottom-0 -mx-1 mt-1 flex justify-end gap-2 border-t px-1 pt-2 pb-1"
        style={{ background: 'var(--bg)', borderColor: 'var(--line)' }}
      >
        <button type="button" onClick={onCancel} disabled={isSaving} className={KEY}>
          {t('common.cancel')}
        </button>
        <button type="submit" disabled={isSaving || localError !== null} className={KEY_INV}>
          {isSaving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </form>
  )
}
