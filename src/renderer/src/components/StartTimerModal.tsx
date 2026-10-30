import { useEffect, useRef, useState } from 'react'
import { useTimer } from '../hooks/useTimer'
import { useT } from '../contexts/I18nContext'
import { useUiPrefsStore } from '../store/uiPrefsStore'
import { useTimerStore } from '../store/timerStore'
import { useToastStore } from '../store/toastStore'
import type { StartPrefill } from '../store/startTimerModalStore'
import * as Icons from './Icons'
import { Dialog } from './Dialog'
import { DescriptionInput } from './DescriptionInput'
import { FIELD_LABEL, INPUT, KEY_INV } from './instrumentClasses'
import type { Project } from '../../../shared/types'

interface StartTimerModalProps {
  open: boolean
  onClose: () => void
  /**
   * Preselect a client and project when the modal opens (B6: the START key
   * offers the last used pair, so Enter starts it). Omitted ⇒ the current
   * selection stays as it is. `projectId` null ⇒ explicitly "no project";
   * left out ⇒ the client only, its project chosen as if the user had just
   * picked that client (#297: the last project is archived).
   */
  prefill?: StartPrefill | null
}

export function StartTimerModal({
  open,
  onClose,
  prefill
}: StartTimerModalProps): React.JSX.Element | null {
  const t = useT()
  const showProjectNumber = useUiPrefsStore((s) => s.showProjectNumber)
  const showToast = useToastStore((s) => s.show)
  const {
    clients,
    selectedClientId,
    selectedProjectId,
    description,
    isLoading,
    setSelectedClientId,
    setSelectedProjectId,
    setDescription,
    start
  } = useTimer()

  const [projects, setProjects] = useState<Project[]>([])
  // A prefill that says "this client, no project" must not be overridden by
  // the single-project default below. Holds that client's id until another
  // client is chosen.
  const explicitNoProjectFor = useRef<number | null>(null)
  // B6: focus lands on the description, so Enter starts the prefilled pair.
  const descriptionRef = useRef<HTMLInputElement>(null)

  // B6: apply the prefill once per opening. Project first, so the project
  // loader below finds a valid preselection and keeps it.
  useEffect(() => {
    if (!open || !prefill) return
    explicitNoProjectFor.current = prefill.projectId === null ? prefill.clientId : null
    useTimerStore.getState().setSelectedProjectId(prefill.projectId ?? null)
    useTimerStore.getState().setSelectedClientId(prefill.clientId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on opening; a new prefill object per render must not reset the user's choice
  }, [open])

  // Load projects when client selection changes — only while open: App and
  // Heute each mount a modal, and a closed one must not rewrite the shared
  // selection (it would override the other one's prefill).
  useEffect(() => {
    if (!open) return
    if (!selectedClientId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- #142: dauerhaft — Teilfix möglich, der asynchrone Zweig bleibt Effect
      setProjects([])
      // The closure can be stale: a prefill applied in this same commit has
      // already chosen a client, and resetting its project here would undo it.
      if (useTimerStore.getState().selectedClientId === null) setSelectedProjectId(null)
      return
    }
    const requestedFor = selectedClientId
    void window.api.projects.getAll({ clientId: requestedFor }).then((res) => {
      // A prefill can switch the client between request and response (the
      // effect also ran once with the previous client) — an answer for a
      // client that is no longer selected must not touch the selection.
      if (useTimerStore.getState().selectedClientId !== requestedFor) return
      if (res.ok) {
        const active = res.data.filter((p) => p.active === 1)
        setProjects(active)
        const currentId = useTimerStore.getState().selectedProjectId
        if (currentId !== null && active.some((p) => p.id === currentId)) {
          // keep valid pre-selection — don't reset
        } else if (explicitNoProjectFor.current === selectedClientId) {
          // prefilled "no project" for this client — keep it
          setSelectedProjectId(null)
        } else if (active.length === 1) {
          setSelectedProjectId(active[0].id)
        } else {
          setSelectedProjectId(null)
        }
      }
    })
  }, [selectedClientId, open])

  if (!open) return null

  const activeClients = clients.filter((c) => c.active)
  const selectedClient = clients.find((c) => c.id === selectedClientId)
  const selectedProject = projects.find((p) => p.id === selectedProjectId)
  // Only an active client: a selection left from a client archived since is
  // not in the list above, so Enter must not book on it (#297).
  const canStart = selectedClient?.active === 1 && !isLoading

  function effectiveRateEuro(): number | null {
    if (selectedProject?.rate_cent != null) return selectedProject.rate_cent / 100
    if (selectedClient?.rate_cent) return selectedClient.rate_cent / 100
    return null
  }
  const effectiveRate = effectiveRateEuro()
  const showRateHint =
    selectedProject?.rate_cent != null &&
    selectedClient?.rate_cent != null &&
    selectedProject.rate_cent !== selectedClient.rate_cent

  async function handleStart(): Promise<void> {
    if (!canStart) return
    // start() switches when a timer runs; it checks synchronously, so this
    // read sees the same state.
    const switching = useTimerStore.getState().runningEntry !== null
    const error = await start()
    onClose()
    // The dialog closes either way; a refusal changed nothing, so say so.
    if (error) showToast(t(switching ? 'timer.switchFailed' : 'timer.startFailed', { error }))
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('timer.modal.title')}
      widthClass="w-[420px]"
      initialFocusRef={descriptionRef}
    >
      <div className="flex flex-col gap-4">
        {/* Client */}
        <div className="flex flex-col gap-1.5">
          <label className={FIELD_LABEL}>{t('timer.client.label')}</label>
          <div className="relative">
            <select
              aria-label={t('timer.client.label')}
              value={selectedClientId ?? ''}
              onChange={(e) => setSelectedClientId(e.target.value ? Number(e.target.value) : null)}
              className={`w-full appearance-none pr-9 ${INPUT}`}
            >
              <option value="">{t('timer.client.placeholder')}</option>
              {activeClients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <span
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--ink3)' }}
            >
              <Icons.ChevronDown />
            </span>
          </div>
          {activeClients.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--ink3)' }}>
              {t('timer.client.noClientsHint')}{' '}
              <span className="font-semibold text-[var(--ink)]">
                {t('timer.client.noClientsLink')}
              </span>
              {t('timer.client.noClientsSuffix')}
            </p>
          )}
        </div>

        {/* Project — only when client has projects */}
        {selectedClientId !== null && projects.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <label className={FIELD_LABEL}>{t('timer.project.label')}</label>
            <div className="relative">
              <select
                aria-label={t('timer.project.label')}
                value={selectedProjectId ?? ''}
                onChange={(e) =>
                  setSelectedProjectId(e.target.value ? Number(e.target.value) : null)
                }
                className={`w-full appearance-none pr-9 ${INPUT}`}
              >
                <option value="">{t('timer.project.placeholder')}</option>
                {projects.map((p) => {
                  const label =
                    showProjectNumber && p.external_project_number
                      ? `${p.name} [${p.external_project_number}]`
                      : p.name
                  return (
                    <option key={p.id} value={p.id}>
                      {label}
                    </option>
                  )
                })}
              </select>
              <span
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--ink3)' }}
              >
                <Icons.ChevronDown />
              </span>
            </div>
            {showRateHint && effectiveRate !== null && (
              <p className="text-xs" style={{ color: 'var(--ink3)' }}>
                {t('timer.project.effectiveRate', {
                  rate: effectiveRate.toLocaleString('de-DE', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                  })
                })}
              </p>
            )}
          </div>
        )}

        {/* Budget warning — shows when selected project is ≥80% consumed */}
        {selectedProject?.budget_minutes != null &&
          selectedProject.budget_minutes > 0 &&
          (() => {
            const usedMin = selectedProject.used_minutes ?? 0
            const budgetMin = selectedProject.budget_minutes
            const pct = Math.round((usedMin / budgetMin) * 100)
            if (pct < 80) return null
            const usedH = (usedMin / 60).toFixed(1)
            const totalH = (budgetMin / 60).toFixed(1)
            const over = usedMin > budgetMin
            return (
              <div
                className="flex items-start gap-2 rounded-[var(--r-key)] px-3 py-2.5 text-xs"
                style={{
                  background: over
                    ? 'color-mix(in srgb, var(--danger) 8%, transparent)'
                    : 'var(--key)',
                  color: over ? 'var(--danger)' : 'var(--ink)',
                  border: `1px solid ${over ? 'transparent' : 'var(--key-edge)'}`
                }}
              >
                <span className="shrink-0 mt-0.5">⚠</span>
                <span>
                  {over
                    ? t('timer.budget.overBudget', { used: usedH, total: totalH })
                    : t('timer.budget.warning', {
                        percent: String(pct),
                        used: usedH,
                        total: totalH
                      })}
                </span>
              </div>
            )
          })()}

        {/* Description */}
        <div className="flex flex-col gap-1.5">
          <label className={FIELD_LABEL}>{t('timer.description.label')}</label>
          {/* Q8: suggestions from the recent texts of the selected pair. */}
          <DescriptionInput
            placeholder={t('timer.description.placeholder')}
            value={description}
            onChange={setDescription}
            onEnter={() => void handleStart()}
            clientId={selectedClientId}
            projectId={selectedProjectId}
            inputRef={descriptionRef}
          />
        </div>

        {/* Start button */}
        <button
          type="button"
          onClick={() => void handleStart()}
          disabled={!canStart}
          className={`w-full ${KEY_INV}`}
        >
          <Icons.Play />
          {t('timer.modal.start')}
        </button>
      </div>
    </Dialog>
  )
}
