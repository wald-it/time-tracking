import { useEffect, useMemo, useRef, useState } from 'react'
import { useNow } from '../contexts/NowContext'
import type { Client, Entry, Project } from '../../../shared/types'
import { deserializeTags, entryHasTag } from '../../../shared/tags'
import { useEntriesStore } from '../store/entriesStore'
import { useProjectsStore } from '../store/projectsStore'
import { useToastStore } from '../store/toastStore'
import { ConfirmDialog } from './ConfirmDialog'
import { EntryEditForm } from './EntryEditForm'
import { useT } from '../contexts/I18nContext'
import type { TFunction } from '../contexts/I18nContext'
import * as Icons from './Icons'

interface Props {
  open: boolean
  /** ISO date YYYY-MM-DD (LOCAL) the drawer is showing entries for. */
  dateISO: string
  /** Entries for this day (caller filters from getByMonth). */
  entries: Entry[]
  clients: Client[]
  onClose: () => void
}

/**
 * Right-side drawer for a single day in CalendarView. Shows the
 * chronological list of entries with inline edit / delete and a
 * sticky-footer "+ Eintrag hinzufügen" button.
 *
 * Delete uses a `ConfirmDialog` (default-focus = Cancel) and on confirm
 * fires a soft-delete + 5s "Rückgängig" toast. The toast snapshot owns
 * the entry id so undo still works after the drawer closes (E9).
 */
export function CalendarDrawer({
  open,
  dateISO,
  entries,
  clients,
  onClose
}: Props): React.ReactElement | null {
  const showToast = useToastStore((s) => s.show)
  const t = useT()
  // Running entries are measured at render time; subscribing to the shared
  // clock re-renders this view every second while a timer runs.
  useNow()
  const projectsVersion = useProjectsStore((s) => s.version)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleteCandidate, setDeleteCandidate] = useState<Entry | null>(null)
  const [projectsById, setProjectsById] = useState<Map<number, Project>>(new Map())
  const drawerRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<Element | null>(null)

  useEffect(() => {
    if (!open) return
    previouslyFocused.current = document.activeElement
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (editingId !== null) setEditingId(null)
        else if (creating) setCreating(false)
        else if (deleteCandidate) setDeleteCandidate(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', handler)
    queueMicrotask(() => {
      drawerRef.current?.querySelector<HTMLElement>('button, [tabindex]')?.focus()
    })
    return () => {
      window.removeEventListener('keydown', handler)
      const prev = previouslyFocused.current
      if (prev instanceof HTMLElement) prev.focus()
    }
  }, [open, onClose, editingId, creating, deleteCandidate])

  const clientsById = useMemo(() => {
    const m = new Map<number, Client>()
    for (const c of clients) m.set(c.id, c)
    return m
  }, [clients])

  // Load all projects for name display in entry rows
  useEffect(() => {
    void window.api.projects.getAll({}).then((res) => {
      if (res.ok) {
        const map = new Map<number, Project>()
        for (const p of res.data) map.set(p.id, p)
        setProjectsById(map)
      }
    })
  }, [projectsVersion])

  // Collect all unique tags from today's entries for the filter pill bar.
  const allDayTags = useMemo(() => {
    const seen = new Set<string>()
    for (const e of entries) {
      for (const t of deserializeTags(e.tags)) seen.add(t)
    }
    return [...seen].sort()
  }, [entries])

  const filteredEntries = useMemo(
    () => (tagFilter ? entries.filter((e) => entryHasTag(e.tags, tagFilter)) : entries),
    [entries, tagFilter]
  )

  if (!open) return null

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

  const dateLabel = formatHumanDate(dateISO)
  const totalSeconds = filteredEntries.reduce((sum, e) => sum + durationSeconds(e), 0)

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-30 bg-[rgb(0_0_0/0.35)]"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Drawer */}
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('drawer.aria', { date: dateLabel })}
        className="fixed right-0 top-0 z-40 flex h-screen w-96 flex-col border-l"
        style={{ background: 'var(--nav-bg)', borderColor: 'var(--card-border)' }}
      >
        {/* Sticky header */}
        <div
          className="flex shrink-0 items-center justify-between border-b px-4 py-3"
          style={{ background: 'var(--nav-bg)', borderColor: 'var(--card-border)' }}
        >
          <div>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text)' }}>
              {t('drawer.header.title', { date: dateLabel })}
            </h2>
            {entries.length > 0 && (
              <p className="mt-0.5 text-xs" style={{ color: 'var(--text2)' }}>
                {filteredEntries.length !== entries.length
                  ? t('drawer.entries.filtered', {
                      count: String(filteredEntries.length),
                      total: String(entries.length)
                    })
                  : entries.length === 1
                    ? t('drawer.entries.one')
                    : t('drawer.entries.other', { count: String(entries.length) })}{' '}
                · {formatHHMM(totalSeconds)}
              </p>
            )}
            {allDayTags.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {allDayTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                    className={`rounded-[var(--r-key)] border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--focus)] ${
                      tagFilter === tag
                        ? 'border-[var(--ink)] bg-[var(--inv)] text-[var(--inv-ink)]'
                        : 'hover:border-[var(--ink)]'
                    }`}
                    style={
                      tagFilter !== tag
                        ? {
                            borderColor: 'var(--card-border)',
                            background: 'var(--card-bg)',
                            color: 'var(--text2)'
                          }
                        : {}
                    }
                    aria-pressed={tagFilter === tag}
                    title={
                      tagFilter === tag
                        ? t('drawer.filter.remove')
                        : t('drawer.filter.apply', { tag })
                    }
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="grid h-11 w-11 place-items-center rounded-[var(--r-key)] hover:bg-[var(--key)] focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
            style={{ color: 'var(--text2)' }}
          >
            ×
          </button>
        </div>

        {/* Scroll body */}
        <div className="flex-1 overflow-y-auto p-3">
          {filteredEntries.length === 0 && !creating && (
            <div className="mt-8 text-center text-sm" style={{ color: 'var(--text3)' }}>
              {tagFilter ? (
                <p>{t('drawer.empty.noEntriesWithTag', { tag: tagFilter })}</p>
              ) : (
                <p>{t('drawer.empty.noEntries')}</p>
              )}
            </div>
          )}
          <ul className="flex flex-col gap-2">
            {filteredEntries.map((e) => {
              const client = clientsById.get(e.client_id)
              const project = e.project_id != null ? projectsById.get(e.project_id) : undefined
              const isEditing = editingId === e.id
              const entryTags = deserializeTags(e.tags)
              return (
                <li
                  key={e.id}
                  className="rounded-[var(--r-key)] border"
                  style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
                >
                  {!isEditing && (
                    <div className="flex items-center gap-2 p-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-[var(--r-fine)]"
                        style={{ backgroundColor: project?.color || (client?.color ?? '#64748b') }}
                      />
                      <div className="min-w-0 flex-1">
                        <div
                          className="flex items-center gap-2 text-xs"
                          style={{ color: 'var(--text2)' }}
                        >
                          <span className="tabular-nums" style={{ fontFamily: 'var(--font-num)' }}>
                            {formatTimeRange(e)}
                          </span>
                          <span>·</span>
                          <span className="truncate" style={{ color: 'var(--text)' }}>
                            {client?.name ?? t('common.unknown')}
                            {project && (
                              <span style={{ color: 'var(--text3)' }}> · {project.name}</span>
                            )}
                          </span>
                        </div>
                        {e.description && (
                          <p
                            className="mt-0.5 truncate text-xs"
                            style={{ color: 'var(--text2)' }}
                            title={e.description}
                          >
                            {e.description}
                          </p>
                        )}
                        {entryTags.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {entryTags.map((tag) => (
                              <span
                                key={tag}
                                className="rounded-[var(--r-key)] px-1.5 py-px text-xs"
                                style={{ background: 'var(--accent-bg)', color: 'var(--text2)' }}
                              >
                                #{tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <span
                        className="text-xs tabular-nums"
                        style={{ color: 'var(--text)', fontFamily: 'var(--font-num)' }}
                      >
                        {formatHHMM(durationSeconds(e))}
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditingId(e.id)}
                        className="rounded p-1 hover:bg-[var(--key)] focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
                        style={{ color: 'var(--text2)' }}
                        aria-label={t('common.edit')}
                        title={t('common.edit')}
                      >
                        <Icons.Edit width={15} height={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteCandidate(e)}
                        disabled={e.stopped_at === null}
                        className="rounded p-1 hover:bg-[var(--key)] focus:outline-none focus:ring-2 focus:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-30"
                        style={{ color: 'var(--danger)' }}
                        aria-label={t('common.delete')}
                        title={
                          e.stopped_at === null ? t('common.stopRunningFirst') : t('common.delete')
                        }
                      >
                        <Icons.Trash width={15} height={15} />
                      </button>
                    </div>
                  )}
                  {isEditing && (
                    <div className="border-t p-3" style={{ borderColor: 'var(--card-border)' }}>
                      <EntryEditForm
                        entry={e}
                        clients={clients}
                        onSaved={() => {
                          setEditingId(null)
                          showToast(t('common.entrySaved'))
                        }}
                        onCancel={() => setEditingId(null)}
                      />
                    </div>
                  )}
                </li>
              )
            })}
            {creating && (
              <li
                className="rounded-[var(--r-key)] border p-3"
                style={{ background: 'var(--card-bg)', borderColor: 'var(--accent)' }}
              >
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
          </ul>
        </div>

        {/* Sticky footer */}
        {!creating && (
          <div
            className="shrink-0 border-t p-3"
            style={{ background: 'var(--nav-bg)', borderColor: 'var(--card-border)' }}
          >
            <button
              type="button"
              onClick={() => setCreating(true)}
              disabled={clients.length === 0}
              className="w-full flex items-center justify-center gap-2 rounded-[var(--r-key)] px-4 py-2 text-sm font-medium text-[var(--inv-ink)] hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
            >
              <Icons.Plus width={15} height={15} />
              {t('drawer.footer.addEntry', { date: dateLabel })}
            </button>
          </div>
        )}
      </aside>

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
    </>
  )
}

// --- helpers ---

function durationSeconds(entry: Entry): number {
  const stop = entry.stopped_at ? new Date(entry.stopped_at).getTime() : Date.now()
  return Math.floor((stop - new Date(entry.started_at).getTime()) / 1000)
}

function formatHHMM(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function formatTimeRange(e: Entry): string {
  const start = new Date(e.started_at)
  const startStr = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`
  if (!e.stopped_at) return `${startStr} – …`
  const stop = new Date(e.stopped_at)
  const stopStr = `${String(stop.getHours()).padStart(2, '0')}:${String(stop.getMinutes()).padStart(2, '0')}`
  return `${startStr} – ${stopStr}`
}

function formatHumanDate(dateISO: string): string {
  // dateISO is YYYY-MM-DD (LOCAL); show as DD.MM.YYYY
  const [y, m, d] = dateISO.split('-')
  return `${d}.${m}.${y}`
}

function defaultStartForDay(dateISO: string): Date {
  const [y, m, d] = dateISO.split('-').map((s) => parseInt(s, 10))
  // Default to 09:00 local on the chosen day for backfill convenience.
  return new Date(y, m - 1, d, 9, 0, 0, 0)
}

function buildDeleteMessage(entry: Entry, client: Client | undefined, t: TFunction): string {
  const dur = formatHHMM(durationSeconds(entry))
  const date = new Date(entry.started_at)
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const name = client?.name ?? t('common.unknown')
  return t('common.deleteEntryMessage', { client: name, date: dateStr, duration: dur })
}
