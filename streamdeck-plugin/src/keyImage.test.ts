import { describe, expect, it } from 'vitest'
import { DISP, SIG, keyImage, type KeyLabel } from './keyImage'

const LABEL: KeyLabel = { header: 'Acme', lines: ['Rollout'] }

function svgOf(opts: Parameters<typeof keyImage>[0]): string {
  const url = keyImage(opts)
  return decodeURIComponent(url.slice('data:image/svg+xml,'.length))
}

/** The text a viewer reads: tags (incl. the colon's <tspan>) removed. */
function visible(svg: string): string {
  return svg.replace(/<[^>]+>/g, '')
}

describe('keyImage (Messinstrument, #363)', () => {
  it('every face is one static frame on the display colour', () => {
    for (const state of ['idle', 'running', 'unset'] as const) {
      const svg = svgOf({ state, label: LABEL, color: '#ff8800', elapsedSec: 90 })
      expect(svg).toContain(`fill="${DISP}"`)
      expect(svg).not.toContain('<animate')
      expect(svg).not.toContain('pathLength')
      expect(svg).not.toContain('Gradient')
    }
  })

  it('orange appears only while running', () => {
    expect(svgOf({ state: 'running', label: LABEL, elapsedSec: 0 })).toContain(SIG)
    expect(svgOf({ state: 'idle', label: LABEL, color: '#ff8800' })).not.toContain(SIG)
    expect(svgOf({ state: 'unset', label: LABEL })).not.toContain(SIG)
    expect(svgOf({ state: 'offline', label: LABEL })).not.toContain(SIG)
  })

  it('running shows h:mm, the client as a legend and the project', () => {
    const svg = svgOf({ state: 'running', label: LABEL, elapsedSec: 3 * 3600 + 7 * 60 + 5 })
    expect(visible(svg)).toContain('3:07')
    expect(svg).toContain('>Acme<')
    expect(svg).toContain('>Rollout<')
  })

  it('the running square blinks with the 1 Hz tick', () => {
    const op = (sec: number): string | undefined =>
      new RegExp(`fill="${SIG}" opacity="([\\d.]+)"`).exec(
        svgOf({ state: 'running', label: LABEL, elapsedSec: sec })
      )?.[1]
    expect(op(0)).toBe('1')
    expect(op(1)).toBe('0.35')
    expect(op(2)).toBe('1')
  })

  it('the client colour is a bar, and a missing colour gets a neutral one', () => {
    const bar = (color?: string): string | undefined =>
      /<rect x="16" y="126" width="112" height="4" fill="(#[0-9a-f]{6})"\/>/.exec(
        svgOf({ state: 'idle', label: LABEL, color })
      )?.[1]
    expect(bar('#ff8800')).toMatch(/^#[0-9a-f]{6}$/)
    expect(bar(undefined)).toBe('#3a3935')
    expect(bar('not-a-colour')).toBe('#3a3935')
  })

  it('escapes names', () => {
    const svg = svgOf({ state: 'idle', label: { header: '', lines: ['A & <B>'] } })
    expect(svg).toContain('A &amp; &lt;B&gt;')
  })
})

describe('keyImage name fitting (Codex on #364)', () => {
  it('keeps all three wrapped lines of a client-only name', () => {
    const svg = svgOf({
      state: 'idle',
      label: { header: '', lines: ['Acme', 'Consulting', 'North'] }
    })
    expect(svg).toContain('>North<')
  })

  it('cuts a long client legend so it stays on the key', () => {
    const svg = svgOf({
      state: 'idle',
      label: { header: 'Consulting GmbH', lines: ['Rollout'] }
    })
    const legendText = />([^<]*)<\/text>/.exec(svg)?.[1] ?? ''
    expect(legendText.length).toBeLessThanOrEqual(10)
    expect(legendText.endsWith('…')).toBe(true)
  })
})
