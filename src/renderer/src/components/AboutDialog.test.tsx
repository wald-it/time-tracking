/**
 * The About dialog's own licence text is the repo's LICENSE file, not a
 * second copy that can drift from it (#276: the copy said "skoedr" while
 * LICENSE said "Robin Wald").
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { AboutDialog } from './AboutDialog'
import { I18nProvider } from '../contexts/I18nContext'

const LICENSE = readFileSync(join(__dirname, '..', '..', '..', '..', 'LICENSE'), 'utf8')

beforeEach(() => {
  vi.stubGlobal('api', {
    app: { getLicenses: vi.fn().mockResolvedValue({ ok: true, data: [] }) },
    shell: { openExternal: vi.fn() }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AboutDialog', () => {
  it('shows the text of LICENSE as its own licence, character for character', () => {
    render(
      <I18nProvider>
        <AboutDialog open onClose={() => {}} version="0.0.0" />
      </I18nProvider>
    )
    // The third-party licences are collapsed, so the only <pre> is our own.
    const pre = document.querySelectorAll('pre')
    expect(pre).toHaveLength(1)
    expect(pre[0].textContent).toBe(LICENSE)
  })
})
