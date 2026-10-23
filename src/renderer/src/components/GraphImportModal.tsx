import { useState } from 'react'
import { useT } from '../contexts/I18nContext'
import { useEntriesStore } from '../store/entriesStore'
import { Dialog } from './Dialog'
import { FOCUS, INPUT, KEY, KEY_INV } from './instrumentClasses'
import type { Client, Project } from '../../../shared/types'
import type { DomainTarget, EntryDraft, SkippedEvent } from '../../../shared/graphCalendar'
import type { TranslationKey } from '../../../shared/locales/de'

interface Props {
  open: boolean
  onClose: () => void
  clients: Client[]
}

/**
 * "Import appointments" (#130c) — the confirm step of the calendar import.
 *
 * Everything that decides anything (filters, domain matching, dedupe, entry
 * validation) lives in the main process; this dialog renders drafts and
 * collects three choices per row: take it or not, which client, and whether a
 * not-yet-mapped domain should be remembered for that client.
 *
 * The learn checkbox defaults to ON by decision on #130 (2026-07-29): mappings
 * are only ever created here, visibly, never silently — but the common case
 * (the mapping is right) should not cost an extra click per meeting. The
 * counterpart decision on #176: deviating from an ALREADY-learned mapping shows
 * the checkbox default OFF — a one-off exception must not silently re-learn
 * the rule.
 */
interface RowState {
  checked: boolean
  clientId: number | null
  /** Project within that client (#176), or null. */
  projectId: number | null
  /** Domain → learn? Rendered only while the domain's stored mapping differs. */
  learn: Record<string, boolean>
}

type Phase = 'idle' | 'loading' | 'loaded' | 'importing' | 'done'

export function GraphImportModal({ open, onClose, clients }: Props): React.ReactElement | null {
  const t = useT()
  const bumpVersion = useEntriesStore((s) => s.bumpVersion)

  const today = localDateInputValue(new Date())
  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(today)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<EntryDraft[]>([])
  const [skipped, setSkipped] = useState<SkippedEvent[]>([])
  const [rows, setRows] = useState<Map<string, RowState>>(new Map())
  const [failures, setFailures] = useState<Map<string, string>>(new Map())
  const [doneMsg, setDoneMsg] = useState<string | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [mapping, setMapping] = useState<Map<string, DomainTarget>>(new Map())

  const activeClients = clients.filter((c) => c.active)

  function activeProjects(clientId: number | null): Project[] {
    if (clientId === null) return []
    return projects.filter((p) => p.client_id === clientId && p.active === 1)
  }

  /**
   * The project a stored mapping suggests for this row under the given client:
   * only when the row's mapped domains that point at that client agree on one.
   */
  function mappedProjectFor(draft: EntryDraft, clientId: number): number | null {
    const projectIds = new Set(
      draft.domains
        .map((d) => mapping.get(d))
        .filter((t): t is DomainTarget => t !== undefined && t.clientId === clientId)
        .map((t) => t.projectId)
    )
    return projectIds.size === 1 ? [...projectIds][0] : null
  }

  /** Whether the learn checkbox for this domain is visible under the current selection. */
  function learnVisible(domain: string, row: RowState): boolean {
    if (row.clientId === null) return false
    const stored = mapping.get(domain)
    if (!stored) return true
    return stored.clientId !== row.clientId || stored.projectId !== row.projectId
  }

  function reset(): void {
    setPhase('idle')
    setError(null)
    setDrafts([])
    setSkipped([])
    setRows(new Map())
    setFailures(new Map())
    setDoneMsg(null)
    setProjects([])
    setMapping(new Map())
  }

  function close(): void {
    reset()
    onClose()
  }

  async function load(): Promise<void> {
    setPhase('loading')
    setError(null)
    setFailures(new Map())
    setDoneMsg(null)
    const range = dateRangeIso(fromDate, toDate)
    const [previewRes, domainsRes, projectsRes] = await Promise.all([
      window.api.graph.calendarPreview(range),
      window.api.graph.listDomains(),
      window.api.projects.getAll({})
    ])
    if (!previewRes.ok) {
      setPhase('idle')
      setError(previewRes.error)
      return
    }
    const stored = new Map<string, DomainTarget>(
      domainsRes.ok
        ? domainsRes.data.map((d) => [d.domain, { clientId: d.clientId, projectId: d.projectId }])
        : []
    )
    const next = new Map<string, RowState>()
    for (const draft of previewRes.data.drafts) {
      next.set(draft.graphEventId, {
        checked: draft.clientId !== null,
        clientId: draft.clientId,
        projectId: draft.projectId,
        // New domains default ON (#130 decision); already-mapped domains start
        // OFF — their box only appears when the selection deviates (#176).
        learn: Object.fromEntries(draft.domains.map((d) => [d, !stored.has(d)]))
      })
    }
    setMapping(stored)
    setProjects(projectsRes.ok ? projectsRes.data : [])
    setDrafts(previewRes.data.drafts)
    setSkipped(previewRes.data.skipped)
    setRows(next)
    setPhase('loaded')
  }

  function patchRow(id: string, patch: Partial<RowState>): void {
    setRows((prev) => {
      const next = new Map(prev)
      const row = next.get(id)
      if (row) next.set(id, { ...row, ...patch })
      return next
    })
  }

  const selected = drafts.filter((d) => {
    const row = rows.get(d.graphEventId)
    return row?.checked === true && row.clientId !== null
  })

  async function runImport(): Promise<void> {
    setPhase('importing')
    setError(null)
    // Learn first: an import failure (e.g. overlap) should not cost the user
    // the mapping they just confirmed — next preview then matches already.
    for (const draft of selected) {
      const row = rows.get(draft.graphEventId)
      if (!row || row.clientId === null) continue
      for (const [domain, learn] of Object.entries(row.learn)) {
        if (learn && learnVisible(domain, row)) {
          await window.api.graph.learnDomain(domain, row.clientId, row.projectId)
        }
      }
    }
    const res = await window.api.graph.importEntries(
      selected.map((d) => {
        const row = rows.get(d.graphEventId)
        return {
          graphEventId: d.graphEventId,
          description: d.description,
          startedAt: d.startedAt,
          stoppedAt: d.stoppedAt,
          clientId: row?.clientId ?? 0,
          projectId: row?.projectId ?? null
        }
      })
    )
    if (!res.ok) {
      setPhase('loaded')
      setError(res.error)
      return
    }
    if (res.data.created > 0) bumpVersion()
    setFailures(new Map(res.data.failed.map((f) => [f.graphEventId, f.error])))
    setDoneMsg(
      res.data.created === 0
        ? t('calendarImport.doneAllFailed')
        : t('calendarImport.done', { created: res.data.created, total: selected.length })
    )
    // Keep failed rows on screen with their errors; drop the imported ones.
    const failedIds = new Set(res.data.failed.map((f) => f.graphEventId))
    setDrafts((prev) =>
      prev.filter((d) => {
        const row = rows.get(d.graphEventId)
        const wasSelected = row?.checked === true && row.clientId !== null
        return !wasSelected || failedIds.has(d.graphEventId)
      })
    )
    setPhase('done')
  }

  if (!open) return null

  return (
    <Dialog open={open} onClose={close} title={t('calendarImport.title')} widthClass="w-[640px]">
      <div className="flex flex-col gap-4">
        {/* Range picker + load */}
        <div className="flex flex-wrap items-end gap-3">
          <DateField
            label={t('calendarImport.from')}
            value={fromDate}
            onChange={(v) => setFromDate(v)}
          />
          <DateField label={t('calendarImport.to')} value={toDate} onChange={(v) => setToDate(v)} />
          <button
            type="button"
            onClick={() => void load()}
            disabled={phase === 'loading' || phase === 'importing'}
            className={KEY_INV}
          >
            {phase === 'loading' ? t('calendarImport.loading') : t('calendarImport.load')}
          </button>
        </div>

        {error && (
          <p className="text-xs" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        {doneMsg && (
          <p className="text-xs" style={{ color: 'var(--ink2)' }}>
            {doneMsg}
          </p>
        )}

        {(phase === 'loaded' || phase === 'importing' || phase === 'done') &&
          drafts.length === 0 && (
            <p className="text-sm" style={{ color: 'var(--ink3)' }}>
              {t('calendarImport.empty')}
            </p>
          )}

        {/* Draft rows */}
        {drafts.map((draft) => {
          const row = rows.get(draft.graphEventId)
          if (!row) return null
          const failure = failures.get(draft.graphEventId)
          const hintKey = hintTranslationKey(draft.clientHint)
          return (
            <div
              key={draft.graphEventId}
              className="flex flex-col gap-2 border-b border-[var(--line)] py-2.5"
            >
              <div className="flex items-start gap-3">
                {/* 44 × 44 hit area around the 16 px box; the negative margins
                    keep the row's layout as it was. */}
                <label className="-mx-3.5 -mt-2.5 -mb-3.5 grid h-11 w-11 shrink-0 cursor-pointer place-items-center">
                  <input
                    type="checkbox"
                    checked={row.checked}
                    disabled={row.clientId === null || phase === 'importing'}
                    onChange={(e) => patchRow(draft.graphEventId, { checked: e.target.checked })}
                    className={`h-4 w-4 accent-[var(--ink)] ${FOCUS}`}
                    aria-label={draft.description}
                  />
                </label>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium" style={{ color: 'var(--ink)' }}>
                    {draft.description || '—'}
                  </div>
                  <div className="font-num text-xs text-[var(--ink2)]">
                    {formatDraftRange(draft.startedAt, draft.stoppedAt)}
                  </div>
                </div>
                <div className="flex w-44 shrink-0 flex-col gap-1.5">
                  <select
                    value={row.clientId ?? ''}
                    disabled={phase === 'importing'}
                    onChange={(e) => {
                      const clientId = e.target.value ? Number(e.target.value) : null
                      // Choosing a client is the intent to take the row. The
                      // project follows the stored mapping when it has one for
                      // this client, otherwise it resets.
                      patchRow(draft.graphEventId, {
                        clientId,
                        projectId: clientId === null ? null : mappedProjectFor(draft, clientId),
                        checked: clientId !== null
                      })
                    }}
                    aria-label={t('calendarImport.clientPlaceholder')}
                    className={`w-full appearance-none ${INPUT}`}
                  >
                    <option value="">{t('calendarImport.clientPlaceholder')}</option>
                    {activeClients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {activeProjects(row.clientId).length > 0 && (
                    <select
                      value={row.projectId ?? ''}
                      disabled={phase === 'importing'}
                      onChange={(e) =>
                        patchRow(draft.graphEventId, {
                          projectId: e.target.value ? Number(e.target.value) : null
                        })
                      }
                      aria-label={t('calendarImport.projectPlaceholder')}
                      className={`w-full appearance-none ${INPUT}`}
                    >
                      <option value="">{t('calendarImport.projectPlaceholder')}</option>
                      {activeProjects(row.clientId).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              {row.clientId === null && hintKey && (
                <p className="text-xs" style={{ color: 'var(--ink3)' }}>
                  {t(hintKey)}
                  {draft.domains.length > 0 && ` (${draft.domains.join(', ')})`}
                </p>
              )}

              {/* Learn checkboxes — new domains default ON, a deviation from a
                  stored mapping shows the box default OFF (#176). Hidden while
                  the selection matches what is already learned. */}
              {Object.keys(row.learn)
                .filter((domain) => learnVisible(domain, row))
                .map((domain) => (
                  <label
                    key={domain}
                    className="flex min-h-11 cursor-pointer items-center gap-2 text-xs"
                    style={{ color: 'var(--ink2)' }}
                  >
                    <input
                      type="checkbox"
                      checked={row.learn[domain]}
                      disabled={phase === 'importing'}
                      onChange={(e) =>
                        patchRow(draft.graphEventId, {
                          learn: { ...row.learn, [domain]: e.target.checked }
                        })
                      }
                      className={`h-3.5 w-3.5 accent-[var(--ink)] ${FOCUS}`}
                    />
                    {t(
                      row.projectId !== null
                        ? 'calendarImport.learnWithProject'
                        : 'calendarImport.learn',
                      { domain }
                    )}
                  </label>
                ))}

              {failure && (
                <p className="text-xs" style={{ color: 'var(--danger)' }}>
                  {failure}
                </p>
              )}
            </div>
          )
        })}

        {/* Skipped events, folded away — they explain, they don't nag. */}
        {skipped.length > 0 && (
          <details>
            <summary
              className={`cursor-pointer rounded-[var(--r-fine)] text-xs ${FOCUS}`}
              style={{ color: 'var(--ink3)' }}
            >
              {t('calendarImport.skipped', { count: skipped.length })}
            </summary>
            <ul
              className="mt-1 flex flex-col gap-0.5 pl-4 text-xs"
              style={{ color: 'var(--ink3)' }}
            >
              {skipped.map((s, i) => (
                <li key={s.graphEventId ?? i}>
                  {s.subject || '—'} — {t(skipReasonKey(s.reason))}
                </li>
              ))}
            </ul>
          </details>
        )}

        {/* Footer */}
        {(phase === 'loaded' || phase === 'importing') && drafts.length > 0 && (
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={close} className={KEY}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void runImport()}
              disabled={selected.length === 0 || phase === 'importing'}
              className={KEY_INV}
            >
              {phase === 'importing'
                ? t('calendarImport.importing')
                : t('calendarImport.import', { count: selected.length })}
            </button>
          </div>
        )}
        {phase === 'done' && (
          <div className="flex items-center justify-end">
            <button type="button" onClick={close} className={KEY}>
              {t('common.close')}
            </button>
          </div>
        )}
      </div>
    </Dialog>
  )
}

function DateField({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (v: string) => void
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--ink3)' }}>
      {label}
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT}
      />
    </label>
  )
}

/** Local YYYY-MM-DD for `<input type="date">` — NOT toISOString, which is UTC. */
function localDateInputValue(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Date inputs → the half-open ISO range the main process expects: local
 * midnight of `from` up to local midnight AFTER `to`, so "Von heute bis heute"
 * covers the whole of today.
 */
function dateRangeIso(from: string, to: string): { startIso: string; endIso: string } {
  const start = parseLocalDate(from)
  const end = parseLocalDate(to)
  end.setDate(end.getDate() + 1)
  return { startIso: start.toISOString(), endIso: end.toISOString() }
}

function parseLocalDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

function formatDraftRange(startedAt: string, stoppedAt: string): string {
  const start = new Date(startedAt)
  const stop = new Date(stoppedAt)
  const day = start.toLocaleDateString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit'
  })
  const hm = (d: Date): string =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${day} ${hm(start)}–${hm(stop)}`
}

function hintTranslationKey(hint: EntryDraft['clientHint']): TranslationKey | null {
  switch (hint) {
    case 'no-domain':
      return 'calendarImport.hint.noDomain'
    case 'unknown-domain':
      return 'calendarImport.hint.unknownDomain'
    case 'ambiguous':
      return 'calendarImport.hint.ambiguous'
    case 'matched':
      return null
  }
}

function skipReasonKey(reason: SkippedEvent['reason']): TranslationKey {
  switch (reason) {
    case 'cancelled':
      return 'calendarImport.skipReason.cancelled'
    case 'all-day':
      return 'calendarImport.skipReason.allDay'
    case 'declined':
      return 'calendarImport.skipReason.declined'
    case 'free':
      return 'calendarImport.skipReason.free'
    case 'no-id':
      return 'calendarImport.skipReason.noId'
    case 'no-times':
      return 'calendarImport.skipReason.noTimes'
    case 'already-imported':
      return 'calendarImport.skipReason.alreadyImported'
  }
}
