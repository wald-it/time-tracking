import { useEffect, useId, useRef, useState } from 'react'
import type { Client, Project } from '../../../shared/types'
import type { BillingPreview, ReviewSelection } from '../../../shared/billingPreview'
export type { ReviewSelection } from '../../../shared/billingPreview'
import type { PeriodReviewEntry, RuleCheckFinding } from '../../../shared/ruleCheck'
import { formatRuleCheckFinding } from '../../../shared/ruleCheck'
import { getQuickRange, localDateKey, type QuickRangeKind } from '../../../shared/dateRanges'
import { formatSecondsHm } from '../../../shared/currency'
import { guardFormula } from '../../../shared/csv'
import { useLocale, useT } from '../contexts/I18nContext'
import { useWeekStart } from '../hooks/useWeekStart'
import { useEntriesStore } from '../store/entriesStore'
import { useTimerStore } from '../store/timerStore'
import { BilledChip } from './BilledChip'
import { EntryEditForm } from './EntryEditForm'
import { Toggle } from './Toggle'
import {
  FIELD_LABEL,
  FOCUS,
  INPUT,
  KEY,
  KEY_INV,
  LEGEND,
  READOUT,
  SECTION
} from './instrumentClasses'

// The renderer takes its types from shared/ or the preload API, never from main/.
type ChangedSinceRunResult = Extract<
  Awaited<ReturnType<Window['api']['review']['changedSinceRun']>>,
  { ok: true }
>['data']

export function MonthlyReview({
  onPdf,
  refreshKey
}: {
  onPdf: (selection: ReviewSelection) => void
  refreshKey: number
}): React.JSX.Element {
  const t = useT()
  const weekStart = useWeekStart()
  const titleId = useId()
  const [clients, setClients] = useState<Client[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [clientId, setClientId] = useState<number | null>(null)
  const [projectId, setProjectId] = useState<number | undefined>()
  const [quickRange, setQuickRange] = useState<QuickRangeKind | ''>('lastMonth')
  const [range, setRange] = useState(() => {
    const initial = getQuickRange('lastMonth', new Date(), weekStart)
    return { fromIso: localDateKey(initial.from), toIso: localDateKey(initial.to) }
  })
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.api.clients
      .getAll()
      .then((res) => {
        if (cancelled) return
        if (res.ok) setClients(res.data)
        else setError(res.error)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    if (clientId === null) return
    let cancelled = false
    void window.api.projects
      .getAll({ clientId })
      .then((res) => {
        if (cancelled) return
        if (res.ok) setProjects(res.data)
        else setError(res.error)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [clientId])
  const validRange = Boolean(range.fromIso && range.toIso && range.fromIso <= range.toIso)
  const selection =
    clientId !== null && validRange
      ? {
          clientId,
          ...(projectId === undefined ? {} : { projectId }),
          ...range
        }
      : null
  return (
    <section aria-labelledby={titleId} className={`${SECTION} min-w-0 gap-4`}>
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className={LEGEND}>
          {t('review.title')}
        </h2>
        <p className="max-w-[65ch] text-xs text-[var(--ink3)]">{t('review.hint')}</p>
      </div>
      <div
        role="group"
        aria-labelledby={titleId}
        className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5"
      >
        <label className="flex min-w-0 flex-col gap-1">
          <span className={FIELD_LABEL}>{t('review.client')}</span>
          <select
            required
            className={INPUT}
            value={clientId ?? ''}
            onChange={(e) => {
              setClientId(e.target.value ? Number(e.target.value) : null)
              setProjectId(undefined)
              setProjects([])
              setError(null)
            }}
          >
            <option value="">{t('export.client.placeholder')}</option>
            {clients
              .filter((c) => c.active === 1)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className={FIELD_LABEL}>{t('review.project')}</span>
          <select
            className={INPUT}
            disabled={clientId === null}
            value={projectId ?? ''}
            onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : undefined)}
          >
            <option value="">{t('review.allProjects')}</option>
            {projects
              .filter((p) => p.active === 1)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className={FIELD_LABEL}>{t('review.period')}</span>
          <select
            className={INPUT}
            value={quickRange}
            onChange={(e) => {
              const kind = e.target.value as QuickRangeKind
              const next = getQuickRange(kind, new Date(), weekStart)
              setQuickRange(kind)
              setRange({ fromIso: localDateKey(next.from), toIso: localDateKey(next.to) })
            }}
          >
            <option value="" disabled>
              {t('review.custom')}
            </option>
            {(['lastMonth', 'thisWeek', 'lastWeek', 'thisMonth'] as const).map((kind) => (
              <option key={kind} value={kind}>
                {t(`export.range.${kind}`)}
              </option>
            ))}
          </select>
        </label>
        {(['fromIso', 'toIso'] as const).map((field) => (
          <label key={field} className="flex min-w-0 flex-col gap-1">
            <span className={FIELD_LABEL}>
              {t(field === 'fromIso' ? 'review.from' : 'review.to')}
            </span>
            <input
              type="date"
              required
              className={`${INPUT} min-w-0`}
              value={range[field]}
              onChange={(e) => {
                setQuickRange('')
                setRange((prev) => ({ ...prev, [field]: e.target.value }))
              }}
            />
          </label>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
      {!validRange && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {t('review.invalidRange')}
        </p>
      )}
      {selection ? (
        <ReviewResults
          key={`${clientId}:${projectId}:${range.fromIso}:${range.toIso}`}
          selection={selection}
          clients={clients}
          projects={projects}
          refreshKey={refreshKey}
          onPdf={onPdf}
        />
      ) : (
        <>
          <p className={READOUT}>{t('review.chooseClient')}</p>
          <button type="button" className={`${KEY_INV} self-start`} disabled>
            {t('review.pdf')}
          </button>
        </>
      )}
    </section>
  )
}

function BillingPreviewSection({ selection }: { selection: ReviewSelection }): React.JSX.Element {
  const t = useT()
  const { locale } = useLocale()
  const [preview, setPreview] = useState<BillingPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const { clientId, projectId, fromIso, toIso } = selection
  useEffect(() => {
    let cancelled = false
    void window.api.review
      .billingPreview({ clientId, projectId, fromIso, toIso })
      .then((res) => {
        if (cancelled) return
        if (!res.ok) throw new Error(res.error)
        setError(null)
        setPreview(res.data)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [clientId, projectId, fromIso, toIso])
  useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(null), 3000)
    return () => window.clearTimeout(timer)
  }, [status])
  const decimal = (n: number): string =>
    n.toLocaleString(locale === 'de' ? 'de-DE' : 'en-GB', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: false
    })
  const headers = [
    t('review.position'),
    t('review.hours'),
    t('review.rate'),
    t('review.net'),
    t('review.servicePeriod')
  ]
  const lines =
    preview?.lines.map((line) => [
      line.projectName ?? t('review.noProject'),
      decimal(line.billedMinutes / 60),
      decimal(line.rateCent / 100),
      decimal(line.feeCent / 100),
      `${line.fromIso} – ${line.toIso}`
    ]) ?? []
  const total = preview
    ? [
        t('review.total'),
        decimal(preview.totals.billedMinutes / 60),
        '',
        decimal(preview.totals.feeCent / 100),
        ''
      ]
    : []
  async function copy(): Promise<void> {
    try {
      // Keep each project name in one spreadsheet cell, including pasted tabs/newlines.
      // The name column is free text: guard it against formula evaluation like the CSV
      // export does; the numeric columns stay as they are.
      const text = [headers, ...lines, total]
        .map((row) =>
          row
            .map((cell, i) => {
              const flat = cell.replace(/[\t\r\n]+/g, ' ')
              return i === 0 ? guardFormula(flat) : flat
            })
            .join('\t')
        )
        .join('\n')
      await navigator.clipboard.writeText(text)
      setError(null)
      setStatus(t('review.copied'))
    } catch (e) {
      setError(String(e))
    }
  }
  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const res = await window.api.review.exportDayGrid(selection)
      if (res.ok) setStatus(t('review.dayGridSaved'))
      else if (res.code !== 'cancelled') setError(res.error)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {error && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
      {preview ? (
        <>
          {preview.billedEntriesCount > 0 && (
            <p className={READOUT}>
              {t('review.alreadyBilled', { count: preview.billedEntriesCount })}
            </p>
          )}
          <div className={`${READOUT} overflow-x-auto`}>
            <table className="w-full text-left tabular-nums">
              <caption className={`${LEGEND} pb-2 text-left`}>{t('review.preview')}</caption>
              <thead>
                <tr>
                  {headers.map((header, i) => (
                    <th
                      key={header}
                      scope="col"
                      className={`px-2 py-1 ${i > 0 && i < 4 ? 'text-right' : ''}`}
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => (
                  <tr key={`${preview.lines[i].projectId}:${preview.lines[i].rateCent}`}>
                    {line.map((cell, j) => (
                      <td key={j} className={`px-2 py-1 ${j > 0 && j < 4 ? 'text-right' : ''}`}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-[var(--line)] font-semibold">
                  {total.map((cell, i) =>
                    i === 0 ? (
                      <th key={i} scope="row" className="px-2 py-1">
                        {cell}
                      </th>
                    ) : (
                      <td key={i} className={`px-2 py-1 ${i < 4 ? 'text-right' : ''}`}>
                        {cell}
                      </td>
                    )
                  )}
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={KEY} onClick={() => void copy()}>
              {t('review.copyItems')}
            </button>
            <button type="button" className={KEY} disabled={saving} onClick={() => void save()}>
              {t('review.saveDayGrid')}
            </button>
          </div>
        </>
      ) : (
        !error && <p className={READOUT}>{t('review.loading')}</p>
      )}
      {status && (
        <p role="status" className={READOUT}>
          {status}
        </p>
      )}
    </div>
  )
}

interface LoadedReview {
  entries: PeriodReviewEntry[]
  findings: RuleCheckFinding[]
  changes: ChangedSinceRunResult | null
}

/**
 * Applies the "changed since last invoice" filter. Without an active run it
 * keeps nothing. The entry open in the editor always stays listed until it is
 * saved or cancelled, even when a reload drops it from the filter (a run
 * released meanwhile): its unsaved values live in that form.
 */
function narrow(loaded: LoadedReview, openId: number | null): LoadedReview {
  if (!loaded.changes) return loaded
  const ids = new Set(loaded.changes.lastRun ? loaded.changes.entries.map((e) => e.entryId) : [])
  if (openId !== null) ids.add(openId)
  return {
    ...loaded,
    entries: loaded.entries.filter((e) => ids.has(e.id)),
    findings: loaded.findings.filter((f) => ids.has(f.entryId))
  }
}

function ReviewResults({
  selection,
  clients,
  projects,
  refreshKey,
  onPdf
}: {
  selection: ReviewSelection
  clients: Client[]
  projects: Project[]
  refreshKey: number
  onPdf: (selection: ReviewSelection) => void
}): React.JSX.Element {
  const t = useT()
  const { locale } = useLocale()
  const [changedOnly, setChangedOnly] = useState(false)
  const filterLabelId = useId()
  const [loaded, setResult] = useState<LoadedReview | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The entry as it was when the editor opened. A reload while it is open must
  // not hand the form a newer version_no under its old field values, or saving
  // would overwrite the newer write without a conflict.
  const [editing, setEditing] = useState<PeriodReviewEntry | null>(null)
  const editingId = editing?.id ?? null
  // Never display an unfiltered snapshot while the filter loads or fails.
  const result =
    loaded && Boolean(loaded.changes) === changedOnly ? narrow(loaded, editingId) : null
  const [highlightedId, setHighlightedId] = useState<number | null>(null)
  const rows = useRef(new Map<number, HTMLLIElement>())
  // Entry writes elsewhere (quick note, calendar, and MCP or Stream Deck through
  // the global data:changed listener) reload the review too, and so does a
  // timer that starts or stops outside it (hotkey, tray, MCP), as in Heute.
  const entriesVersion = useEntriesStore((s) => s.version)
  const runningId = useTimerStore((s) => s.runningEntry?.id)
  const { clientId, projectId, fromIso, toIso } = selection
  useEffect(() => {
    let cancelled = false
    const request = { clientId, ...(projectId === undefined ? {} : { projectId }), fromIso, toIso }
    void Promise.all([
      window.api.ruleCheck.period(request),
      window.api.entries.getForReview(request),
      changedOnly ? window.api.review.changedSinceRun(request) : null
    ])
      .then(([check, list, changes]) => {
        if (cancelled) return
        if (!check.ok) throw new Error(check.error)
        if (!list.ok) throw new Error(list.error)
        if (changes && !changes.ok) throw new Error(changes.error)
        setResult({ findings: check.data, entries: list.data, changes: changes?.data ?? null })
        // Same version, same content: take the reloaded row, so a billing run
        // created meanwhile reaches the form (its reason prompt reads billed).
        // An entry that left the selection (deleted elsewhere) closes its editor.
        setEditing((open) => {
          if (!open) return open
          const fresh = list.data.find((e) => e.id === open.id)
          if (!fresh) return null
          return fresh.version_no === open.version_no ? fresh : open
        })
        setError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [clientId, projectId, fromIso, toIso, refreshKey, entriesVersion, runningId, changedOnly])
  const intlLocale = locale === 'en' ? 'en-GB' : 'de-DE'
  const dateTime = (iso: string): string =>
    new Date(iso).toLocaleString(intlLocale, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  const time = (iso: string): string =>
    new Date(iso).toLocaleTimeString(intlLocale, { hour: '2-digit', minute: '2-digit' })
  function openEditor(id: number, jump = false): void {
    // A second click on the open entry keeps its snapshot: the mounted form
    // keeps its field values, so it must keep their version too.
    setEditing((open) =>
      open?.id === id ? open : (result?.entries.find((e) => e.id === id) ?? null)
    )
    if (jump) {
      setHighlightedId(id)
      const row = rows.current.get(id)
      row?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      row?.focus({ preventScroll: true })
    }
  }
  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-2">
        {result && (
          <h3 className={`${LEGEND} mb-2`}>
            {t('review.findings', { count: result.findings.length })}
          </h3>
        )}
        <div className="flex items-center justify-between gap-3">
          <span id={filterLabelId} className={FIELD_LABEL}>
            {t('review.changedOnly')}
          </span>
          {/* Locked while the editor is open: switching reloads the lists and
              would unmount the form with its unsaved values. */}
          <Toggle
            checked={changedOnly}
            onChange={setChangedOnly}
            disabled={editing !== null}
            labelledBy={filterLabelId}
          />
        </div>
        {result?.changes &&
          (result.changes.lastRun ? (
            <p className="text-xs text-[var(--ink3)]">
              {t('review.sinceRun', {
                number: result.changes.lastRun.number,
                date: new Date(result.changes.lastRun.createdAt).toLocaleDateString(intlLocale, {
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric'
                })
              })}
            </p>
          ) : (
            <p role="status" className={READOUT}>
              {t('review.noActiveRun')}
            </p>
          ))}
      </div>
      {result ? (
        <div>
          <ul
            aria-label={t('review.findings', { count: result.findings.length })}
            className={`${READOUT} max-h-60 overflow-auto`}
          >
            {result.findings.length === 0 && <li>{t('review.noFindings')}</li>}
            {result.findings.map((finding, i) => {
              const entry = result.entries.find((e) => e.id === finding.entryId)
              return (
                <li key={`${finding.entryId}:${finding.rule}:${i}`}>
                  <button
                    type="button"
                    onClick={() => openEditor(finding.entryId, true)}
                    className={`w-full py-1 text-left hover:bg-[var(--key)] ${FOCUS}`}
                  >
                    {entry && <span>{dateTime(entry.entry_start)} · </span>}
                    {formatRuleCheckFinding(finding, locale)}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ) : (
        !error && (
          <p role="status" className={READOUT}>
            {t('review.loading')}
          </p>
        )
      )}
      {/* The filter aids review; PDF always exports the whole selection. */}
      <button type="button" className={`${KEY_INV} self-start`} onClick={() => onPdf(selection)}>
        {t('review.pdf')}
      </button>
      <BillingPreviewSection
        key={`${refreshKey}:${entriesVersion}:${runningId}`}
        selection={selection}
      />
      {result && (
        <div>
          <h3 className={`${LEGEND} mb-2`}>
            {t('review.entries', { count: result.entries.length })}
          </h3>
          {/* No scroll box of its own: the editor's sticky button bar would stick to
              its lower edge and cover the form. The list scrolls with the page. */}
          <ul aria-label={t('review.entries', { count: result.entries.length })}>
            {result.entries.length === 0 && <li className={READOUT}>{t('review.noEntries')}</li>}
            {result.entries.map((entry) => {
              const findingCount = result.findings.filter((f) => f.entryId === entry.id).length
              const change = result.changes?.entries.find((e) => e.entryId === entry.id)
              return (
                <li
                  key={entry.id}
                  aria-label={t('review.entry', { id: entry.id })}
                  tabIndex={-1}
                  ref={(node) => {
                    if (node) rows.current.set(entry.id, node)
                    else rows.current.delete(entry.id)
                  }}
                  data-highlighted={highlightedId === entry.id}
                  className={`border-b border-[var(--line)] p-3 ${FOCUS} ${highlightedId === entry.id ? 'bg-[var(--key)] ring-1 ring-inset ring-[var(--ink3)]' : ''}`}
                >
                  <button
                    type="button"
                    aria-label={t('common.edit')}
                    aria-expanded={editingId === entry.id}
                    className={`flex w-full flex-wrap items-baseline gap-x-4 gap-y-1 text-left text-sm ${FOCUS}`}
                    onClick={() => openEditor(entry.id)}
                  >
                    <span className="font-num text-xs">
                      {dateTime(entry.entry_start)}–
                      {localDateKey(new Date(entry.entry_start)) ===
                      localDateKey(new Date(entry.entry_stop))
                        ? time(entry.entry_stop)
                        : dateTime(entry.entry_stop)}
                    </span>
                    <span className="font-num text-xs">
                      {formatSecondsHm(entry.duration_seconds)}
                    </span>
                    <span className="text-xs text-[var(--ink3)]">
                      {projects.find((p) => p.id === entry.project_id)?.name ??
                        t('review.noProject')}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {entry.description || t('review.noDescription')}
                    </span>
                    <span className="text-xs text-[var(--ink3)]">
                      {t(entry.billable ? 'review.billable' : 'review.notBillable')}
                    </span>
                    {!!entry.billed && <BilledChip />}
                    {change && (
                      <span className="font-num text-xs text-[var(--ink3)]">
                        {t(change.change === 'created' ? 'review.createdOn' : 'review.changedOn', {
                          date: dateTime(change.changedAt)
                        })}
                      </span>
                    )}
                    {findingCount > 0 && (
                      <span className={FIELD_LABEL}>
                        {t('review.hasFindings', { count: findingCount })}
                      </span>
                    )}
                  </button>
                  {editing?.id === entry.id && (
                    <div className="mt-3 max-w-2xl">
                      <EntryEditForm
                        entry={editing}
                        clients={clients}
                        onCancel={() => setEditing(null)}
                        // The form bumps the entries version on save; that reloads the review.
                        onSaved={() => setEditing(null)}
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </>
  )
}
