import { useState, useEffect } from 'react'
import { useT, useLocale } from '../contexts/I18nContext'
import type { TFunction } from '../contexts/I18nContext'
import type { Locale } from '../../../shared/i18n'
import type { BackupInfo } from '../../../shared/types'

interface Props {
  open: boolean
  onFinish: () => void
}

const BASE_STEPS = 3

// Default colors for new clients — same palette as ClientsView.
const PRESET_COLORS = [
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#f59e0b',
  '#10b981',
  '#06b6d4',
  '#f97316',
  '#84cc16'
]

/**
 * Onboarding wizard (v1.5 PR E, issue #32 / v1.9.5 #79).
 *
 * Step 1 — Welcome + language picker (live, uses I18nProvider)
 * Step 2 — Create first client (skippable)
 * Step 3 — Global hotkey hint
 * Step 4 — (optional) Restore from backup, shown only when backups exist
 *
 * All strings go through `t()` so DE/EN switching in step 1 immediately
 * reflects in subsequent steps.
 *
 * `onFinish` is called both by "Get started" and by "Skip" — the caller
 * is responsible for persisting `onboarding_completed = 1`.
 */
export function OnboardingWizard({ open, onFinish }: Props): React.JSX.Element | null {
  const t = useT()
  const { locale, setLocale } = useLocale()

  const [step, setStep] = useState(1)
  const [availableBackups, setAvailableBackups] = useState<BackupInfo[]>([])
  const [restoreConfirmed, setRestoreConfirmed] = useState(false)

  const TOTAL_STEPS = availableBackups.length > 0 ? BASE_STEPS + 1 : BASE_STEPS

  useEffect(() => {
    if (!open) return
    window.api.backups.list().then((res) => {
      if (res.ok && res.data.length > 0) setAvailableBackups(res.data)
    })
  }, [open])

  // Step 2 form state
  const [clientName, setClientName] = useState('')
  const [clientRate, setClientRate] = useState('')
  const [clientColor, setClientColor] = useState(PRESET_COLORS[0])
  const [clientBusy, setClientBusy] = useState(false)
  const [clientError, setClientError] = useState<string | null>(null)
  const [clientCreated, setClientCreated] = useState(false)

  if (!open) return null

  async function createClientAndNext(): Promise<void> {
    if (!clientName.trim()) {
      next()
      return
    }
    setClientBusy(true)
    setClientError(null)
    const rateCent = clientRate.trim()
      ? Math.round(parseFloat(clientRate.replace(',', '.')) * 100)
      : 0
    const res = await window.api.clients.create({
      name: clientName.trim(),
      color: clientColor,
      rate_cent: isNaN(rateCent) || rateCent < 0 ? 0 : rateCent
    })
    setClientBusy(false)
    if (res.ok) {
      setClientCreated(true)
      next()
    } else {
      setClientError(res.error)
    }
  }

  function next(): void {
    if (step < TOTAL_STEPS) setStep((s) => s + 1)
    else onFinish()
  }

  const stepLabel = t('onboarding.step', { current: step, total: TOTAL_STEPS })

  const inputClass =
    'rounded-[var(--r-key)] border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--focus)] w-full'
  const inputStyle = {
    background: 'var(--input-bg)',
    borderColor: 'var(--card-border)',
    color: 'var(--text)'
  } as React.CSSProperties

  return (
    // Full-screen overlay — sits above everything including UpdateBanner.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(0_0_0/0.35)]">
      <div
        className="relative flex w-full max-w-md flex-col gap-6 rounded-[var(--r-disp)] p-8 border"
        style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
      >
        {/* Skip link */}
        <button
          type="button"
          onClick={onFinish}
          className="absolute right-5 top-5 text-xs hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-[var(--focus)] rounded transition-opacity"
          style={{ color: 'var(--text3)' }}
        >
          {t('onboarding.skip')}
        </button>

        {/* Step indicator */}
        <p className="text-xs" style={{ color: 'var(--text3)' }}>
          {stepLabel}
        </p>

        {/* ── Step 1: Welcome + Language ── */}
        {step === 1 && (
          <>
            <div className="flex flex-col gap-3">
              {/* Logo / icon placeholder */}
              <div className="flex h-14 w-14 items-center justify-center rounded-[var(--r-disp)] bg-[var(--inv)] text-3xl font-black text-[var(--inv-ink)] select-none">
                T
              </div>
              <h1 className="text-2xl font-bold" style={{ color: 'var(--text)' }}>
                {t('onboarding.welcome.title')}
              </h1>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text2)' }}>
                {t('onboarding.welcome.body')}
              </p>
            </div>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium" style={{ color: 'var(--text2)' }}>
                {t('onboarding.welcome.languageLabel')}
              </span>
              <select
                value={locale}
                onChange={(e) => void setLocale(e.target.value as Locale)}
                className={inputClass}
                style={inputStyle}
              >
                <option value="de">{t('settings.language.de')}</option>
                <option value="en">{t('settings.language.en')}</option>
              </select>
            </label>

            <WizardFooter
              step={step}
              totalSteps={TOTAL_STEPS}
              onNext={next}
              onFinish={onFinish}
              t={t}
            />
          </>
        )}

        {/* ── Step 2: First Client ── */}
        {step === 2 && (
          <>
            <div className="flex flex-col gap-2">
              <h2 className="text-xl font-bold" style={{ color: 'var(--text)' }}>
                {t('onboarding.client.title')}
              </h2>
              <p className="text-sm" style={{ color: 'var(--text2)' }}>
                {t('onboarding.client.body')}
              </p>
            </div>

            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium" style={{ color: 'var(--text2)' }}>
                  {t('onboarding.client.nameLabel')}
                </span>
                <input
                  type="text"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder={t('onboarding.client.namePlaceholder')}
                  className={inputClass}
                  style={inputStyle}
                  autoFocus
                  disabled={clientBusy}
                />
              </label>

              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium" style={{ color: 'var(--text2)' }}>
                  {t('onboarding.client.rateLabel')}
                </span>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={clientRate}
                    onChange={(e) => setClientRate(e.target.value)}
                    placeholder={t('onboarding.client.ratePlaceholder')}
                    className="rounded-[var(--r-key)] border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--focus)] w-28"
                    style={{
                      background: 'var(--input-bg)',
                      borderColor: 'var(--card-border)',
                      color: 'var(--text)'
                    }}
                    disabled={clientBusy}
                  />
                  <span className="text-sm" style={{ color: 'var(--text2)' }}>
                    {t('onboarding.client.rateUnit')}
                  </span>
                </div>
              </label>

              <div className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium" style={{ color: 'var(--text2)' }}>
                  {t('onboarding.client.colorLabel')}
                </span>
                <div className="flex flex-wrap gap-2">
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setClientColor(c)}
                      title={c}
                      className={`h-7 w-7 rounded-[var(--r-fine)] ring-offset-2 transition-all focus:outline-none focus:ring-2 focus:ring-[var(--focus)] ${
                        clientColor === c ? 'ring-2 ring-[var(--ink)] scale-110' : 'hover:scale-105'
                      }`}
                      style={{ background: c }}
                    />
                  ))}
                </div>
              </div>

              {clientError && (
                <p
                  className="rounded-[var(--r-key)] bg-[var(--danger-bg)] px-3 py-2 text-sm text-[var(--danger)]"
                  role="alert"
                >
                  {clientError}
                </p>
              )}
            </div>

            <WizardFooter
              step={step}
              totalSteps={TOTAL_STEPS}
              onNext={() => void createClientAndNext()}
              onFinish={onFinish}
              nextLabel={clientName.trim() ? t('onboarding.client.create') : undefined}
              disabled={clientBusy}
              t={t}
            />
          </>
        )}

        {/* ── Step 3: Hotkey hint ── */}
        {step === 3 && (
          <>
            <div className="flex flex-col gap-2">
              <h2 className="text-xl font-bold" style={{ color: 'var(--text)' }}>
                {t('onboarding.hotkey.title')}
              </h2>
              <p className="text-sm" style={{ color: 'var(--text2)' }}>
                {t('onboarding.hotkey.body')}
              </p>
            </div>

            <div className="flex flex-col gap-4">
              <HotkeyHint label={t('onboarding.hotkey.default', { hotkey: 'Alt+Shift+S' })} />
              <HotkeyHint label={t('onboarding.hotkey.mini', { hotkey: 'Alt+Shift+M' })} />
              <p className="text-xs" style={{ color: 'var(--text3)' }}>
                {t('onboarding.hotkey.hint')}
              </p>

              {clientCreated && (
                <p className="rounded-[var(--r-key)] bg-[var(--key)] px-3 py-2 text-sm text-[var(--ink2)]">
                  ✓ {clientName} angelegt.
                </p>
              )}
            </div>

            <WizardFooter
              step={step}
              totalSteps={TOTAL_STEPS}
              onNext={next}
              onFinish={onFinish}
              t={t}
            />
          </>
        )}
        {/* ── Step 4: Restore ── */}
        {step === 4 && availableBackups.length > 0 && (
          <>
            <div className="flex flex-col gap-2">
              <h2 className="text-xl font-bold" style={{ color: 'var(--text)' }}>
                {t('onboarding.restore.title')}
              </h2>
              <p className="text-sm" style={{ color: 'var(--text2)' }}>
                {t('onboarding.restore.body')}
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <div
                className="rounded-[var(--r-key)] border p-3 text-sm"
                style={{ borderColor: 'var(--card-border)', background: 'var(--input-bg)' }}
              >
                <span className="font-medium" style={{ color: 'var(--text2)' }}>
                  {t('onboarding.restore.latestLabel')}
                </span>{' '}
                <span style={{ color: 'var(--text)' }}>
                  {new Date(availableBackups[0].createdAt).toLocaleString('de-DE')} ·{' '}
                  {(availableBackups[0].sizeBytes / 1024).toFixed(0)} KB
                </span>
              </div>

              {!restoreConfirmed ? (
                <button
                  type="button"
                  onClick={() => setRestoreConfirmed(true)}
                  className="rounded-[var(--r-key)] border px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
                  style={{ borderColor: 'var(--card-border)', color: 'var(--text)' }}
                >
                  {t('onboarding.restore.restoreBtn')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={async () => {
                    const res = await window.api.backups.restore(availableBackups[0].fullPath)
                    // Relaunch regardless: if restore failed, db.close() already ran in the
                    // main process so subsequent IPC calls would hit a closed DB anyway.
                    await window.api.app.relaunch()
                    if (!res.ok) console.error('[onboarding] Restore failed:', res.error)
                  }}
                  className="rounded-[var(--r-key)] bg-[var(--inv)] px-4 py-2 text-sm font-semibold text-[var(--inv-ink)] key-hover focus:outline-none focus:ring-2 focus:ring-[var(--focus)] transition-colors"
                >
                  {t('onboarding.restore.restoreBtn')}
                </button>
              )}
            </div>

            <div className="flex justify-between pt-2">
              <button
                type="button"
                onClick={onFinish}
                className="text-sm focus:outline-none focus:ring-2 focus:ring-[var(--focus)] rounded transition-opacity hover:opacity-80"
                style={{ color: 'var(--text3)' }}
              >
                {t('onboarding.restore.skip')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Small helper components ──────────────────────────────────────────────────

interface FooterProps {
  step: number
  totalSteps: number
  onNext: () => void
  onFinish: () => void
  nextLabel?: string
  disabled?: boolean
  t: TFunction
}

function WizardFooter({
  step,
  totalSteps,
  onNext,
  nextLabel,
  disabled,
  t
}: FooterProps): React.JSX.Element {
  const isLast = step === totalSteps
  const label = isLast ? t('onboarding.finish') : (nextLabel ?? t('onboarding.next'))

  return (
    <div className="flex justify-end pt-2">
      <button
        type="button"
        onClick={onNext}
        disabled={disabled}
        className="rounded-[var(--r-key)] bg-[var(--inv)] px-5 py-2 text-sm font-semibold text-[var(--inv-ink)] key-hover focus:outline-none focus:ring-2 focus:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
      >
        {label}
      </button>
    </div>
  )
}

function HotkeyHint({ label }: { label: string }): React.JSX.Element {
  // Extract and bold the hotkey token (looks like "Alt+Shift+S" or "Alt+Shift+M").
  const parts = label.split(/(\b[A-Z][a-zA-Z+]+[A-Z]\b)/)
  return (
    <div
      className="flex items-start gap-3 rounded-[var(--r-disp)] border px-4 py-3"
      style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
    >
      <span className="mt-0.5 text-[var(--ink)]">⌨</span>
      <p className="text-sm" style={{ color: 'var(--text2)' }}>
        {parts.map((part, i) =>
          /^[A-Z]/.test(part) && part.includes('+') ? (
            <kbd
              key={i}
              className="rounded px-1.5 py-0.5 font-num text-xs border"
              style={{
                background: 'var(--input-bg)',
                borderColor: 'var(--card-border)',
                color: 'var(--text)'
              }}
            >
              {part}
            </kbd>
          ) : (
            part
          )
        )}
      </p>
    </div>
  )
}
