import { useEffect, useState } from 'react'
import { useT } from '../contexts/I18nContext'
import { Toggle } from './Toggle'
import { FIELD_LABEL, INPUT, KEY, READOUT } from './instrumentClasses'

/**
 * Subscribable iCal feed (#169).
 *
 * The URL contains the token (calendar clients cannot send headers), so it is
 * rendered read-only with a copy button. Regenerating the token invalidates
 * every stored subscription — the button label says so instead of hiding it
 * in a tooltip.
 */
export function IcalFeedSection({
  enabled,
  port,
  onEnabledChange,
  onPortChange
}: {
  enabled: boolean
  port: string
  onEnabledChange: (v: boolean) => void
  onPortChange: (v: string) => void
}): React.JSX.Element {
  const t = useT()
  const [url, setUrl] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!enabled) return
    void window.api.icalFeed.url().then((res) => {
      if (res.ok) setUrl(res.data)
    })
  }, [enabled, port])

  async function onCopy(): Promise<void> {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function onRegenerate(): Promise<void> {
    const res = await window.api.icalFeed.regenerate()
    if (res.ok) setUrl(res.data)
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm" style={{ color: 'var(--ink)' }}>
            {t('settings.icalFeed.enable')}
          </p>
          <p className="text-xs" style={{ color: 'var(--ink3)' }}>
            {t('settings.icalFeed.enableHint')}
          </p>
        </div>
        <Toggle checked={enabled} onChange={onEnabledChange} />
      </div>

      {enabled && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <pre className={`${READOUT} min-w-0 flex-[1_1_16rem] overflow-x-auto`}>{url}</pre>
            <button type="button" onClick={() => void onCopy()} className={KEY}>
              {copied ? t('settings.icalFeed.copied') : t('settings.icalFeed.copy')}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className={FIELD_LABEL}>{t('settings.icalFeed.port')}</label>
            <input
              type="text"
              value={port}
              onChange={(e) => onPortChange(e.target.value)}
              placeholder={t('settings.icalFeed.portPlaceholder')}
              inputMode="numeric"
              className={`${INPUT} font-num w-24`}
            />
            <button type="button" onClick={() => void onRegenerate()} className={KEY}>
              {t('settings.icalFeed.regenerate')}
            </button>
          </div>
          <p className="text-xs" style={{ color: 'var(--ink3)' }}>
            {t('settings.icalFeed.regenerateHint')}
          </p>
        </>
      )}
    </div>
  )
}
