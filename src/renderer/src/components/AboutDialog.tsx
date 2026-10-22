import { useState, useEffect } from 'react'
import { Dialog } from './Dialog'
import { useT } from '../contexts/I18nContext'
import type { LicenseEntry } from '../../../shared/types'

interface Props {
  open: boolean
  onClose: () => void
  version: string
}

const MIT_TEXT = `MIT License

Copyright (c) 2026 skoedr

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

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
              {t('about.version')} {version}
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
            className="text-xs text-[var(--ink)] hover:text-[var(--ink)] underline"
          >
            GitHub
          </a>
        </div>

        {/* Own license */}
        <div className="rounded-[var(--r-key)] border border-[var(--line)] bg-[var(--key)] p-3">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--ink2)]">
            {t('about.ownLicense')}
          </p>
          <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap text-xs text-[var(--ink)]">
            {MIT_TEXT}
          </pre>
        </div>

        {/* Third-party licenses */}
        <div className="rounded-[var(--r-key)] border border-[var(--line)] bg-[var(--key)] p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--ink2)]">
            {t('about.thirdParty')} ({licenses.length})
          </p>

          {loading && <p className="text-xs text-[var(--ink3)]">{t('about.loading')}</p>}

          <div className="max-h-64 overflow-y-auto flex flex-col gap-1">
            {licenses.map((pkg) => (
              <div key={pkg.name} className="rounded-[var(--r-key)] border border-[var(--line)]">
                <button
                  type="button"
                  onClick={() => toggleExpand(pkg.name)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-[var(--key)] rounded-[var(--r-key)]"
                >
                  <span className="text-sm text-[var(--ink)] font-medium">{pkg.name}</span>
                  <span className="flex items-center gap-3">
                    <span className="text-xs text-[var(--ink2)]">{pkg.version}</span>
                    <span className="rounded bg-[var(--key)] px-1.5 py-0.5 text-xs text-[var(--ink)]">
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
                        className="text-left text-xs text-[var(--ink)] hover:text-[var(--ink)] underline truncate"
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
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--r-key)] border border-[var(--key-edge)] bg-[var(--key)] px-4 py-2 text-sm font-medium text-[var(--ink)] key-hover focus:outline-none focus:ring-2 focus:ring-[var(--focus)]"
          >
            {t('about.close')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
