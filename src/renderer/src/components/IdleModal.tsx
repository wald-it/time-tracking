import { useEffect, useRef, useState } from 'react'
import { Dialog } from './Dialog'
import { FIELD_LABEL, INPUT, KEY, KEY_INV } from './instrumentClasses'
import { formatDuration } from '../../../shared/duration'
import { useT } from '../contexts/I18nContext'
import type { Client, Project } from '../../../shared/types'

interface Props {
  idleSince: string
  idleSeconds: number
  onKeep: () => void
  onStopAtIdle: () => void
  onMarkPause: () => void
  onWorkFor: (clientId: number, projectId: number | null) => void
  clients: Client[]
  runningClientId: number | null
  isLoading: boolean
}

export function IdleModal({
  idleSince,
  idleSeconds,
  onKeep,
  onStopAtIdle,
  onMarkPause,
  onWorkFor,
  clients,
  runningClientId,
  isLoading
}: Props): React.JSX.Element | null {
  const t = useT()
  const keepRef = useRef<HTMLButtonElement>(null)
  const workRef = useRef<HTMLButtonElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [clientId, setClientId] = useState<number | null>(null)
  const [projectId, setProjectId] = useState<number | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [recentClientId, setRecentClientId] = useState<number | null>(null)
  const [clientChosen, setClientChosen] = useState(false)
  const activeClients = clients.filter((c) => c.active === 1)
  const defaultClientId =
    activeClients.find((c) => c.id === recentClientId)?.id ??
    activeClients.find((c) => c.id !== runningClientId)?.id ??
    activeClients.find((c) => c.id === runningClientId)?.id ??
    null
  const selectedClientId = clientChosen ? clientId : defaultClientId

  useEffect(() => {
    let cancelled = false
    // The dashboard's last five entries (newest first) are enough for "the
    // last other client": reading each client's whole history would scale
    // with the database. Without a hit the list-order fallback applies.
    const active = new Set(clients.filter((c) => c.active === 1).map((c) => c.id))
    void window.api.dashboard
      .summary()
      .then((res) => {
        if (cancelled || !res.ok) return
        const recent = res.data.recentEntries.find(
          (e) => e.client_id !== runningClientId && active.has(e.client_id)
        )
        setRecentClientId(recent?.client_id ?? null)
      })
      .catch(() => {
        /* Keep the list-order fallback when the read fails. */
      })
    return () => {
      cancelled = true
    }
  }, [clients, runningClientId])

  useEffect(() => {
    if (!pickerOpen || selectedClientId === null) return
    let cancelled = false
    void window.api.projects.getAll({ clientId: selectedClientId }).then((res) => {
      if (!cancelled && res.ok) setProjects(res.data)
    })
    return () => {
      cancelled = true
    }
  }, [pickerOpen, selectedClientId])

  const availableProjects = projects.filter(
    (p) =>
      p.client_id === selectedClientId &&
      (p.status !== undefined ? p.status !== 'archived' : p.active === 1)
  )

  function collapsePicker(): void {
    setPickerOpen(false)
    workRef.current?.focus()
  }

  const idleSinceLocal = new Date(idleSince).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit'
  })

  return (
    <Dialog
      open
      // While a booking runs, nothing may close the dialog or start a second action.
      onClose={isLoading ? () => {} : pickerOpen ? collapsePicker : onKeep}
      title={t('idle.title')}
      initialFocusRef={keepRef}
      closeButton={false}
      closeOnBackdrop={false}
    >
      <p className="mb-6 text-sm text-[var(--ink2)]">
        {t('idle.body', { time: idleSinceLocal, duration: formatDuration(idleSeconds) })}
      </p>
      <div className="flex flex-col gap-2">
        <button
          ref={keepRef}
          type="button"
          onClick={onKeep}
          disabled={isLoading}
          className={KEY_INV}
        >
          {t('idle.keep')}
        </button>
        <button type="button" onClick={onStopAtIdle} disabled={isLoading} className={KEY}>
          {t('idle.stopAtIdle', { time: idleSinceLocal })}
        </button>
        <button type="button" onClick={onMarkPause} disabled={isLoading} className={KEY}>
          {t('idle.markPause')}
        </button>
        <button
          ref={workRef}
          type="button"
          className={KEY}
          disabled={isLoading}
          aria-expanded={pickerOpen}
          onClick={() => {
            setClientChosen(false)
            setProjectId(null)
            setPickerOpen(true)
          }}
        >
          {t('idle.workFor')}
        </button>
        {pickerOpen && (
          <div className="flex flex-col gap-2 mt-2">
            <label className={FIELD_LABEL}>
              {t('idle.client')}
              <select
                className={`w-full ${INPUT}`}
                value={selectedClientId ?? ''}
                disabled={isLoading}
                onChange={(e) => {
                  setClientChosen(true)
                  setClientId(e.target.value ? Number(e.target.value) : null)
                  setProjectId(null)
                  setProjects([])
                }}
              >
                <option value="">{t('idle.chooseClient')}</option>
                {activeClients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={FIELD_LABEL}>
              {t('idle.project')}
              <select
                className={`w-full ${INPUT}`}
                value={projectId ?? ''}
                disabled={selectedClientId === null || isLoading}
                onChange={(e) => {
                  // A late history response must not move a project selection
                  // to another client after the user has started choosing.
                  setClientChosen(true)
                  setClientId(selectedClientId)
                  setProjectId(e.target.value ? Number(e.target.value) : null)
                }}
              >
                <option value="">{t('idle.noProject')}</option>
                {availableProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={KEY_INV}
              disabled={isLoading || !activeClients.some((c) => c.id === selectedClientId)}
              onClick={() => {
                if (selectedClientId !== null) onWorkFor(selectedClientId, projectId)
              }}
            >
              {t('idle.book')}
            </button>
            <button type="button" className={KEY} disabled={isLoading} onClick={collapsePicker}>
              {t('idle.back')}
            </button>
          </div>
        )}
      </div>
      <p className="mt-4 text-xs text-[var(--ink3)]">{t('idle.tip')}</p>
    </Dialog>
  )
}
