import { useEffect, useId, useRef, useState } from 'react'
import type { Client, Project } from '../../../shared/types'
import type { PeriodReviewEntry, RuleCheckFinding } from '../../../shared/ruleCheck'
import { formatRuleCheckFinding } from '../../../shared/ruleCheck'
import { getQuickRange, localDateKey, type QuickRangeKind } from '../../../shared/dateRanges'
import { formatSecondsHm } from '../../../shared/currency'
import { useLocale, useT } from '../contexts/I18nContext'
import { useWeekStart } from '../hooks/useWeekStart'
import { useEntriesStore } from '../store/entriesStore'
import { BilledChip } from './BilledChip'
import { EntryEditForm } from './EntryEditForm'
import { FIELD_LABEL, FOCUS, INPUT, KEY_INV, LEGEND, READOUT, SECTION } from './instrumentClasses'

export interface ReviewSelection {
  clientId: number
  projectId?: number
  fromIso: string
  toIso: string
}

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
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5">
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
  const [result, setResult] = useState<{
    entries: PeriodReviewEntry[]
    findings: RuleCheckFinding[]
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [highlightedId, setHighlightedId] = useState<number | null>(null)
  const rows = useRef(new Map<number, HTMLLIElement>())
  // Entry writes elsewhere (timer stop, quick note, calendar) reload the review too.
  const entriesVersion = useEntriesStore((s) => s.version)
  const { clientId, projectId, fromIso, toIso } = selection
  useEffect(() => {
    let cancelled = false
    const request = { clientId, ...(projectId === undefined ? {} : { projectId }), fromIso, toIso }
    void Promise.all([
      window.api.ruleCheck.period(request),
      window.api.entries.getForReview(request)
    ])
      .then(([check, list]) => {
        if (cancelled) return
        if (!check.ok) throw new Error(check.error)
        if (!list.ok) throw new Error(list.error)
        setResult({ findings: check.data, entries: list.data })
        setError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [clientId, projectId, fromIso, toIso, refreshKey, entriesVersion])
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
  // The day finding carries a local YYYY-MM-DD key; show it like the other dates.
  const findingText = (finding: RuleCheckFinding): string => {
    const day = finding.params.day
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return formatRuleCheckFinding(finding, locale)
    }
    const [y, m, d] = day.split('-').map(Number)
    const shown = new Date(y, m - 1, d).toLocaleDateString(intlLocale, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    })
    return formatRuleCheckFinding({ ...finding, params: { ...finding.params, day: shown } }, locale)
  }
  function openEditor(id: number, jump = false): void {
    setEditingId(id)
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
      {result ? (
        <div>
          <h3 className={`${LEGEND} mb-2`}>
            {t('review.findings', { count: result.findings.length })}
          </h3>
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
                    {findingText(finding)}
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
      <button type="button" className={`${KEY_INV} self-start`} onClick={() => onPdf(selection)}>
        {t('review.pdf')}
      </button>
      {result && (
        <div>
          <h3 className={`${LEGEND} mb-2`}>
            {t('review.entries', { count: result.entries.length })}
          </h3>
          {/* No scroll box of its own: the editor's sticky button bar would stick to
              its lower edge and cover the form. The list scrolls with the page. */}
          <ul aria-label={t('review.entries', { count: result.entries.length })}>
            {result.entries.length === 0 && <li className={READOUT}>{t('review.noEntries')}</li>}
            {result.entries.map((entry) => (
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
                    {projects.find((p) => p.id === entry.project_id)?.name ?? t('review.noProject')}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {entry.description || t('review.noDescription')}
                  </span>
                  <span className="text-xs text-[var(--ink3)]">
                    {t(entry.billable ? 'review.billable' : 'review.notBillable')}
                  </span>
                  {!!entry.billed && <BilledChip />}
                  {result.findings.some((f) => f.entryId === entry.id) && (
                    <span className={FIELD_LABEL}>{t('review.hasFindings')}</span>
                  )}
                </button>
                {editingId === entry.id && (
                  <div className="mt-3 max-w-2xl">
                    <EntryEditForm
                      entry={entry}
                      clients={clients}
                      onCancel={() => setEditingId(null)}
                      // The form bumps the entries version on save; that reloads the review.
                      onSaved={() => setEditingId(null)}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}
