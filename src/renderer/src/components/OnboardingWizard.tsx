import { useState, useEffect } from 'react'
import { useT, useLocale } from '../contexts/I18nContext'
import type { TFunction } from '../contexts/I18nContext'
import type { Locale } from '../../../shared/i18n'
import type { BackupInfo } from '../../../shared/types'
import { Dialog } from './Dialog'
import { FOCUS, INPUT, KEY, KEY_INV } from './instrumentClasses'

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

  const inputClass = `w-full ${INPUT}`

  const stepTitle =
    step === 1
      ? t('onboarding.welcome.title')
      : step === 2
        ? t('onboarding.client.title')
        : step === 3
          ? t('onboarding.hotkey.title')
          : t('onboarding.restore.title')

  return (
    // Escape = skip, like the skip key: the caller persists completion either way.
    <Dialog
      open={open}
      onClose={onFinish}
      title={stepTitle}
      widthClass="w-full max-w-md"
      closeButton={false}
      closeOnBackdrop={false}
      titleAside={
        <button
          type="button"
          onClick={onFinish}
          className={`inline-flex min-h-11 items-center rounded-[var(--r-key)] px-2 text-xs text-[var(--ink3)] hover:text-[var(--ink)] ${FOCUS}`}
        >
          {t('onboarding.skip')}
        </button>
      }
    >
      <div className="flex flex-col gap-6">
        <StepScale step={step} total={TOTAL_STEPS} label={stepLabel} />

        {/* ── Step 1: Welcome + Language ── */}
        {step === 1 && (
          <>
            <div className="flex flex-col gap-3">
              {/* Logo / icon placeholder */}
              <div className="flex h-14 w-14 items-center justify-center rounded-[var(--r-key)] bg-[var(--inv)] text-3xl font-black text-[var(--inv-ink)] select-none">
                T
              </div>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--ink2)' }}>
                {t('onboarding.welcome.body')}
              </p>
            </div>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium" style={{ color: 'var(--ink2)' }}>
                {t('onboarding.welcome.languageLabel')}
              </span>
              <select
                value={locale}
                onChange={(e) => void setLocale(e.target.value as Locale)}
                className={inputClass}
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
              <p className="text-sm" style={{ color: 'var(--ink2)' }}>
                {t('onboarding.client.body')}
              </p>
            </div>

            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium" style={{ color: 'var(--ink2)' }}>
                  {t('onboarding.client.nameLabel')}
                </span>
                <input
                  type="text"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder={t('onboarding.client.namePlaceholder')}
                  className={inputClass}
                  autoFocus
                  disabled={clientBusy}
                />
              </label>

              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium" style={{ color: 'var(--ink2)' }}>
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
                    className={`w-28 ${INPUT}`}
                    disabled={clientBusy}
                  />
                  <span className="text-sm" style={{ color: 'var(--ink2)' }}>
                    {t('onboarding.client.rateUnit')}
                  </span>
                </div>
              </label>

              <div className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium" style={{ color: 'var(--ink2)' }}>
                  {t('onboarding.client.colorLabel')}
                </span>
                <div className="flex flex-wrap gap-2">
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setClientColor(c)}
                      title={c}
                      className={`h-7 w-7 rounded-[var(--r-fine)] ${FOCUS} ${
                        clientColor === c
                          ? 'ring-2 ring-[var(--ink)] ring-offset-2 ring-offset-[var(--bg)]'
                          : ''
                      }`}
                      style={{ background: c }}
                    />
                  ))}
                </div>
              </div>

              {clientError && (
                <p
                  className="rounded-[var(--r-key)] bg-[color-mix(in_srgb,_var(--danger)_8%,_transparent)] px-3 py-2 text-sm text-[var(--danger)]"
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
              <p className="text-sm" style={{ color: 'var(--ink2)' }}>
                {t('onboarding.hotkey.body')}
              </p>
            </div>

            <div className="flex flex-col gap-4">
              <HotkeyHint label={t('onboarding.hotkey.default', { hotkey: 'Alt+Shift+S' })} />
              <HotkeyHint label={t('onboarding.hotkey.mini', { hotkey: 'Alt+Shift+M' })} />
              <p className="text-xs" style={{ color: 'var(--ink3)' }}>
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
              <p className="text-sm" style={{ color: 'var(--ink2)' }}>
                {t('onboarding.restore.body')}
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <div className="rounded-[var(--r-key)] border border-[var(--line)] p-3 text-sm">
                <span className="font-medium" style={{ color: 'var(--ink2)' }}>
                  {t('onboarding.restore.latestLabel')}
                </span>{' '}
                <span className="font-num" style={{ color: 'var(--ink)' }}>
                  {new Date(availableBackups[0].createdAt).toLocaleString('de-DE')} ·{' '}
                  {(availableBackups[0].sizeBytes / 1024).toFixed(0)} KB
                </span>
              </div>

              {!restoreConfirmed ? (
                <button type="button" onClick={() => setRestoreConfirmed(true)} className={KEY}>
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
                  className={KEY_INV}
                >
                  {t('onboarding.restore.restoreBtn')}
                </button>
              )}
            </div>

            <div className="flex justify-between pt-2">
              <button
                type="button"
                onClick={onFinish}
                className={`inline-flex min-h-11 items-center rounded-[var(--r-key)] px-2 text-sm text-[var(--ink3)] hover:text-[var(--ink)] ${FOCUS}`}
              >
                {t('onboarding.restore.skip')}
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
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
      <button type="button" onClick={onNext} disabled={disabled} className={KEY_INV}>
        {label}
      </button>
    </div>
  )
}

function HotkeyHint({ label }: { label: string }): React.JSX.Element {
  // Extract and bold the hotkey token (looks like "Alt+Shift+S" or "Alt+Shift+M").
  const parts = label.split(/(\b[A-Z][a-zA-Z+]+[A-Z]\b)/)
  return (
    <div className="flex items-start gap-3 rounded-[var(--r-key)] border border-[var(--line)] px-4 py-3">
      <span className="mt-0.5 text-[var(--ink)]">⌨</span>
      <p className="text-sm" style={{ color: 'var(--ink2)' }}>
        {parts.map((part, i) =>
          /^[A-Z]/.test(part) && part.includes('+') ? (
            <kbd
              key={i}
              className="rounded-[var(--r-fine)] border border-[var(--key-edge)] bg-[var(--key)] px-1.5 py-0.5 font-num text-xs text-[var(--ink)] shadow-[var(--edge-key)]"
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

/**
 * Step indicator as ticks on a short scale (HANDOFF §5): one tick per step on
 * a `--tick` baseline; done and current ticks in `--ink`, the current one
 * taller. The "Schritt 1 von 3" text stays — the scale is decoration.
 */
function StepScale({
  step,
  total,
  label
}: {
  step: number
  total: number
  label: string
}): React.JSX.Element {
  return (
    <div className="flex items-end gap-3">
      <div aria-hidden className="flex h-3 items-end gap-2 border-b border-[var(--tick)]">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className="block w-px"
            style={{
              height: i + 1 === step ? 12 : 6,
              background: i + 1 <= step ? 'var(--ink)' : 'var(--tick)'
            }}
          />
        ))}
      </div>
      <p className="font-num text-[11px] text-[var(--ink3)]">{label}</p>
    </div>
  )
}
