import { useEffect, useRef, useState } from 'react'
import { useT } from '../contexts/I18nContext'
import { Dialog } from './Dialog'
import { detectFilePurpose } from './pdfMergeUtils'

const basename = (p: string): string => p.replace(/.*[\\/]/, '')

// v1.13 #119: switched from single path to an array of paths. Legacy key is
// migrated on first open and then dropped.
const LS_SN_PATHS_KEY = 'pdfMerge.lastSnPaths'
const LS_SN_LEGACY_KEY = 'pdfMerge.lastSnPath'
const LS_INV_KEY = 'pdfMerge.lastInvPath'

interface SnEntry {
  id: number
  path: string
  pages: number | null
}

interface Props {
  open: boolean
  onClose: () => void
}

function loadStoredSnPaths(): string[] {
  const rawNew = localStorage.getItem(LS_SN_PATHS_KEY)
  if (rawNew) {
    try {
      const parsed = JSON.parse(rawNew)
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
        return parsed
      }
    } catch {
      // fall through to legacy / empty
    }
  }
  // Migrate the legacy single-path key into the new array key on first read.
  const legacy = localStorage.getItem(LS_SN_LEGACY_KEY)
  if (legacy) {
    localStorage.setItem(LS_SN_PATHS_KEY, JSON.stringify([legacy]))
    localStorage.removeItem(LS_SN_LEGACY_KEY)
    return [legacy]
  }
  return []
}

function persistSnPaths(paths: string[]): void {
  if (paths.length === 0) {
    localStorage.removeItem(LS_SN_PATHS_KEY)
  } else {
    localStorage.setItem(LS_SN_PATHS_KEY, JSON.stringify(paths))
  }
}

export function PdfMergeModal({ open, onClose }: Props): React.JSX.Element {
  const t = useT()
  const [snEntries, setSnEntries] = useState<SnEntry[]>([])
  const [invPath, setInvPath] = useState<string | null>(null)
  const [invPages, setInvPages] = useState<number | null>(null)
  // Swap-offer is only shown when the swap target is unambiguous:
  //  - 'sn'       → invoice slot holds an SN-looking file (single invoice slot)
  //  - 'invoice'  → an SN slot holds an invoice-looking file AND invoice is empty
  const [swapOffer, setSwapOffer] = useState<
    { kind: 'sn' } | { kind: 'invoice'; snId: number } | null
  >(null)
  const [busy, setBusy] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [statusKind, setStatusKind] = useState<'info' | 'error' | 'success'>('info')

  // Version refs prevent stale pdf:pdf-info responses from overwriting newer
  // picks. Each SN slot has its own counter keyed by stable id so adding/
  // removing entries doesn't race.
  const snInfoVersions = useRef<Map<number, number>>(new Map())
  const snEntryIdCounter = useRef(0)
  const invInfoVersion = useRef(0)

  function nextSnId(): number {
    snEntryIdCounter.current += 1
    return snEntryIdCounter.current
  }

  // Pre-fill from localStorage on open. Any failure = treat path as gone.
  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- #142: dauerhaft — Reset plus asynchroner localStorage-/Seitenzahl-Pfad, Aufrufer übergibt kein key
    setStatusMsg(null)
    setStatusKind('info')
    setBusy(false)
    setSwapOffer(null)

    const storedSnPaths = loadStoredSnPaths()
    const storedInv = localStorage.getItem(LS_INV_KEY)

    if (storedSnPaths.length > 0) {
      const initial: SnEntry[] = storedSnPaths.map((path) => ({
        id: nextSnId(),
        path,
        pages: null
      }))
      setSnEntries(initial)

      initial.forEach(({ id, path }) => {
        const v = (snInfoVersions.current.get(id) ?? 0) + 1
        snInfoVersions.current.set(id, v)
        void window.api.pdf.pdfInfo({ filePath: path }).then((res) => {
          if (snInfoVersions.current.get(id) !== v) return
          if (res.ok) {
            setSnEntries((entries) => {
              const entryIdx = entries.findIndex((e) => e.id === id)
              if (entryIdx === -1) return entries
              const next = entries.slice()
              next[entryIdx] = { ...next[entryIdx], pages: res.data.pageCount }
              return next
            })
          } else {
            // File gone — drop entry and re-persist.
            setSnEntries((entries) => {
              const entryIdx = entries.findIndex((e) => e.id === id)
              if (entryIdx === -1) return entries
              const next = entries.slice()
              next.splice(entryIdx, 1)
              persistSnPaths(next.map((e) => e.path))
              return next
            })
            snInfoVersions.current.delete(id)
          }
        })
      })
    } else {
      setSnEntries([])
    }

    if (storedInv) {
      invInfoVersion.current++
      const v = invInfoVersion.current
      void window.api.pdf.pdfInfo({ filePath: storedInv }).then((res) => {
        if (invInfoVersion.current !== v) return
        if (res.ok) {
          setInvPath(storedInv)
          setInvPages(res.data.pageCount)
        } else {
          localStorage.removeItem(LS_INV_KEY)
        }
      })
    }
  }, [open])

  // ── SN slot operations ────────────────────────────────────────────────────

  async function addSnFile(filePath: string): Promise<void> {
    const id = nextSnId()
    setSnEntries((entries) => {
      const next = [...entries, { id, path: filePath, pages: null }]
      persistSnPaths(next.map((e) => e.path))
      return next
    })
    setStatusMsg(null)

    // Offer swap only when the swap target is unambiguous: invoice slot empty.
    const purpose = detectFilePurpose(basename(filePath))
    if (purpose === 'invoice' && !invPath) {
      setSwapOffer({ kind: 'invoice', snId: id })
    }

    const v = (snInfoVersions.current.get(id) ?? 0) + 1
    snInfoVersions.current.set(id, v)
    const res = await window.api.pdf.pdfInfo({ filePath })
    if (snInfoVersions.current.get(id) !== v) return
    if (res.ok) {
      setSnEntries((entries) => {
        const entryIdx = entries.findIndex((e) => e.id === id)
        if (entryIdx === -1) return entries
        const next = entries.slice()
        next[entryIdx] = { ...next[entryIdx], pages: res.data.pageCount }
        return next
      })
    } else {
      setSnEntries((entries) => {
        const entryIdx = entries.findIndex((e) => e.id === id)
        if (entryIdx === -1) return entries
        const next = entries.slice()
        next.splice(entryIdx, 1)
        persistSnPaths(next.map((e) => e.path))
        return next
      })
      snInfoVersions.current.delete(id)
      setStatusKind('error')
      setStatusMsg(t('merge.status.snError', { error: res.error }))
    }
  }

  function removeSnEntry(id: number): void {
    setSnEntries((entries) => {
      const next = entries.filter((e) => e.id !== id)
      if (next.length === entries.length) return entries
      persistSnPaths(next.map((e) => e.path))
      return next
    })
    snInfoVersions.current.delete(id)
    setSwapOffer(null)
  }

  async function loadInvoiceInfo(filePath: string): Promise<void> {
    invInfoVersion.current++
    const v = invInfoVersion.current
    setInvPath(filePath)
    setInvPages(null)
    setSwapOffer(null)
    setStatusMsg(null)
    localStorage.setItem(LS_INV_KEY, filePath)

    const purpose = detectFilePurpose(basename(filePath))
    if (purpose === 'sn') setSwapOffer({ kind: 'sn' })

    const res = await window.api.pdf.pdfInfo({ filePath })
    if (invInfoVersion.current !== v) return
    if (res.ok) {
      setInvPages(res.data.pageCount)
    } else {
      setInvPath(null)
      setInvPages(null)
      setStatusKind('error')
      setStatusMsg(t('merge.status.invError', { error: res.error }))
      localStorage.removeItem(LS_INV_KEY)
    }
  }

  async function handlePickFile(slot: 'sn' | 'invoice'): Promise<void> {
    const res = await window.api.pdf.openPdfDialog()
    if (!res.ok) {
      setStatusKind('error')
      setStatusMsg(t('merge.status.openError', { error: res.error }))
      return
    }
    if (res.data === null) return
    if (slot === 'sn') {
      void addSnFile(res.data.filePath)
    } else {
      void loadInvoiceInfo(res.data.filePath)
    }
  }

  function executeSwap(): void {
    if (!swapOffer) return
    if (swapOffer.kind === 'sn') {
      // Invoice slot held an SN-looking file → move it to the SN list.
      if (!invPath) return
      const movedPath = invPath
      const movedPages = invPages
      setInvPath(null)
      setInvPages(null)
      localStorage.removeItem(LS_INV_KEY)
      const id = nextSnId()
      setSnEntries((entries) => {
        const next = [...entries, { id, path: movedPath, pages: movedPages }]
        persistSnPaths(next.map((e) => e.path))
        return next
      })
    } else {
      // An SN slot held an invoice-looking file → promote it to the invoice slot.
      const targetId = swapOffer.snId
      const entry = snEntries.find((e) => e.id === targetId)
      if (!entry) {
        setSwapOffer(null)
        return
      }
      setInvPath(entry.path)
      setInvPages(entry.pages)
      localStorage.setItem(LS_INV_KEY, entry.path)
      setSnEntries((entries) => {
        const next = entries.filter((e) => e.id !== targetId)
        persistSnPaths(next.map((e) => e.path))
        return next
      })
      snInfoVersions.current.delete(targetId)
    }
    setSwapOffer(null)
  }

  async function handleMerge(): Promise<void> {
    if (snEntries.length === 0 || !invPath) return
    setBusy(true)
    setStatusMsg(t('merge.status.merging'))
    setStatusKind('info')

    const res = await window.api.pdf.mergeOnly({
      stundennachweisPaths: snEntries.map((e) => e.path),
      invoicePath: invPath
    })
    setBusy(false)

    if (res.ok) {
      setStatusKind('success')
      setStatusMsg(res.data.path)
    } else if (res.error === 'Speichern abgebrochen') {
      setStatusKind('info')
      setStatusMsg(null)
    } else {
      setStatusKind('error')
      setStatusMsg(t('merge.status.error', { error: res.error }))
    }
  }

  const allSnPagesLoaded = snEntries.every((e) => e.pages !== null)
  const canMerge =
    snEntries.length > 0 && invPath !== null && allSnPagesLoaded && invPages !== null && !busy

  const successPath = statusKind === 'success' ? statusMsg : null

  const snPagesTotal = snEntries.reduce((sum, e) => sum + (e.pages ?? 0), 0)
  const totalPages = invPages !== null && allSnPagesLoaded ? invPages + snPagesTotal : null

  return (
    <Dialog open={open} onClose={onClose} title={t('merge.title')} widthClass="w-[520px]">
      <div className="flex flex-col gap-4">
        {/* Stundennachweis slots */}
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium" style={{ color: 'var(--ink2)' }}>
            {t('merge.sn.label')}
          </span>
          {snEntries.map((entry, idx) => {
            const isOnlyEntry = snEntries.length === 1
            return (
              <div
                key={entry.id}
                className="flex flex-col gap-1 rounded-[var(--r-key)] border px-3 py-2"
                style={{ borderColor: 'var(--line)', background: 'var(--key)' }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium" style={{ color: 'var(--ink2)' }}>
                    {isOnlyEntry
                      ? t('merge.sn.slotSingle')
                      : t('merge.sn.slot', { n: String(idx + 1) })}
                  </span>
                  <span
                    className="flex-1 max-w-[280px] truncate text-xs"
                    style={{ color: 'var(--ink3)' }}
                  >
                    {basename(entry.path)}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeSnEntry(entry.id)}
                    disabled={busy}
                    className="rounded px-2 py-0.5 text-xs hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-[var(--focus)] disabled:opacity-50"
                    style={{ color: 'var(--ink3)' }}
                    aria-label={t('merge.sn.remove')}
                    title={t('merge.sn.remove')}
                  >
                    ×
                  </button>
                </div>
                <span className="text-xs" style={{ color: 'var(--ink3)' }}>
                  {entry.pages === null
                    ? t('merge.sn.loading')
                    : entry.pages === 1
                      ? t('merge.sn.pages.one')
                      : t('merge.sn.pages.other', { count: String(entry.pages) })}
                </span>
                {swapOffer?.kind === 'invoice' && swapOffer.snId === entry.id && (
                  <div className="flex items-center gap-2 rounded-[var(--r-key)] bg-[var(--key)] border border-[var(--key-edge)] px-3 py-1.5 text-xs text-[var(--ink)]">
                    <span>{t('merge.inv.swapOffer')}</span>
                    <button
                      type="button"
                      onClick={executeSwap}
                      className="font-semibold underline hover:text-[var(--ink)]"
                    >
                      {t('merge.swap')}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handlePickFile('sn')}
              disabled={busy}
              className="rounded-[var(--r-key)] border px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--focus)] disabled:opacity-50 hover:opacity-80"
              style={{
                background: 'var(--key)',
                borderColor: 'var(--line)',
                color: 'var(--ink2)'
              }}
            >
              {snEntries.length === 0 ? t('merge.sn.pick') : t('merge.sn.add')}
            </button>
            {snEntries.length === 0 && (
              <span className="text-xs" style={{ color: 'var(--ink3)' }}>
                {t('merge.sn.noFile')}
              </span>
            )}
          </div>
        </div>

        {/* Invoice slot */}
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium" style={{ color: 'var(--ink2)' }}>
            {t('merge.inv.label')}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handlePickFile('invoice')}
              disabled={busy}
              className="rounded-[var(--r-key)] border px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--focus)] disabled:opacity-50 hover:opacity-80"
              style={{
                background: 'var(--key)',
                borderColor: 'var(--line)',
                color: 'var(--ink2)'
              }}
            >
              {invPath ? t('merge.sn.change') : t('merge.sn.pick')}
            </button>
            <span className="max-w-[260px] truncate text-xs" style={{ color: 'var(--ink3)' }}>
              {invPath ? basename(invPath) : t('merge.sn.noFile')}
            </span>
          </div>
          {invPath && (
            <span className="text-xs" style={{ color: 'var(--ink3)' }}>
              {invPages === null
                ? t('merge.sn.loading')
                : invPages === 1
                  ? t('merge.sn.pages.one')
                  : t('merge.sn.pages.other', { count: String(invPages) })}
            </span>
          )}
          {swapOffer?.kind === 'sn' && (
            <div className="flex items-center gap-2 rounded-[var(--r-key)] bg-[var(--key)] border border-[var(--key-edge)] px-3 py-1.5 text-xs text-[var(--ink)]">
              <span>{t('merge.sn.swapOffer')}</span>
              <button
                type="button"
                onClick={executeSwap}
                className="font-semibold underline hover:text-[var(--ink)]"
              >
                {t('merge.swap')}
              </button>
            </div>
          )}
        </div>

        {/* Total page preview */}
        {totalPages !== null && (
          <div
            className="rounded-[var(--r-key)] px-3 py-2 text-sm border"
            style={{
              background: 'var(--key)',
              borderColor: 'var(--line)',
              color: 'var(--ink2)'
            }}
          >
            {snEntries.length === 1
              ? t('merge.preview', {
                  inv: String(invPages),
                  sn: String(snPagesTotal),
                  total: String(totalPages)
                })
              : t('merge.preview.multi', {
                  inv: String(invPages),
                  count: String(snEntries.length),
                  sn: String(snPagesTotal),
                  total: String(totalPages)
                })}
          </div>
        )}

        {/* Status messages */}
        {statusMsg && statusKind !== 'success' && (
          <div
            className={
              statusKind === 'error'
                ? 'rounded-[var(--r-key)] bg-[color-mix(in_srgb,_var(--danger)_8%,_transparent)] px-3 py-2 text-sm text-[var(--danger)]'
                : 'rounded-[var(--r-key)] px-3 py-2 text-sm border'
            }
            style={
              statusKind !== 'error'
                ? {
                    background: 'var(--key)',
                    borderColor: 'var(--line)',
                    color: 'var(--ink2)'
                  }
                : undefined
            }
            role={statusKind === 'error' ? 'alert' : undefined}
            aria-live="polite"
          >
            {statusMsg}
          </div>
        )}

        {/* Success state */}
        {successPath && (
          <div className="rounded-[var(--r-key)] bg-[var(--key)] px-3 py-2 text-sm text-[var(--ink2)]">
            <div className="font-medium">{t('merge.success.title')}</div>
            <div className="mt-0.5 truncate text-xs text-[var(--ink2)]">
              {basename(successPath)}
            </div>
            <button
              type="button"
              onClick={() => void window.api.shell.showItemInFolder(successPath)}
              className="mt-1 text-xs underline text-[var(--ink2)] hover:text-[var(--ink)]"
            >
              {t('merge.success.showInExplorer')}
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-[var(--r-key)] border px-4 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-[var(--focus)] disabled:opacity-50 hover:opacity-80"
            style={{
              background: 'var(--key)',
              borderColor: 'var(--line)',
              color: 'var(--ink2)'
            }}
          >
            {t('common.close')}
          </button>
          <button
            type="button"
            onClick={() => void handleMerge()}
            disabled={!canMerge}
            className="rounded-[var(--r-key)] px-4 py-2 text-sm font-semibold text-[var(--inv-ink)] focus:outline-none focus:ring-2 focus:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50 hover:opacity-90"
            style={{ background: 'var(--inv)' }}
          >
            {busy ? t('merge.button.merging') : t('merge.button.merge')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
