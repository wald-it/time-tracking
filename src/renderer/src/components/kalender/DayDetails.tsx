import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNow } from '../../contexts/NowContext'
import { useRounding } from '../../contexts/RoundingContext'
import { formatEur } from '../../../../shared/currency'
import { dayRevenueCent } from './dayRevenue'
import type { Client, Entry, Project } from '../../../../shared/types'
import { deserializeTags, entryHasTag } from '../../../../shared/tags'
import { useEntriesStore } from '../../store/entriesStore'
import { useToastStore } from '../../store/toastStore'
import { ConfirmDialog } from '../ConfirmDialog'
import { EntryEditForm } from '../EntryEditForm'
import { useLocale, useT } from '../../contexts/I18nContext'
import type { TFunction } from '../../contexts/I18nContext'

/**
 * Kalender — the selected day (HANDOFF §3.13). The content of the former
 * `CalendarDrawer`, without overlay or focus trap, so it can sit in the
 * persistent day panel (`DayPanel`, wide windows) and inside the overlay
 * drawer (`CalendarDrawer`, the fallback below 1120 px).
 *
 * Behaviour carried over from the drawer: chronological entry list, tag
 * filter, inline edit and backfill via `EntryEditForm`, delete via
 * `ConfirmDialog` (default focus = Cancel) with a soft delete and a 5 s
 * "Rückgängig" toast — the toast snapshot owns the entry id, so undo still
 * works after this view unmounts (E9). Escape first cancels what is open here
 * (edit, then backfill, then the delete question) and only then calls
 * `onEscape` (the drawer closes itself through it).
 *
 * Running entries are measured against the shared clock (`useNow()`), so they
 * tick with the rest of the window and need no own interval.
 */
export function DayDetails({
  dateISO,
  entries,
  clients,
  projects,
  onEscape,
  onBusyChange
}: {
  /** ISO date YYYY-MM-DD (LOCAL) of the day shown. */
  dateISO: string
  /** Entries for this day (caller filters from getByMonth). */
  entries: Entry[]
  clients: Client[]
  /**
   * All projects, from the caller; null while they are not loaded (then no
   * amount is shown). Not loaded here: a fresh load per selected day would
   * price the day at client rates until it arrives (goodwill included).
   */
  projects: Project[] | null
  /** Escape with nothing left to cancel here. The drawer passes `onClose`. */
  onEscape?: () => void
  /**
   * Whether an edit or backfill form is open. The calendar holds back the
   * panel/drawer switch while it is: the form keeps its field values itself,
   * so remounting it in the other container would drop the input.
   */
  onBusyChange?: (busy: boolean) => void
}): React.JSX.Element {
  const showToast = useToastStore((s) => s.show)
  const t = useT()
  const { locale } = useLocale()
  const nowMs = useNow()
  const { roundMinutes } = useRounding()
  const sectionRef = useRef<HTMLElement>(null)
  const headingId = useId()
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleteCandidate, setDeleteCandidate] = useState<Entry | null>(null)

  const busy = editingId !== null || creating
  const onBusyChangeRef = useRef(onBusyChange)
  useEffect(() => {
    onBusyChangeRef.current = onBusyChange
  })
  useEffect(() => {
    onBusyChangeRef.current?.(busy)
  }, [busy])
  // Unmounted (other day selected, drawer closed): nothing is open any more.
  useEffect(() => () => onBusyChangeRef.current?.(false), [])

  // A closed form takes the focused field with it. Inside the modal drawer that
  // would leave focus on <body>, outside the dialog; hand it back to what opened
  // the form (the entry's edit key, else the backfill key). Focus that already
  // moved elsewhere is left alone.
  const lastForm = useRef<{ editingId: number | null; creating: boolean }>({
    editingId: null,
    creating: false
  })
  useEffect(() => {
    const prev = lastForm.current
    lastForm.current = { editingId, creating }
    const closedEdit = prev.editingId !== null && editingId === null
    const closedBackfill = prev.creating && !creating
    if (!closedEdit && !closedBackfill) return
    const active = document.activeElement
    if (active && active !== document.body) return
    const section = sectionRef.current
    const target =
      (closedEdit
        ? section?.querySelector<HTMLElement>(`[data-edit-for="${prev.editingId}"]`)
        : null) ?? section?.querySelector<HTMLElement>('[data-add-entry]')
    target?.focus()
  }, [editingId, creating])

  // Latest values for the Escape handler, so the listener is registered once.
  const escapeState = useRef({ editingId, creating, deleteCandidate, onEscape })
  useEffect(() => {
    escapeState.current = { editingId, creating, deleteCandidate, onEscape }
  })

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const s = escapeState.current
      // Another dialog on top (e.g. "Termine übernehmen") owns Escape; it must
      // not also discard an edit here. The drawer around this section and the
      // own delete confirmation do not count.
      const section = sectionRef.current
      const foreignDialog = [
        ...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')
      ].some((d) => !section || !d.contains(section))
      if (foreignDialog && !s.deleteCandidate) return
      if (s.editingId !== null) setEditingId(null)
      else if (s.creating) setCreating(false)
      else if (s.deleteCandidate) setDeleteCandidate(null)
      else s.onEscape?.()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const clientsById = useMemo(() => {
    const m = new Map<number, Client>()
    for (const c of clients) m.set(c.id, c)
    return m
  }, [clients])

  const projectsById = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p])), [projects])

  // Collect all unique tags from the day's entries for the filter keys.
  const allDayTags = useMemo(() => {
    const seen = new Set<string>()
    for (const e of entries) {
      for (const tag of deserializeTags(e.tags)) seen.add(tag)
    }
    return [...seen].sort()
  }, [entries])

  const filteredEntries = useMemo(
    () => (tagFilter ? entries.filter((e) => entryHasTag(e.tags, tagFilter)) : entries),
    [entries, tagFilter]
  )

  const intlLocale = locale === 'en' ? 'en-GB' : 'de-DE'
  const day = parseLocalDate(dateISO)
  const dateTitle = new Intl.DateTimeFormat(intlLocale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  }).format(day)
  const shortDate = new Intl.DateTimeFormat(intlLocale, {
    day: '2-digit',
    month: '2-digit'
  }).format(day)

  async function confirmDelete(entry: Entry): Promise<void> {
    setDeleteCandidate(null)
    const res = await window.api.entries.delete(entry.id)
    if (!res.ok) {
      showToast(t('common.entryDeleteFailed', { error: res.error }))
      // A refused delete means the row is no longer live (a confirm that
      // fired twice, for example): reload so the list shows what is stored.
      useEntriesStore.getState().bumpVersion()
      return
    }
    useEntriesStore.getState().bumpVersion()
    showToast(t('common.entryDeleted'), {
      label: t('common.undo'),
      type: 'undo_delete',
      data: { entryId: entry.id }
    })
  }

  const totalSeconds = filteredEntries.reduce((sum, e) => sum + durationSeconds(e, nowMs), 0)
  // Same entries as the hours beside it: under a tag filter both show the
  // filtered part of the day, never hours of one set next to euros of another.
  const revenueCent = projects
    ? dayRevenueCent(filteredEntries, clients, projects, roundMinutes, nowMs)
    : 0

  return (
    <section
      ref={sectionRef}
      aria-labelledby={headingId}
      className="border-t-2 border-[var(--ink)] pt-[14px]"
    >
      <h2 id={headingId} className="m-0 text-[var(--ink2)]" style={LEGEND}>
        {t('calendar.panel.legend')}
      </h2>
      <div className="mt-[6px] flex items-baseline justify-between gap-3">
        <span
          className="text-[18px] font-semibold text-[var(--ink)]"
          style={{ fontStretch: '106%' }}
        >
          {dateTitle}
        </span>
        <span className="flex flex-col items-end">
          <span className="font-num text-[24px] font-light text-[var(--ink)]">
            {formatHMM(totalSeconds)}
          </span>
          {/* The day's amount, visible here because narrow calendar cells hide it. */}
          {revenueCent > 0 && (
            <span data-testid="details-revenue" className="font-num text-[12px] text-[var(--ink3)]">
              {formatEur(revenueCent)}
            </span>
          )}
        </span>
      </div>

      {entries.length > 0 && (
        <p className="m-0 mt-1 text-[12px] text-[var(--ink3)]">
          {filteredEntries.length !== entries.length
            ? t('drawer.entries.filtered', {
                filtered: String(filteredEntries.length),
                total: String(entries.length)
              })
            : entries.length === 1
              ? t('drawer.entries.one')
              : t('drawer.entries.other', { count: String(entries.length) })}
        </p>
      )}

      {allDayTags.length > 0 && (
        <div className="mt-[10px] flex flex-wrap gap-1">
          {allDayTags.map((tag) => {
            const active = tagFilter === tag
            return (
              <button
                key={tag}
                type="button"
                onClick={() => setTagFilter(active ? null : tag)}
                className={`min-h-[44px] rounded-[var(--r-key)] border px-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] ${
                  active
                    ? 'border-[var(--ink)] bg-[var(--inv)] text-[var(--inv-ink)]'
                    : 'border-[var(--line)] text-[var(--ink2)] hover:bg-[var(--key)] hover:text-[var(--ink)]'
                }`}
                style={{ ...LEGEND, fontSize: 10 }}
                aria-pressed={active}
                title={active ? t('drawer.filter.remove') : t('drawer.filter.apply', { tag })}
              >
                #{tag}
              </button>
            )
          })}
        </div>
      )}

      {filteredEntries.length === 0 && !creating && (
        <p className="m-0 mt-[14px] border-t border-[var(--line)] py-[14px] text-[13px] text-[var(--ink3)]">
          {tagFilter
            ? t('drawer.empty.noEntriesWithTag', { tag: tagFilter })
            : t('drawer.empty.noEntries')}
        </p>
      )}

      {(filteredEntries.length > 0 || creating) && (
        <ol className="m-0 mt-[14px] list-none p-0">
          {filteredEntries.map((e) => {
            const client = clientsById.get(e.client_id)
            const project = e.project_id != null ? projectsById.get(e.project_id) : undefined
            const running = e.stopped_at === null
            const secs = durationSeconds(e, nowMs)
            const entryTags = deserializeTags(e.tags)
            if (editingId === e.id) {
              return (
                <li key={e.id} className="border-t border-[var(--line)] py-[10px]">
                  <EntryEditForm
                    entry={e}
                    clients={clients}
                    onSaved={() => {
                      setEditingId(null)
                      showToast(t('common.entrySaved'))
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                </li>
              )
            }
            return (
              <li key={e.id} className="flex gap-2 border-t border-[var(--line)] py-[10px]">
                <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <div className="flex justify-between gap-[10px]">
                    <span className="font-num text-[12px] text-[var(--ink2)]">
                      {formatTimeRange(e)}
                    </span>
                    <span
                      className="font-num text-[13px] text-[var(--ink)]"
                      style={{ fontWeight: running ? 600 : 400 }}
                    >
                      {running ? formatHMMSS(secs) : formatHMM(secs)}
                    </span>
                  </div>
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-[8px] w-[8px] flex-none"
                      style={{ background: project?.color || client?.color || 'var(--tick)' }}
                    />
                    <span className="min-w-0 truncate text-[13px]">
                      <span className="font-semibold text-[var(--ink)]">
                        {client?.name ?? t('common.unknown')}
                      </span>
                      {project && (
                        <span className="text-[12px] text-[var(--ink2)]"> · {project.name}</span>
                      )}
                    </span>
                  </div>
                  {e.description && (
                    <p
                      className="m-0 line-clamp-2 text-[13px] text-[var(--ink)] [overflow-wrap:anywhere]"
                      title={e.description}
                    >
                      {e.description}
                    </p>
                  )}
                  {entryTags.length > 0 && (
                    <div className="mt-[2px] flex flex-wrap gap-1">
                      {entryTags.map((tag) => (
                        <span
                          key={tag}
                          className="border border-[var(--line)] text-[var(--ink2)]"
                          style={{ ...LEGEND, fontSize: 10, padding: '2px 6px' }}
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-none items-start">
                  <button
                    type="button"
                    onClick={() => setEditingId(e.id)}
                    data-edit-for={e.id}
                    className={ICON_BUTTON}
                    aria-label={t('common.edit')}
                    title={t('common.edit')}
                  >
                    <PencilGlyph />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteCandidate(e)}
                    disabled={running}
                    className={`${ICON_BUTTON} disabled:cursor-not-allowed disabled:opacity-30`}
                    aria-label={t('common.delete')}
                    title={running ? t('common.stopRunningFirst') : t('common.delete')}
                  >
                    <TrashGlyph />
                  </button>
                </div>
              </li>
            )
          })}
          {creating && (
            <li className="border-t-2 border-[var(--ink)] py-[10px]">
              <EntryEditForm
                clients={clients}
                defaultDate={defaultStartForDay(dateISO)}
                onSaved={() => {
                  setCreating(false)
                  showToast(t('common.entrySaved'))
                }}
                onCancel={() => setCreating(false)}
              />
            </li>
          )}
        </ol>
      )}

      {!creating && (
        <button
          type="button"
          onClick={() => setCreating(true)}
          data-add-entry
          disabled={clients.length === 0}
          className="key-hover mt-[6px] flex min-h-[44px] w-full items-center justify-center gap-2 rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] px-4 text-[13px] font-semibold text-[var(--ink)] shadow-[inset_0_-2px_0_var(--key-edge)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PlusGlyph />
          {t('calendar.panel.addFor', { date: shortDate })}
        </button>
      )}

      <ConfirmDialog
        open={deleteCandidate !== null}
        title={t('common.deleteEntryTitle')}
        message={
          deleteCandidate
            ? buildDeleteMessage(
                deleteCandidate,
                clientsById.get(deleteCandidate.client_id),
                nowMs,
                t
              )
            : ''
        }
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        variant="danger"
        onConfirm={() => deleteCandidate && void confirmDelete(deleteCandidate)}
        onCancel={() => setDeleteCandidate(null)}
      />
    </section>
  )
}

// --- styles ---

/** Legend style (HANDOFF §2.2): Archivo 11/600, caps, .14em, expanded. */
const LEGEND: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  fontStretch: '118%'
}

const ICON_BUTTON =
  'flex h-[44px] w-[44px] items-center justify-center rounded-[var(--r-key)] text-[var(--ink3)] hover:bg-[var(--key)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]'

// --- glyphs (markup from design/messinstrument/reference.html) ---

function PlusGlyph(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

function PencilGlyph(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10.5 2.5l3 3L5 14H2v-3z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function TrashGlyph(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// --- helpers ---

function durationSeconds(entry: Entry, nowMs: number): number {
  const stop = entry.stopped_at ? new Date(entry.stopped_at).getTime() : nowMs
  return Math.max(0, Math.floor((stop - new Date(entry.started_at).getTime()) / 1000))
}

/** `H:MM` — completed durations and totals (HANDOFF §2.2). */
function formatHMM(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}`
}

/** `H:MM:SS` — the running duration. */
function formatHMMSS(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${formatHMM(total)}:${String(total % 60).padStart(2, '0')}`
}

function clockTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "07:45–09:15", running "14:05–" (as in the Heute table). */
function formatTimeRange(e: Entry): string {
  const start = clockTime(e.started_at)
  return e.stopped_at ? `${start}–${clockTime(e.stopped_at)}` : `${start}–`
}

function parseLocalDate(dateISO: string): Date {
  const [y, m, d] = dateISO.split('-').map((s) => parseInt(s, 10))
  return new Date(y, m - 1, d)
}

function defaultStartForDay(dateISO: string): Date {
  const [y, m, d] = dateISO.split('-').map((s) => parseInt(s, 10))
  // Default to 09:00 local on the chosen day for backfill convenience.
  return new Date(y, m - 1, d, 9, 0, 0, 0)
}

function buildDeleteMessage(
  entry: Entry,
  client: Client | undefined,
  nowMs: number,
  t: TFunction
): string {
  const dur = formatHHMM(durationSeconds(entry, nowMs))
  const date = new Date(entry.started_at)
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const name = client?.name ?? t('common.unknown')
  // One half of an entry across midnight: the delete takes both days (#323).
  const key = (entry.segment_count ?? 1) > 1 ? 'common.deleteEntryMessageLinked' : 'common.deleteEntryMessage'
  return t(key, { client: name, date: dateStr, duration: dur })
}

/** `HH:MM` for the delete question. */
function formatHHMM(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
