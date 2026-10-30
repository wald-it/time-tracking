import { useId } from 'react'
import type { Client, Entry, Project } from '../../../../shared/types'
import { entryRowKey } from '../../../../shared/entryKey'
import { entryBilledMinutes } from '../../../../shared/entryMoney'
import { deserializeTags } from '../../../../shared/tags'
import { useT } from '../../contexts/I18nContext'
import { BilledChip } from '../BilledChip'
import { EntryOrigin } from '../EntryOrigin'
import { resumeTarget } from './resumeTarget'

/**
 * Heute — "Einträge heute" (HANDOFF §3.10, §4.1).
 *
 * A real `<table>` inside an `overflow-x: auto` box (min-width 640 px), newest
 * first (the caller passes `todayEntries` already sorted). The running row
 * shows a live `H:MM:SS` from the shared clock (`nowMs`), so no own interval;
 * it has no delete button (a running entry cannot be deleted), only a spacer
 * that keeps the action column aligned.
 */
export function EntryTable({
  entries,
  clientsById,
  projectsById,
  nowMs,
  showProjectNumber,
  onEdit,
  onDelete,
  onAdd,
  onResume
}: {
  entries: Entry[]
  clientsById: Map<number, Client>
  projectsById: Map<number, Project>
  nowMs: number
  showProjectNumber: boolean
  onEdit: (e: Entry) => void
  onDelete: (e: Entry) => void
  onAdd: () => void
  /** Q8: "Fortsetzen" — start this entry's client, project and description. */
  onResume?: (e: Entry) => void
}): React.JSX.Element {
  const t = useT()
  const headingId = useId()
  // Same guard as the old "+ Eintrag nachtragen" button: without any client
  // there is nothing to book against. `clientsById` is built from the same
  // `clients` list the old check used.
  const addDisabled = clientsById.size === 0

  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 border-t-2 border-[var(--ink)] pt-[14px]"
      // Basis = the table's min-width (640px), so the quick start wraps below
      // before the table has to scroll (HANDOFF §2.3: basis ≥ content minimum).
      style={{ flex: '999 1 640px' }}
    >
      <div className="mb-[10px] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-[10px]">
          <h2 id={headingId} className="m-0 text-[var(--ink2)]" style={LEGEND}>
            {t('today.entries.legend')}
          </h2>
          <span className="font-num text-[11px] text-[var(--ink3)]">{entries.length}</span>
        </div>
        <button
          type="button"
          onClick={onAdd}
          disabled={addDisabled}
          className="key-hover flex min-h-[44px] items-center gap-2 rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] px-4 text-[13px] font-semibold text-[var(--ink)] shadow-[inset_0_-2px_0_var(--key-edge)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PlusGlyph />
          {t('today.addEntry')}
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="border-t border-[var(--line)] py-8">
          <p className="text-sm font-semibold text-[var(--ink)]">{t('today.recent.empty')}</p>
          <p className="mt-1 text-xs text-[var(--ink3)]">{t('today.recent.emptyHint')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse">
            <thead>
              <tr>
                <th scope="col" className={TH} style={{ ...TH_LEGEND, padding: '0 12px 10px 0' }}>
                  {t('today.table.time')}
                </th>
                <th scope="col" className={TH} style={TH_LEGEND}>
                  {t('today.table.clientProject')}
                </th>
                <th scope="col" className={TH} style={TH_LEGEND}>
                  {t('today.table.description')}
                </th>
                <th scope="col" className={`${TH} text-right`} style={TH_LEGEND}>
                  {t('today.table.duration')}
                </th>
                <th scope="col" className="p-0">
                  <span className="sr-only">{t('today.table.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <EntryRow
                  key={entryRowKey(e)}
                  entry={e}
                  client={clientsById.get(e.client_id)}
                  project={e.project_id != null ? projectsById.get(e.project_id) : undefined}
                  nowMs={nowMs}
                  showProjectNumber={showProjectNumber}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onResume={onResume}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function EntryRow({
  entry,
  client,
  project,
  nowMs,
  showProjectNumber,
  onEdit,
  onDelete,
  onResume
}: {
  entry: Entry
  client: Client | undefined
  project: Project | undefined
  nowMs: number
  showProjectNumber: boolean
  onEdit: (e: Entry) => void
  onDelete: (e: Entry) => void
  onResume?: (e: Entry) => void
}): React.JSX.Element {
  const t = useT()
  const running = entry.stopped_at === null
  const start = clockTime(entry.started_at)
  const timeRange = running ? `${start}–` : `${start}–${clockTime(entry.stopped_at as string)}`
  const tags = deserializeTags(entry.tags)
  const projectLabel = project
    ? project.name +
      (showProjectNumber && project.external_project_number
        ? ` [${project.external_project_number}]`
        : '')
    : undefined

  let durationText: string
  let durationTitle: string | undefined
  if (running) {
    durationText = formatHMMSS(secondsBetween(entry.started_at, nowMs))
  } else {
    const raw = secondsBetween(entry.started_at, new Date(entry.stopped_at as string).getTime())
    // The billed minutes of the view when the profile rounds; the raw time otherwise.
    const billed = entryBilledMinutes(entry, nowMs)
    const shown = billed !== null ? billed * 60 : raw
    durationText = formatHMM(shown)
    durationTitle = shown !== raw ? formatHMM(raw) : undefined
  }

  return (
    <tr className="border-t border-[var(--line)] hover:bg-[var(--key)]">
      <td
        className="font-num h-[58px] whitespace-nowrap text-[13px] text-[var(--ink2)]"
        style={{ padding: '0 12px 0 0' }}
      >
        {timeRange}
      </td>
      <td className="px-3">
        <div className="flex items-center gap-[10px]">
          <span
            aria-hidden="true"
            className="h-[10px] w-[10px] flex-none"
            style={{ background: project?.color || client?.color || 'var(--tick)' }}
          />
          {/* Capped and ellipsised: long project names otherwise force the
              table wider than its column at 1280 px (full text in the title). */}
          <div className="min-w-0 max-w-[220px]">
            <div
              className="truncate text-sm font-semibold text-[var(--ink)]"
              title={client?.name ?? undefined}
            >
              {client?.name ?? t('common.unknown')}
            </div>
            {project && (
              <div className="truncate text-xs text-[var(--ink2)]" title={projectLabel}>
                {projectLabel}
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="px-3">
        <div className="flex flex-wrap items-center gap-2">
          {entry.description ? (
            <span
              className="line-clamp-2 text-sm text-[var(--ink)] [overflow-wrap:anywhere]"
              title={entry.description}
            >
              {entry.description}
            </span>
          ) : (
            <span className="text-sm text-[var(--ink3)]">—</span>
          )}
          {tags.map((tag) => (
            <span
              key={tag}
              className="border border-[var(--line)] text-[var(--ink2)]"
              style={{ ...LEGEND, fontSize: 10, padding: '3px 6px' }}
            >
              {tag}
            </span>
          ))}
          {!!entry.billed && <BilledChip />}
          <EntryOrigin source={entry.source} />
        </div>
      </td>
      <td
        className="font-num whitespace-nowrap px-3 text-right text-sm text-[var(--ink)]"
        style={{ fontWeight: running ? 600 : 400 }}
        title={durationTitle}
      >
        {durationText}
      </td>
      <td className="w-[144px] p-0">
        <div className="flex justify-end gap-1">
          {/* Q8: not on the running row (it already runs); an archived client
              cannot be resumed (same rule as the last pair). */}
          {running || !onResume ? (
            <span aria-hidden="true" className="h-[44px] w-[44px]" />
          ) : (
            <button
              type="button"
              onClick={() => onResume(entry)}
              disabled={resumeTarget(entry, client, project) === null}
              className={`${ICON_BUTTON} disabled:cursor-not-allowed disabled:opacity-40`}
              aria-label={t('today.table.resumeAria', { time: start })}
              title={
                resumeTarget(entry, client, project) === null
                  ? t('today.table.resumeArchived')
                  : t('today.table.resume')
              }
            >
              <PlayGlyph />
            </button>
          )}
          <button
            type="button"
            onClick={() => onEdit(entry)}
            className={ICON_BUTTON}
            aria-label={t('today.table.editAria', { time: start })}
            title={t('common.edit')}
          >
            <PencilGlyph />
          </button>
          {running ? (
            <span aria-hidden="true" className="h-[44px] w-[44px]" />
          ) : (
            <button
              type="button"
              onClick={() => onDelete(entry)}
              className={ICON_BUTTON}
              aria-label={t('today.table.deleteAria', { time: start })}
              title={t('common.delete')}
            >
              <TrashGlyph />
            </button>
          )}
        </div>
      </td>
    </tr>
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

const TH = 'text-left text-[var(--ink3)]'
const TH_LEGEND: React.CSSProperties = { ...LEGEND, fontSize: 10, padding: '0 12px 10px' }

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

function PlayGlyph(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 2.5v11l9-5.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
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

function clockTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function secondsBetween(startIso: string, endMs: number): number {
  return Math.max(0, Math.floor((endMs - new Date(startIso).getTime()) / 1000))
}

/** `H:MM` — completed durations (HANDOFF §2.2). */
function formatHMM(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}`
}

/** `H:MM:SS` — the running duration. */
function formatHMMSS(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const s = total % 60
  return `${formatHMM(total)}:${String(s).padStart(2, '0')}`
}
