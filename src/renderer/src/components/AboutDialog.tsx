import { useState, useEffect } from 'react'
import { Dialog } from './Dialog'
import { useT } from '../contexts/I18nContext'
import type { LicenseEntry } from '../../../shared/types'
import { FOCUS, KEY, LEGEND, SECTION } from './instrumentClasses'
// The repo's LICENSE, inlined at build time. One source: an inline copy here
// had drifted from it (#276).
import LICENSE_TEXT from '../../../../LICENSE?raw'

interface Props {
  open: boolean
  onClose: () => void
  version: string
}

export function AboutDialog({ open, onClose, version }: Props): React.JSX.Element | null {
  const t = useT()
  const [licenses, setLicenses] = useState<LicenseEntry[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || licenses.length > 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- #142: dauerhaft — asynchroner IPC-Abruf der Lizenzliste
    setLoading(true)
    void window.api.app.getLicenses().then((res) => {
      if (res.ok) setLicenses(res.data)
      setLoading(false)
    })
  }, [open, licenses.length])

  function toggleExpand(name: string): void {
    setExpanded((prev) => (prev === name ? null : name))
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('about.title')} widthClass="w-[600px]">
      {/* App info */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-lg font-semibold text-[var(--ink)]">TimeTrack</p>
            <p className="text-sm text-[var(--ink2)]">
              {t('about.version')} <span className="font-num">{version}</span>
            </p>
          </div>
          <a
            href="https://github.com/wald-it/time-tracking"
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault()
              void window.api.shell.openExternal('https://github.com/wald-it/time-tracking')
            }}
            className={`inline-flex min-h-11 items-center rounded-[var(--r-key)] px-2 text-xs text-[var(--ink)] underline ${FOCUS}`}
          >
            GitHub
          </a>
        </div>

        {/* Own license */}
        <div className={SECTION}>
          <p className={`mb-1.5 ${LEGEND}`}>{t('about.ownLicense')}</p>
          <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap text-xs text-[var(--ink)]">
            {LICENSE_TEXT}
          </pre>
        </div>

        {/* Third-party licenses */}
        <div className={SECTION}>
          <p className={`mb-2 ${LEGEND}`}>
            {t('about.thirdParty')} (<span className="font-num">{licenses.length}</span>)
          </p>

          {loading && <p className="text-xs text-[var(--ink3)]">{t('about.loading')}</p>}

          <div className="max-h-64 overflow-y-auto flex flex-col">
            {licenses.map((pkg) => (
              <div key={pkg.name} className="border-b border-[var(--line)] last:border-b-0">
                <button
                  type="button"
                  onClick={() => toggleExpand(pkg.name)}
                  aria-expanded={expanded === pkg.name}
                  className={`flex min-h-11 w-full items-center justify-between rounded-[var(--r-key)] px-3 text-left hover:bg-[var(--key)] ${FOCUS}`}
                >
                  <span className="text-sm text-[var(--ink)] font-medium">{pkg.name}</span>
                  <span className="flex items-center gap-3">
                    <span className="font-num text-xs text-[var(--ink2)]">{pkg.version}</span>
                    <span className="rounded-[var(--r-fine)] border border-[var(--line)] px-1.5 py-0.5 text-xs text-[var(--ink)]">
                      {pkg.license}
                    </span>
                    <span className="text-xs text-[var(--ink3)]">
                      {expanded === pkg.name ? '▲' : '▼'}
                    </span>
                  </span>
                </button>

                {expanded === pkg.name && (
                  <div className="border-t border-[var(--line)] px-3 py-2 flex flex-col gap-2">
                    {pkg.repository && (
                      <button
                        type="button"
                        onClick={() => void window.api.shell.openExternal(pkg.repository!)}
                        className={`truncate rounded-[var(--r-fine)] text-left text-xs text-[var(--ink)] underline ${FOCUS}`}
                      >
                        {pkg.repository}
                      </button>
                    )}
                    {pkg.licenseText ? (
                      <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs text-[var(--ink2)]">
                        {pkg.licenseText}
                      </pre>
                    ) : (
                      <p className="text-xs text-[var(--ink3)]">{t('about.noLicenseText')}</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Close button */}
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className={KEY}>
            {t('about.close')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
