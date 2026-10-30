import { useEffect, useId, useState } from 'react'
import type { Client, Project } from '../../../shared/types'
import type { BillingRunSummary } from '../../../main/billingRuns'
import { useT } from '../contexts/I18nContext'
import { useSettingsStore } from '../store/settingsStore'
import { Dialog } from './Dialog'
import { Toggle } from './Toggle'
import { FOCUS, INPUT, KEY, KEY_INV } from './instrumentClasses'
import { LS_PREFS_KEY, parsePrefs, readLegacyPrefs } from './exportPrefs'
import type { CsvFormat, ExportPrefs, ExportTab as Tab, GroupBy } from './exportPrefs'

interface Props {
  open: boolean
  onClose: () => void
  /** Pre-fills the range when opened from a quick-filter. */
  prefilledRange?: { fromIso: string; toIso: string }
  replacementRun?: BillingRunSummary
  onRunsChanged?: () => void
}

// Pref shape, defaults, parsing/validation, and the legacy localStorage key
// live in exportPrefs.ts (pure module, unit-tested). Persistence moved from
// localStorage to the DB `settings` table in v1.13.2 — see the rationale there.

/**
 * Unified export modal (v1.5 PR C, issue #18).
 *
 * Two tabs: PDF (Stundennachweis) and CSV (spreadsheet-friendly).
 * Shared state: client, fromIso, toIso — so switching tabs keeps the
 * selection. Tab-specific options appear in-place.
 *
 * Replaced the former PdfExportModal in v1.5; it is the app's only export
 * modal. Opened from the Export tab (its own tab since #153).
 */
export function ExportModal(props: Props): React.JSX.Element {
  const { open, onClose, prefilledRange, replacementRun, onRunsChanged } = props
  const t = useT()
  // Names the switches by their row labels (aria-labelledby).
  const labelId = useId()
  // Selectors (v1.13.2 PR 2): subscribe to the export_prefs key and the
  // loaded flag only — this modal's own writes no longer re-render every
  // settings consumer in the app.
  const exportPrefs = useSettingsStore((s) => s.settings?.export_prefs)
  const settingsLoaded = useSettingsStore((s) => s.settings !== null)
  const setSetting = useSettingsStore((s) => s.setSetting)

  // Init from the settings DB so the modal opens with the user's last
  // selection; the localStorage fallback covers the short window before the
  // one-time migration below has run. CalendarView remounts this component
  // per open (key prop), so this re-reads the latest value each time the
  // modal opens. Lazy useState: parse once per mount, not on every render.
  const [initialPrefs] = useState<ExportPrefs>(() => parsePrefs(exportPrefs ?? readLegacyPrefs()))

  const [tab, setTab] = useState<Tab>(replacementRun ? 'pdf' : initialPrefs.tab)
  const [clients, setClients] = useState<Client[]>([])
  const [clientId, setClientId] = useState<number | null>(replacementRun?.client_id ?? null)
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<number | null>(replacementRun?.project_id ?? null)
  const [fromIso, setFromIso] = useState(prefilledRange?.fromIso ?? '')
  const [toIso, setToIso] = useState(prefilledRange?.toIso ?? '')

  // PDF-specific
  const [includeSignatures, setIncludeSignatures] = useState(initialPrefs.includeSignatures)
  const [groupBy, setGroupBy] = useState<GroupBy>(initialPrefs.groupBy)
  const [hideFeeColumn, setHideFeeColumn] = useState(initialPrefs.hideFeeColumn)
  // Deliberately outside ExportPrefs: each ordinary export starts unchecked.
  const [markAsBilled, setMarkAsBilled] = useState(Boolean(replacementRun))
  const [invoiceRef, setInvoiceRef] = useState('')
  const [createdRun, setCreatedRun] = useState(false)

  // CSV-specific
  const [csvFormat, setCsvFormat] = useState<CsvFormat>(initialPrefs.csvFormat)
  const [csvGroupByTag, setCsvGroupByTag] = useState(initialPrefs.csvGroupByTag)

  // iCal-specific (#135)
  const [icalShowClientName, setIcalShowClientName] = useState(initialPrefs.icalShowClientName)

  const [busy, setBusy] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [statusKind, setStatusKind] = useState<'info' | 'error' | 'success'>('info')

  // v1.13 #118 / v1.13.2: persist prefs ONLY from user-interaction handlers,
  // never from an effect. Effect-based persistence clobbers stored prefs when
  // a fresh mount runs its effect with default state (StrictMode re-runs the
  // effect with the ref already set, so a mount-skip ref is not safe). The
  // patch is merged over the current state so one call persists the full blob.
  function persistPrefs(patch: Partial<ExportPrefs>): void {
    // Before the initial settings load there is nothing safe to merge onto —
    // skip; the next interaction after load persists the full state.
    if (!settingsLoaded) return
    const prefs: ExportPrefs = {
      tab,
      includeSignatures,
      groupBy,
      hideFeeColumn,
      csvFormat,
      csvGroupByTag,
      icalShowClientName,
      ...patch
    }
    setSetting('export_prefs', JSON.stringify(prefs)).catch(() => {
      // IPC/DB write failed — non-fatal, the modal still works this session.
    })
  }

  // Reset status when switching tabs so stale messages don't confuse.
  function handleTabChange(next: Tab): void {
    setTab(next)
    setStatusMsg(null)
    persistPrefs({ tab: next })
  }

  // v1.13.2: one-time migration of legacy localStorage prefs into the DB.
  // Runs once settings have loaded; the legacy key is removed afterwards so
  // this never fires again.
  useEffect(() => {
    if (!settingsLoaded || exportPrefs !== undefined) return
    const legacy = readLegacyPrefs()
    if (legacy === null) return
    setSetting('export_prefs', JSON.stringify(parsePrefs(legacy)))
      .then(() => {
        try {
          localStorage.removeItem(LS_PREFS_KEY)
        } catch {
          // Storage disabled — the DB value wins from now on either way.
        }
      })
      .catch(() => {
        // Migration write failed — keep the legacy key so the next app
        // launch retries instead of losing the prefs. (The optimistic store
        // update keeps export_prefs set for this session, so this effect
        // won't re-fire before a restart.)
      })
  }, [settingsLoaded, exportPrefs, setSetting])

  // Load clients once when the dialog first opens.
  useEffect(() => {
    if (!open || clients.length > 0) return
    void window.api.clients.getAll().then((res) => {
      if (res.ok) {
        setClients(res.data)
        if (!replacementRun && res.data.length === 1) {
          setClientId(res.data[0].id)
        }
      } else {
        setStatusKind('error')
        setStatusMsg(t('export.status.clientsError', { error: res.error }))
      }
    })
  }, [open, clients.length, replacementRun, t])

  // Sync the prefilled range if it changes after mount (e.g. quick-filters).
  useEffect(() => {
    if (prefilledRange) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- #142: dauerhaft — unerreichbar: CalendarView remountet per key statt neu zu rendern
      setFromIso(prefilledRange.fromIso)
      setToIso(prefilledRange.toIso)
    }
  }, [prefilledRange])

  // v1.13 #118: grouping by project is meaningless with a single project filter.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- #142: dauerhaft — Ableitung würde Dropdown-Anzeige und tatsächlichen Export auseinanderlaufen lassen
    if (projectId != null && groupBy === 'project') setGroupBy('none')
  }, [projectId, groupBy])

  // Load active projects when a client is selected; reset project filter on change.
  useEffect(() => {
    if (clientId == null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- #142: dauerhaft — Teilfix möglich, der asynchrone Zweig bleibt Effect
      setProjects([])
      setProjectId(null)
      return
    }
    void window.api.projects.getAll({ clientId }).then((res) => {
      if (res.ok) {
        const active = res.data.filter((p) => p.active === 1 || p.id === replacementRun?.project_id)
        setProjects(active)
        if (!replacementRun) setProjectId(null)
      }
    })
  }, [clientId, replacementRun])

  const canExport = clientId != null && fromIso !== '' && toIso !== '' && !busy && !createdRun

  function validateRange(): boolean {
    if (fromIso > toIso) {
      setStatusKind('error')
      setStatusMsg(t('export.status.dateError'))
      return false
    }
    return true
  }

  async function handlePdfExport(): Promise<void> {
    if (!canExport || !validateRange()) return
    if (markAsBilled && clients.some((c) => c.id === clientId && !c.short_code)) {
      setStatusKind('error')
      setStatusMsg(t('export.status.shortCodeMissing'))
      return
    }
    setBusy(true)
    setStatusMsg(t('export.status.pdfCreating'))
    setStatusKind('info')
    try {
      const res = await window.api.pdf.export({
        clientId: clientId!,
        fromIso,
        toIso,
        projectId: projectId ?? undefined,
        includeSignatures,
        groupBy,
        hideFeeColumn,
        markAsBilled,
        invoiceRef: markAsBilled ? invoiceRef.trim() || undefined : undefined,
        replacesRunId: replacementRun?.id
      })
      if (res.ok) {
        setStatusKind('success')
        if (res.data.runId !== undefined) {
          setCreatedRun(true)
        }
        setStatusMsg(
          [
            t('export.status.pdfSaved', { path: res.data.path }),
            ...(res.data.runNumber
              ? [t('export.status.runCreated', { number: res.data.runNumber })]
              : []),
            ...((res.data.excludedCount ?? 0) > 0
              ? [t('export.status.excluded', { count: res.data.excludedCount! })]
              : [])
          ].join(' ')
        )
      } else if (res.code === 'cancelled') {
        setStatusMsg(null)
      } else {
        setStatusKind('error')
        setStatusMsg(t('export.status.error', { error: res.error }))
      }
    } catch (error) {
      setStatusKind('error')
      setStatusMsg(t('export.status.error', { error: String(error) }))
    } finally {
      setBusy(false)
      // A run may have been committed even if writing the chosen file failed.
      if (markAsBilled) onRunsChanged?.()
    }
  }

  async function handleCsvExport(): Promise<void> {
    if (!canExport || !validateRange()) return
    setBusy(true)
    setStatusMsg(t('export.status.csvCreating'))
    setStatusKind('info')
    const res = await window.api.csv.export({
      clientId: clientId!,
      fromIso,
      toIso,
      projectId: projectId ?? undefined,
      format: csvFormat,
      invoiceRef: invoiceRef.trim() || undefined,
      groupByTag: csvGroupByTag
    })
    setBusy(false)
    if (res.ok) {
      setStatusKind('success')
      setStatusMsg(t('export.status.csvSaved', { path: res.data.path }))
    } else if (res.code === 'cancelled') {
      setStatusMsg(null)
    } else {
      setStatusKind('error')
      setStatusMsg(t('export.status.error', { error: res.error }))
    }
  }

  async function handleIcalExport(): Promise<void> {
    if (!canExport || !validateRange()) return
    setBusy(true)
    setStatusMsg(t('export.status.icalCreating'))
    setStatusKind('info')
    const res = await window.api.ical.export({
      clientId: clientId!,
      fromIso,
      toIso,
      projectId: projectId ?? undefined,
      showClientName: icalShowClientName
    })
    setBusy(false)
    if (res.ok) {
      setStatusKind('success')
      setStatusMsg(t('export.status.icalSaved', { path: res.data.path }))
    } else if (res.code === 'cancelled') {
      setStatusMsg(null)
    } else {
      setStatusKind('error')
      setStatusMsg(t('export.status.error', { error: res.error }))
    }
  }

  const inputClass = INPUT

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose()
      }}
      title={t('export.title')}
      widthClass="w-[520px]"
    >
      <div className="flex flex-col gap-4">
        {replacementRun && (
          <p className="text-sm text-[var(--ink2)]">
            {t('billingRuns.replacing', { number: replacementRun.number })}
          </p>
        )}
        {/* Tab bar */}
        <div className="flex gap-1 rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] p-1">
          {(['pdf', 'csv', 'ical'] as Tab[]).map((tabKey) => (
            <button
              key={tabKey}
              type="button"
              disabled={busy || Boolean(replacementRun) || createdRun}
              onClick={() => handleTabChange(tabKey)}
              aria-pressed={tab === tabKey}
              className={`min-h-9 flex-1 rounded-[var(--r-fine)] text-[13px] font-semibold ${FOCUS} ${
                tab === tabKey ? 'bg-[var(--inv)] text-[var(--inv-ink)]' : 'hover:text-[var(--ink)]'
              }`}
              style={tab !== tabKey ? { color: 'var(--ink2)' } : undefined}
            >
              {tabKey === 'pdf'
                ? t('export.tab.pdf')
                : tabKey === 'csv'
                  ? t('export.tab.csv')
                  : t('export.tab.ical')}
            </button>
          ))}
        </div>

        {/* Shared: client + date range */}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium" style={{ color: 'var(--ink2)' }}>
            {t('export.client.label')}
          </span>
          <select
            title={t('export.client.label')}
            value={clientId ?? ''}
            onChange={(e) =>
              setClientId(e.target.value === '' ? null : Number.parseInt(e.target.value, 10))
            }
            disabled={busy || Boolean(replacementRun) || createdRun}
            className={inputClass}
          >
            <option value="">{t('export.client.placeholder')}</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.rate_cent > 0
                  ? ` (${(c.rate_cent / 100).toFixed(2)} €/h)`
                  : ` ${t('export.client.noRate')}`}
              </option>
            ))}
          </select>
        </label>

        {/* Project filter — only shown when client has projects */}
        {projects.length > 0 && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium" style={{ color: 'var(--ink2)' }}>
              {t('export.project.label')}
            </span>
            <select
              title={t('export.project.label')}
              value={projectId ?? ''}
              onChange={(e) =>
                setProjectId(e.target.value === '' ? null : Number.parseInt(e.target.value, 10))
              }
              disabled={busy || Boolean(replacementRun) || createdRun}
              className={inputClass}
            >
              <option value="">{t('export.project.placeholder')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium" style={{ color: 'var(--ink2)' }}>
              {t('export.from')}
            </span>
            <input
              type="date"
              value={fromIso}
              onChange={(e) => setFromIso(e.target.value)}
              disabled={busy || Boolean(replacementRun) || createdRun}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium" style={{ color: 'var(--ink2)' }}>
              {t('export.to')}
            </span>
            <input
              type="date"
              value={toIso}
              onChange={(e) => setToIso(e.target.value)}
              disabled={busy || Boolean(replacementRun) || createdRun}
              className={inputClass}
            />
          </label>
        </div>

        {(tab === 'csv' || (tab === 'pdf' && markAsBilled)) && (
          <label className="flex flex-col gap-1 text-sm text-[var(--ink)]">
            {t('export.invoiceRef')}
            <input
              className={inputClass}
              value={invoiceRef}
              maxLength={64}
              onChange={(e) => setInvoiceRef(e.target.value)}
              disabled={busy || (tab === 'pdf' && createdRun)}
            />
          </label>
        )}

        {/* PDF-specific options */}
        {tab === 'pdf' && (
          <div className="flex flex-col gap-3">
            <label className="flex min-h-11 items-center gap-3 text-sm text-[var(--ink)]">
              <input
                type="checkbox"
                checked={markAsBilled}
                onChange={(e) => setMarkAsBilled(e.target.checked)}
                disabled={busy || Boolean(replacementRun) || createdRun}
                className={`accent-[var(--ink)] ${FOCUS}`}
              />
              {t('export.pdf.markAsBilled')}
            </label>
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-sm" style={{ color: 'var(--ink)' }}>
                  {t('export.pdf.groupBy')}
                </span>
                <select
                  title={t('export.pdf.groupBy')}
                  value={groupBy}
                  onChange={(e) => {
                    const next = e.target.value as GroupBy
                    setGroupBy(next)
                    persistPrefs({ groupBy: next })
                  }}
                  disabled={busy}
                  className={inputClass}
                >
                  <option value="none">{t('export.pdf.groupBy.none')}</option>
                  <option value="tag">{t('export.pdf.groupBy.tag')}</option>
                  <option value="project" disabled={projectId != null}>
                    {t('export.pdf.groupBy.project')}
                  </option>
                  <option value="reference">{t('export.pdf.groupBy.reference')}</option>
                </select>
              </div>
              <span className="text-xs" style={{ color: 'var(--ink3)' }}>
                {t('export.pdf.groupByHint')}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span id={`${labelId}-hideFee`} className="text-sm" style={{ color: 'var(--ink)' }}>
                  {t('export.pdf.hideFeeColumn')}
                </span>
                <Toggle
                  labelledBy={`${labelId}-hideFee`}
                  checked={hideFeeColumn}
                  onChange={(v) => {
                    setHideFeeColumn(v)
                    persistPrefs({ hideFeeColumn: v })
                  }}
                  disabled={busy}
                />
              </div>
              <span className="text-xs" style={{ color: 'var(--ink3)' }}>
                {t('export.pdf.hideFeeColumnHint')}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span
                  id={`${labelId}-signatures`}
                  className="text-sm"
                  style={{ color: 'var(--ink)' }}
                >
                  {t('export.pdf.signatures')}
                </span>
                <Toggle
                  labelledBy={`${labelId}-signatures`}
                  checked={includeSignatures}
                  onChange={(v) => {
                    setIncludeSignatures(v)
                    persistPrefs({ includeSignatures: v })
                  }}
                  disabled={busy}
                />
              </div>
              <span className="text-xs" style={{ color: 'var(--ink3)' }}>
                {t('export.pdf.signaturesHint')}
              </span>
            </div>
          </div>
        )}

        {/* CSV-specific options */}
        {tab === 'csv' && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span
                  id={`${labelId}-csvGroup`}
                  className="text-sm"
                  style={{ color: 'var(--ink)' }}
                >
                  {t('export.csv.groupByTag')}
                </span>
                <Toggle
                  labelledBy={`${labelId}-csvGroup`}
                  checked={csvGroupByTag}
                  onChange={(v) => {
                    setCsvGroupByTag(v)
                    persistPrefs({ csvGroupByTag: v })
                  }}
                  disabled={busy}
                />
              </div>
              <span className="text-xs" style={{ color: 'var(--ink3)' }}>
                {t('export.csv.groupByTagHint')}
              </span>
            </div>
            <span className="text-sm font-medium" style={{ color: 'var(--ink2)' }}>
              {t('export.csv.format')}
            </span>
            <div className="flex gap-4">
              <label
                className="flex min-h-11 items-center gap-2 text-sm cursor-pointer"
                style={{ color: 'var(--ink)' }}
              >
                <input
                  type="radio"
                  name="csvFormat"
                  value="de"
                  checked={csvFormat === 'de'}
                  onChange={() => {
                    setCsvFormat('de')
                    persistPrefs({ csvFormat: 'de' })
                  }}
                  disabled={busy}
                  className={`h-4 w-4 accent-[var(--ink)] ${FOCUS}`}
                />
                <span>
                  DE{' '}
                  <span className="text-xs" style={{ color: 'var(--ink3)' }}>
                    {t('export.csv.formatDeHint')}
                  </span>
                </span>
              </label>
              <label
                className="flex min-h-11 items-center gap-2 text-sm cursor-pointer"
                style={{ color: 'var(--ink)' }}
              >
                <input
                  type="radio"
                  name="csvFormat"
                  value="us"
                  checked={csvFormat === 'us'}
                  onChange={() => {
                    setCsvFormat('us')
                    persistPrefs({ csvFormat: 'us' })
                  }}
                  disabled={busy}
                  className={`h-4 w-4 accent-[var(--ink)] ${FOCUS}`}
                />
                <span>
                  US{' '}
                  <span className="text-xs" style={{ color: 'var(--ink3)' }}>
                    {t('export.csv.formatUsHint')}
                  </span>
                </span>
              </label>
            </div>
            <p className="text-xs" style={{ color: 'var(--ink3)' }}>
              {t('export.csv.encodingNote')}
            </p>
          </div>
        )}

        {/* iCal-specific options (#135) */}
        {tab === 'ical' && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span
                  id={`${labelId}-icalClient`}
                  className="text-sm"
                  style={{ color: 'var(--ink)' }}
                >
                  {t('export.ical.showClientName')}
                </span>
                <Toggle
                  labelledBy={`${labelId}-icalClient`}
                  checked={icalShowClientName}
                  onChange={(v) => {
                    setIcalShowClientName(v)
                    persistPrefs({ icalShowClientName: v })
                  }}
                  disabled={busy}
                />
              </div>
              <span className="text-xs" style={{ color: 'var(--ink3)' }}>
                {t('export.ical.showClientNameHint')}
              </span>
            </div>
            <p className="text-xs" style={{ color: 'var(--ink3)' }}>
              {t('export.ical.privacyNote')}
            </p>
          </div>
        )}

        {/* Status message */}
        {statusMsg && (
          <div
            className={
              statusKind === 'error'
                ? 'rounded-[var(--r-key)] bg-[color-mix(in_srgb,_var(--danger)_8%,_transparent)] px-3 py-2 text-sm text-[var(--danger)]'
                : statusKind === 'success'
                  ? 'rounded-[var(--r-key)] bg-[var(--key)] px-3 py-2 text-sm text-[var(--ink2)]'
                  : 'rounded-[var(--r-key)] bg-[var(--key)] px-3 py-2 text-sm text-[var(--ink)]'
            }
            role={statusKind === 'error' ? 'alert' : 'status'}
          >
            {statusMsg}
          </div>
        )}

        {/* Footer */}
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-xs text-[var(--ink3)]">
            {tab === 'pdf' ? (
              <>
                {t('export.footer.pdfHint')}{' '}
                <span className="font-medium text-[var(--ink2)]">
                  {t('export.footer.pdfHintPath')}
                </span>
                .
              </>
            ) : tab === 'csv' ? (
              t('export.footer.csvHint')
            ) : (
              t('export.footer.icalHint')
            )}
          </p>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={onClose} disabled={busy} className={KEY}>
              {t('common.close')}
            </button>
            <button
              type="button"
              onClick={() =>
                void (tab === 'pdf'
                  ? handlePdfExport()
                  : tab === 'csv'
                    ? handleCsvExport()
                    : handleIcalExport())
              }
              disabled={!canExport}
              className={KEY_INV}
            >
              {busy
                ? t('export.button.busy')
                : tab === 'pdf'
                  ? t('export.button.pdf')
                  : tab === 'csv'
                    ? t('export.button.csv')
                    : t('export.button.ical')}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
