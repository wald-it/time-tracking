import { useEffect, useId, useState } from 'react'
import type {
  RateRow,
  RateTarget,
  ProfileEditorData,
  RateEditorData
} from '../../../shared/rateEditor'
import { RATE_VALUE_ERROR } from '../../../shared/rateEditor'
import { formatRateInput, parseRateInput } from '../../../shared/rate'
import type { IpcResult } from '../../../shared/types'
import { useLocale, useT } from '../contexts/I18nContext'
import { FIELD_LABEL, INPUT, KEY, LEGEND, SECTION } from './instrumentClasses'
import { rateEditorError } from './rateEditorError'

/**
 * The editors save on their own, beside the surrounding form. The two save
 * paths lock each other: the form would otherwise send the old rate field
 * while a rate change is still pending, and the legacy trigger would add it
 * back for today.
 */
export function BillingEditors({
  target,
  disabled = false,
  onBusyChange,
  onRateSaved,
  onChanged
}: {
  target: RateTarget | null
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
  onRateSaved: (rate: number | null) => void
  onChanged: () => void
}): React.JSX.Element {
  const t = useT()
  const { locale } = useLocale()
  const id = useId()
  const [rows, setRows] = useState<RateRow[]>([])
  const [profile, setProfile] = useState<ProfileEditorData | null>(null)
  const [interval, setInterval] = useState('')
  const [minimum, setMinimum] = useState('')
  const [editing, setEditing] = useState<number | undefined>()
  const [date, setDate] = useState('')
  const [rate, setRate] = useState('')
  const [inherit, setInherit] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const kind = target?.kind
  const targetId = target?.id

  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  useEffect(() => {
    if (!kind || targetId === undefined) return
    let active = true
    Promise.all([
      window.api.rates.list({ kind, id: targetId }),
      window.api.billingProfile.get({ kind, id: targetId })
    ])
      .then(([rates, billing]) => {
        if (!active) return
        if (!rates.ok) {
          setError(rateEditorError(rates.error, t))
          return
        }
        if (!billing.ok) {
          setError(rateEditorError(billing.error, t))
          return
        }
        setRows(rates.data.rows)
        setProfile(billing.data)
        setInterval(billing.data.interval_min?.toString() ?? '')
        setMinimum(billing.data.min_unit_min?.toString() ?? '')
        setLoaded(true)
      })
      .catch(() => {
        if (active) setError(t('clients.form.saveFailed'))
      })
    return () => {
      active = false
    }
  }, [kind, targetId, t])

  function reset(): void {
    setEditing(undefined)
    setDate('')
    setRate('')
    setInherit(false)
  }

  async function writeRate(action: () => Promise<IpcResult<RateEditorData>>): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const result = await action()
      if (!result.ok) {
        setError(rateEditorError(result.error, t))
        return
      }
      setRows(result.data.rows)
      onRateSaved(result.data.current_rate_cent)
      onChanged()
      reset()
    } catch {
      setError(t('clients.form.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  function saveRate(): void {
    if (!target) return
    const value = parseRateInput(rate)
    if (!inherit && (rate.trim() === '' || typeof value !== 'number')) {
      setError(rateEditorError(RATE_VALUE_ERROR, t))
      return
    }
    void writeRate(() =>
      window.api.rates.save(target, {
        id: editing,
        valid_from: date,
        rate_cent: inherit ? null : (value as number)
      })
    )
  }

  async function saveProfile(): Promise<void> {
    if (!target) return
    setBusy(true)
    setError('')
    try {
      const result = await window.api.billingProfile.save(target, {
        interval_min: interval.trim() === '' ? null : Number(interval),
        min_unit_min: minimum.trim() === '' ? null : Number(minimum)
      })
      if (!result.ok) {
        setError(rateEditorError(result.error, t))
        return
      }
      setProfile(result.data)
      onChanged()
    } catch {
      setError(t('clients.form.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const baseline =
    target?.kind === 'client' && rows.find((r) => r.id === editing)?.valid_from === '0001-01-01'
  return (
    <>
      <section className={SECTION} aria-label={t('rates.title')}>
        <h2 className={LEGEND}>{t('rates.title')}</h2>
        {!target ? (
          <p className="mt-2 text-xs text-[var(--ink3)]">{t('rates.saveFirst')}</p>
        ) : (
          <>
            <p className="my-2 text-xs text-[var(--ink3)]">{t('rates.immediate')}</p>
            <fieldset
              disabled={busy || disabled || !loaded}
              className="min-w-0"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
                  event.preventDefault()
                  saveRate()
                }
              }}
            >
              <table className="w-full text-left text-sm">
                <thead className={FIELD_LABEL}>
                  <tr>
                    <th scope="col">{t('rates.validFrom')}</th>
                    <th scope="col">{t('rates.hourly')}</th>
                    <th scope="col">
                      <span className="sr-only">{t('rates.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b border-[var(--line)]">
                      <td className="font-num">{row.valid_from}</td>
                      <td className="font-num">
                        {row.rate_cent === null
                          ? t('rates.clientRate')
                          : new Intl.NumberFormat(locale, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2
                            }).format(row.rate_cent / 100)}
                      </td>
                      <td>
                        <div className="flex justify-end gap-1 py-1">
                          <button
                            type="button"
                            className={`${KEY} px-2`}
                            aria-label={t('rates.editRow', { date: row.valid_from })}
                            onClick={() => {
                              setEditing(row.id)
                              setDate(row.valid_from)
                              setRate(
                                row.rate_cent === null ? '' : formatRateInput(row.rate_cent) || '0'
                              )
                              setInherit(row.rate_cent === null)
                              setError('')
                            }}
                          >
                            {t('rates.edit')}
                          </button>
                          <button
                            type="button"
                            className={`${KEY} px-2`}
                            aria-label={t('rates.deleteRow', { date: row.valid_from })}
                            disabled={
                              target.kind === 'client' &&
                              (row.valid_from === '0001-01-01' || rows.length <= 1)
                            }
                            onClick={() =>
                              void writeRate(() => window.api.rates.delete(target, row.id))
                            }
                          >
                            {t('rates.delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className={FIELD_LABEL}>{t('rates.validFrom')}</span>
                  <input
                    type="date"
                    min="0001-01-01"
                    max="9999-12-31"
                    value={date}
                    disabled={baseline}
                    onChange={(e) => setDate(e.target.value)}
                    className={`${INPUT} min-w-0 font-num`}
                  />
                </label>
                <label className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className={FIELD_LABEL}>{t('rates.hourly')}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={rate}
                    disabled={inherit}
                    onChange={(e) => setRate(e.target.value)}
                    className={`${INPUT} w-full font-num`}
                  />
                </label>
                {target.kind === 'project' && (
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={inherit}
                      onChange={(e) => setInherit(e.target.checked)}
                    />
                    {t('rates.clientRate')}
                  </label>
                )}
              </div>
              <div className="my-3 flex gap-2">
                <button type="button" className={KEY} onClick={saveRate}>
                  {t(editing === undefined ? 'rates.add' : 'rates.saveRow')}
                </button>
                {editing !== undefined && (
                  <button type="button" className={KEY} onClick={reset}>
                    {t('common.cancel')}
                  </button>
                )}
              </div>
            </fieldset>
          </>
        )}
      </section>
      <section className={SECTION} aria-label={t('rates.billing')}>
        <h2 className={LEGEND}>{t('rates.billing')}</h2>
        {!target ? (
          <p className="mt-2 text-xs text-[var(--ink3)]">{t('rates.saveFirst')}</p>
        ) : (
          <fieldset
            disabled={busy || disabled || !loaded}
            className="min-w-0"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
                event.preventDefault()
                void saveProfile()
              }
            }}
          >
            <p className="my-2 text-xs text-[var(--ink3)]">{t('rates.inheritHint')}</p>
            <div className="flex gap-3">
              <label htmlFor={`${id}-interval`} className="flex min-w-0 flex-1 flex-col gap-1">
                <span className={FIELD_LABEL}>{t('rates.interval')}</span>
                <input
                  id={`${id}-interval`}
                  type="number"
                  min="0"
                  max="60"
                  step="1"
                  value={interval}
                  placeholder={String(profile?.inherited.interval_min ?? 0)}
                  onChange={(e) => setInterval(e.target.value)}
                  className={`${INPUT} min-w-0 font-num`}
                />
              </label>
              <label htmlFor={`${id}-minimum`} className="flex min-w-0 flex-1 flex-col gap-1">
                <span className={FIELD_LABEL}>{t('rates.minimum')}</span>
                <input
                  id={`${id}-minimum`}
                  type="number"
                  min="0"
                  step="1"
                  value={minimum}
                  placeholder={String(profile?.inherited.min_unit_min ?? 0)}
                  onChange={(e) => setMinimum(e.target.value)}
                  className={`${INPUT} min-w-0 font-num`}
                />
              </label>
            </div>
            <button type="button" className={`${KEY} mt-3`} onClick={() => void saveProfile()}>
              {t('rates.saveProfile')}
            </button>
          </fieldset>
        )}
      </section>
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </>
  )
}
