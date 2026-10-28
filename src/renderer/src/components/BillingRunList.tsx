import { useEffect, useState } from 'react'
import type { BillingRunSummary } from '../../../main/billingRuns'
import { useLocale, useT } from '../contexts/I18nContext'
import { Dialog } from './Dialog'
import { INPUT, KEY, KEY_INV, LEGEND, SECTION } from './instrumentClasses'

interface Props {
  refreshKey: number
  onRebill: (run: BillingRunSummary) => void
}

export function BillingRunList({ refreshKey, onRebill }: Props): React.JSX.Element {
  const t = useT()
  const { locale } = useLocale()
  const [runs, setRuns] = useState<BillingRunSummary[] | null>(null)
  const [reload, setReload] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [releaseTarget, setReleaseTarget] = useState<BillingRunSummary | null>(null)
  const [reason, setReason] = useState('')
  const [releaseError, setReleaseError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void window.api.billingRuns
      .list()
      .then((res) => {
        if (!current) return
        if (res.ok) {
          setRuns(res.data)
          setError(null)
        } else {
          setError(res.error)
        }
      })
      .catch((e: unknown) => {
        if (current) setError(String(e))
      })
    return () => {
      current = false
    }
  }, [refreshKey, reload])

  async function openPdf(runId: number): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await window.api.billingRuns.open(runId)
      if (!res.ok) setError(res.error)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function release(): Promise<void> {
    if (!releaseTarget || busy) return
    if (!reason.trim()) {
      setReleaseError(t('billingRuns.reasonRequired'))
      return
    }
    setBusy(true)
    setReleaseError(null)
    try {
      const res = await window.api.billingRuns.release(releaseTarget.id, reason.trim())
      if (!res.ok) {
        setReleaseError(res.error)
        return
      }
      setReleaseTarget(null)
      setReload((n) => n + 1)
    } catch (e) {
      setReleaseError(String(e))
    } finally {
      setBusy(false)
    }
  }

  // A released run is re-billed once; its replacement names it in replaces_run_id.
  const replacedBy = new Map(
    (runs ?? []).filter((r) => r.replaces_run_id !== null).map((r) => [r.replaces_run_id, r])
  )

  return (
    <section className={`${SECTION} gap-3`}>
      <h2 className={LEGEND}>{t('billingRuns.title')}</h2>
      {error && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-[var(--danger)]">
            {t('export.status.error', { error })}
          </p>
          <button type="button" className={KEY} onClick={() => setReload((n) => n + 1)}>
            {t('common.retry')}
          </button>
        </div>
      )}
      {runs === null && !error && <p role="status">{t('common.loading')}</p>}
      {runs?.length === 0 && <p className="text-sm text-[var(--ink3)]">{t('billingRuns.empty')}</p>}
      <ul className="min-w-0">
        {runs?.map((run) => (
          <li
            key={run.id}
            className="flex min-w-0 flex-col gap-2 border-b border-[var(--line)] py-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-num text-sm text-[var(--ink)]">{run.number}</span>
              <span className="min-w-0 break-words text-sm text-[var(--ink)]">
                {run.client_name}
              </span>
            </div>
            <div className="flex flex-wrap justify-between gap-2 font-num text-sm text-[var(--ink2)]">
              <span>{t('billingRuns.period', { from: run.period_from, to: run.period_to })}</span>
              <span>
                {t('billingRuns.total', {
                  minutes: run.billed_minutes,
                  amount: new Intl.NumberFormat(locale, {
                    style: 'currency',
                    currency: 'EUR'
                  }).format(run.fee_cent / 100)
                })}
              </span>
            </div>
            <p className="break-words text-sm text-[var(--ink2)]">
              {run.status === 'active'
                ? t('billingRuns.active')
                : t('billingRuns.released', {
                    date: new Date(run.released_at!).toLocaleString(locale),
                    reason: run.release_reason ?? ''
                  })}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={KEY}
                disabled={busy}
                onClick={() => void openPdf(run.id)}
              >
                {t('billingRuns.openPdf')}
              </button>
              {run.status === 'active' ? (
                <button
                  type="button"
                  className={KEY}
                  disabled={busy}
                  onClick={() => {
                    setReason('')
                    setReleaseError(null)
                    setReleaseTarget(run)
                  }}
                >
                  {t('billingRuns.release')}
                </button>
              ) : replacedBy.has(run.id) ? (
                <p className="font-num text-sm text-[var(--ink2)]">
                  {t('billingRuns.replacedBy', { number: replacedBy.get(run.id)!.number })}
                </p>
              ) : (
                <button type="button" className={KEY} disabled={busy} onClick={() => onRebill(run)}>
                  {t('billingRuns.rebill')}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <Dialog
        open={releaseTarget !== null}
        onClose={() => {
          if (!busy) setReleaseTarget(null)
        }}
        title={t('billingRuns.release')}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void release()
          }}
        >
          <p className="font-num text-sm text-[var(--ink2)]">{releaseTarget?.number}</p>
          <label className="flex flex-col gap-1 text-sm text-[var(--ink)]">
            {t('billingRuns.reason')}
            <input
              className={INPUT}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
              aria-required="true"
            />
          </label>
          {releaseError && (
            <p role="alert" className="text-sm text-[var(--danger)]">
              {releaseError}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className={KEY}
              disabled={busy}
              onClick={() => setReleaseTarget(null)}
            >
              {t('common.cancel')}
            </button>
            <button type="submit" className={KEY_INV} disabled={busy}>
              {t('billingRuns.release')}
            </button>
          </div>
        </form>
      </Dialog>
    </section>
  )
}
