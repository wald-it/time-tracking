import { useCallback, useEffect, useId, useState } from 'react'
import { useT } from '../contexts/I18nContext'
import { Toggle } from './Toggle'
import { FIELD_LABEL, FOCUS, INPUT_FRAME, KEY, KEY_INV } from './instrumentClasses'
import type { AccountStatus } from '../../../main/graphAccount'
import { hasScope, PRESENCE_SCOPE } from '../../../shared/graphAuth'

/**
 * "Connect a Microsoft account" (#130).
 *
 * Nothing here decides anything — the main process owns the flow and this only
 * renders its outcome. Two behaviours are worth stating because they are easy
 * to get wrong in a settings pane:
 *
 * - The connect button stays busy for as long as the browser is open, and the
 *   cancel next to it really aborts the sign-in (it tears down the loopback
 *   listener in main). A spinner that cannot be stopped would strand the user
 *   whenever they close the browser tab instead of finishing.
 * - The personal-account hint exists because Teams presence (#132) is not
 *   available for those accounts at all. Better to say so where the account is
 *   shown than to offer something later that cannot work.
 */
export function GraphAccountSection(): React.JSX.Element {
  const t = useT()
  const labelId = useId()
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientId, setClientId] = useState('')
  const [clientIdSaved, setClientIdSaved] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null)
  const [presenceEnabled, setPresenceEnabled] = useState(false)
  const [presenceShowClient, setPresenceShowClient] = useState(false)

  const refresh = useCallback(async () => {
    const res = await window.api.graph.status()
    if (res.ok) setStatus(res.data)
    else setError(res.error)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- #130: dauerhaft — asynchroner IPC-Abruf des Verbindungsstatus beim Mount, kein dedizierter Store
    void refresh()
    void window.api.settings.getAll().then((res) => {
      if (res.ok) {
        setClientId(res.data.graph_client_id ?? '')
        setPresenceEnabled(res.data.presence_enabled === '1')
        setPresenceShowClient(res.data.presence_show_client === '1')
      }
    })
  }, [refresh])

  async function onPresenceEnabled(v: boolean): Promise<void> {
    setPresenceEnabled(v)
    await window.api.settings.set('presence_enabled', v ? '1' : '0')
  }

  async function onPresenceShowClient(v: boolean): Promise<void> {
    setPresenceShowClient(v)
    await window.api.settings.set('presence_show_client', v ? '1' : '0')
  }

  async function onConnect(): Promise<void> {
    setBusy(true)
    setError(null)
    const res = await window.api.graph.connect()
    setBusy(false)
    if (res.ok) setStatus(res.data)
    else setError(res.error)
  }

  async function onCancel(): Promise<void> {
    await window.api.graph.cancelConnect()
    // The pending connect() settles on its own with a cancellation error; this
    // just stops the browser-side wait from looking like it is still running.
    setBusy(false)
  }

  async function onVerify(): Promise<void> {
    setVerifying(true)
    setError(null)
    setVerifyMsg(null)
    const res = await window.api.graph.verify()
    setVerifying(false)
    if (!res.ok) {
      setError(res.error)
      // A rejected grant means the main process already dropped the connection;
      // re-reading the status is what turns the pane back to "not connected".
      await refresh()
      return
    }
    const who = res.data.mail ?? res.data.displayName ?? ''
    setVerifyMsg(
      res.data.refreshed
        ? t('settings.graph.verifyOkRefreshed', { who })
        : t('settings.graph.verifyOk', { who })
    )
  }

  async function onDisconnect(): Promise<void> {
    setError(null)
    setVerifyMsg(null)
    const res = await window.api.graph.disconnect()
    if (res.ok) setStatus(res.data)
    else setError(res.error)
  }

  async function onSaveClientId(): Promise<void> {
    const res = await window.api.settings.set('graph_client_id', clientId.trim())
    // A new app id asks natively first (#272); declined, nothing was saved,
    // so the field shows the stored id again.
    if (!res.ok) {
      if (res.code !== 'cancelled') {
        // A failure keeps what the user typed, so they can try again.
        setError(res.error)
        return
      }
      const stored = await window.api.settings.getAll()
      if (stored.ok) setClientId(stored.data.graph_client_id ?? '')
      return
    }
    setClientIdSaved(true)
    await refresh()
  }

  const connected = status?.connected === true
  const storageMissing = status !== null && !status.storageAvailable

  return (
    // Padding belongs here, not in `Section`: that wrapper is a bare card and
    // every existing child supplies its own insets via `Row` (px-[18px]/py-[13px]).
    // Without them the content sits flush against the border and the first
    // character of each line is clipped.
    <div className="flex min-w-0 flex-col gap-3 py-3">
      <p className="text-xs" style={{ color: 'var(--ink3)' }}>
        {t('settings.graph.desc')}
      </p>

      {storageMissing && (
        <p className="text-xs text-[var(--ink)]">{t('settings.graph.storageUnavailable')}</p>
      )}

      {connected ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex w-fit items-center rounded-[var(--r-fine)] border border-[var(--ink3)] px-2 py-0.5 ${FIELD_LABEL}`}
            >
              {t('settings.graph.connected')}
            </span>
            <span className="text-sm" style={{ color: 'var(--ink)' }}>
              {status?.account?.displayName ?? status?.account?.username ?? ''}
            </span>
            {status?.account?.username && status.account.displayName && (
              <span className="text-xs" style={{ color: 'var(--ink3)' }}>
                {status.account.username}
              </span>
            )}
          </div>

          {status?.personalAccount && (
            <p className="text-xs" style={{ color: 'var(--ink3)' }}>
              {t('settings.graph.personalAccountNote')}
            </p>
          )}

          {/* Teams presence mirroring (#132) — work/school accounts only. */}
          {!status?.personalAccount && (
            <div className="flex flex-col gap-2 border-y border-[var(--line)] py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p id={`${labelId}-presence`} className="text-sm" style={{ color: 'var(--ink)' }}>
                    {t('settings.presence.enable')}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--ink3)' }}>
                    {t('settings.presence.enableHint')}
                  </p>
                </div>
                <Toggle
                  checked={presenceEnabled}
                  onChange={(v) => void onPresenceEnabled(v)}
                  labelledBy={`${labelId}-presence`}
                />
              </div>
              {presenceEnabled && (
                <>
                  {!hasScope(status?.grantedScopes ?? [], PRESENCE_SCOPE) && (
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-xs text-[var(--ink)]">
                        {t('settings.presence.reconnectHint')}
                      </p>
                      <button
                        type="button"
                        onClick={() => void onConnect()}
                        disabled={busy}
                        className={KEY}
                      >
                        {busy ? t('settings.graph.connecting') : t('settings.presence.reconnect')}
                      </button>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p
                        id={`${labelId}-showClient`}
                        className="text-sm"
                        style={{ color: 'var(--ink)' }}
                      >
                        {t('settings.presence.showClient')}
                      </p>
                      <p className="text-xs" style={{ color: 'var(--ink3)' }}>
                        {t('settings.presence.showClientHint')}
                      </p>
                    </div>
                    <Toggle
                      checked={presenceShowClient}
                      onChange={(v) => void onPresenceShowClient(v)}
                      labelledBy={`${labelId}-showClient`}
                    />
                  </div>
                </>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void onVerify()}
              disabled={verifying}
              className={KEY}
            >
              {verifying ? t('settings.graph.verifying') : t('settings.graph.verify')}
            </button>
            <button type="button" onClick={() => void onDisconnect()} className={KEY}>
              {t('settings.graph.disconnect')}
            </button>
          </div>

          {verifyMsg && (
            <p className="text-xs" style={{ color: 'var(--ink2)' }}>
              {verifyMsg}
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void onConnect()}
            disabled={busy || storageMissing}
            className={KEY_INV}
          >
            {busy ? t('settings.graph.connecting') : t('settings.graph.connect')}
          </button>
          {busy && (
            <>
              <span className="text-xs" style={{ color: 'var(--ink3)' }}>
                {t('settings.graph.browserHint')}
              </span>
              <button type="button" onClick={() => void onCancel()} className={KEY}>
                {t('settings.graph.cancel')}
              </button>
            </>
          )}
        </div>
      )}

      {error && (
        <p className="text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      {/* Escape hatch for tenants that block third-party apps, and for anyone
          who would rather use their own registration. */}
      <details className="mt-1">
        <summary
          className={`flex min-h-11 cursor-pointer items-center text-xs ${FOCUS}`}
          style={{ color: 'var(--ink3)' }}
        >
          {t('settings.graph.advanced')}
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-xs" style={{ color: 'var(--ink3)' }}>
            {t('settings.graph.clientIdHint')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={clientId}
              onChange={(e) => {
                setClientId(e.target.value)
                setClientIdSaved(false)
              }}
              placeholder={t('settings.graph.clientIdPlaceholder')}
              spellCheck={false}
              // `min-w-0` so a long GUID shrinks instead of pushing the Save
              // button out of the card in a narrow settings pane.
              className={`${INPUT_FRAME} font-num min-w-0 flex-1 text-xs`}
            />
            <button type="button" onClick={() => void onSaveClientId()} className={KEY}>
              {t('common.save')}
            </button>
            {clientIdSaved && (
              <span className="text-xs" style={{ color: 'var(--ink2)' }}>
                {t('settings.graph.clientIdSaved')}
              </span>
            )}
          </div>
        </div>
      </details>
    </div>
  )
}
