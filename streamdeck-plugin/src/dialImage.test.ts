/**
 * Tests for the touch-strip faces (#186).
 *
 * The device rasterizes what it gets and reports nothing back, so the checks
 * here are the ones that would otherwise only fail silently on the hardware:
 * the layout contract, well-formed SVG, and that every value the face draws
 * actually reaches the image.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dialImage, fit, wrapTwo, FEEDBACK_KEY, type DialFace } from './dialImage'

const LABEL = { client: 'Acme', project: 'Rollout' }

/** The text a viewer reads: tags (incl. the colon's <tspan>) removed. */
function visible(svg: string): string {
  return svg.replace(/<[^>]+>/g, '')
}

function svgOf(face: DialFace): string {
  const url = dialImage(face)
  expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true)
  return Buffer.from(url.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')
}

describe('layout contract', () => {
  it('the key setFeedback writes is declared in layouts/dial.json', () => {
    const layout = JSON.parse(
      readFileSync(
        join(__dirname, '..', 'com.timetrack.streamdeck.sdPlugin', 'layouts', 'dial.json'),
        'utf8'
      )
    ) as { items: Array<{ key: string; type: string; rect: number[] }> }
    const item = layout.items.find((i) => i.key === FEEDBACK_KEY)
    // A key the layout does not know is dropped in silence — on the device
    // that looks exactly like a broken plugin.
    expect(item, `layout has no item "${FEEDBACK_KEY}"`).toBeDefined()
    expect(item?.type).toBe('pixmap')
    // Full-bleed: the faces are drawn for exactly this canvas.
    expect(item?.rect).toEqual([0, 0, 200, 100])
  })
})

describe('dialImage', () => {
  const faces: DialFace[] = [
    { state: 'offline' },
    { state: 'empty' },
    {
      state: 'stats',
      todaySeconds: 3600,
      weekSeconds: 7200,
      label: LABEL,
      position: '1/4',
      color: '#ff8800'
    },
    {
      state: 'browse',
      label: LABEL,
      position: '2/4',
      progress: 0.5,
      color: '#ff8800',
      running: false
    },
    { state: 'running', label: LABEL, elapsedSec: 125, color: '#ff8800' }
  ]

  it('every face is a 200x100 SVG', () => {
    for (const face of faces) {
      const svg = svgOf(face)
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"')).toBe(
        true
      )
      expect(svg.endsWith('</svg>')).toBe(true)
    }
  })

  it('uses no SVG feature the deck ignores (SMIL, pathLength)', () => {
    for (const face of faces) {
      const svg = svgOf(face)
      expect(svg).not.toContain('<animate')
      expect(svg).not.toContain('pathLength')
    }
  })

  it('stats face shows both totals, the selection and the position', () => {
    const svg = svgOf({
      state: 'stats',
      todaySeconds: 3 * 3600 + 25 * 60,
      weekSeconds: 21 * 3600,
      label: LABEL,
      position: '2/17',
      color: '#ff8800'
    })
    expect(svg).toContain('>TODAY<')
    expect(svg).toContain('>WEEK<')
    // Readouts dim the colon in a <tspan> (#363): compare the visible text.
    expect(visible(svg)).toContain('3:25')
    expect(visible(svg)).toContain('21:00')
    expect(svg).toContain('Acme · Rollout')
    expect(svg).toContain('>2/17<')
  })

  it('running face shows client, project and elapsed time', () => {
    const svg = svgOf({ state: 'running', label: LABEL, elapsedSec: 3 * 3600 + 7 * 60, color: '#ff8800' })
    // The client above a project is a legend, set in capitals (#363).
    expect(svg).toContain('>ACME<')
    expect(svg).toContain('>Rollout<')
    expect(visible(svg)).toContain('3:07')
  })

  it('a client-only target shows the client as the main line, without a header', () => {
    const svg = svgOf({
      state: 'running',
      label: { client: 'Beta', project: null },
      elapsedSec: 60,
      color: '#00aa55'
    })
    // Exactly once — as the main line, not additionally as a header.
    expect(svg.match(/>Beta</g)).toHaveLength(1)
  })

  it('the seconds line grows within the minute and stays inside its track', () => {
    const width = (sec: number): number | undefined => {
      const m = /<rect x="14" y="90" width="(\d+)" height="2"/.exec(
        svgOf({ state: 'running', label: LABEL, elapsedSec: sec })
      )
      return m ? Number(m[1]) : undefined
    }
    // Nothing filled at the top of a minute, only the track.
    expect(width(0)).toBeUndefined()
    expect(width(30)).toBe(86)
    expect(width(59) as number).toBeGreaterThan(86)
    // The track is 172 wide; the fill never reaches past it.
    expect(width(59) as number).toBeLessThan(172)
  })

  it('the running square blinks with the tick and returns to its start', () => {
    const opacity = (sec: number): string =>
      /<rect x="14" y="13" width="9" height="9" fill="#e2551f" opacity="([\d.]+)"/.exec(
        svgOf({ state: 'running', label: LABEL, elapsedSec: sec })
      )?.[1] as string
    expect(opacity(0)).toBe('1')
    expect(opacity(1)).toBe('0.35')
    expect(opacity(2)).toBe(opacity(0))
  })

  it('browse face marks a target that is already running', () => {
    const idle = svgOf({
      state: 'browse',
      label: LABEL,
      position: '1/2',
      progress: 0,
      running: false
    })
    const live = svgOf({
      state: 'browse',
      label: LABEL,
      position: '1/2',
      progress: 0,
      running: true
    })
    // Orange means "running" and nothing else (Messinstrument, #363).
    expect(idle).not.toContain('#e2551f')
    expect(live).toContain('#e2551f')
  })

  it('browse position bar grows with the progress and never leaves the track', () => {
    // The filled bar is the rect whose fill has no opacity — the one below it
    // is the track (fill-opacity 0.10) and is always the full width.
    const width = (progress: number): number =>
      Number(
        /<rect x="16" y="88" width="(\d+)" height="4" rx="2" fill="#[0-9a-f]{6}"\/>/.exec(
          svgOf({ state: 'browse', label: LABEL, position: 'x', progress, running: false })
        )?.[1]
      )
    expect(width(0)).toBeLessThanOrEqual(8)
    expect(width(1)).toBe(168)
    expect(width(0.5)).toBe(84)
    // Out-of-range values are clamped, not drawn past the track.
    expect(width(4)).toBe(168)
    expect(width(-1)).toBeLessThanOrEqual(8)
  })

  it('escapes names that would otherwise break the XML', () => {
    const svg = svgOf({
      state: 'browse',
      label: { client: 'A & B', project: '<script>' },
      position: '1/1',
      progress: 1,
      running: false
    })
    expect(svg).toContain('A &amp; B')
    expect(svg).toContain('&lt;script&gt;')
    expect(svg).not.toContain('<script>')
  })

  it('offline face names the switch the user has to flip', () => {
    const svg = svgOf({ state: 'offline' })
    expect(svg).toContain('TimeTrack offline')
    expect(svg).toContain('Settings')
  })
})

describe('text fitting', () => {
  it('fit truncates with an ellipsis, short strings untouched', () => {
    expect(fit('Rollout', 10)).toBe('Rollout')
    expect(fit('Rollout Phase Two', 10)).toBe('Rollout P…')
    expect(fit('Rollout Phase Two', 10).length).toBe(10)
  })

  it('wrapTwo breaks at a space and keeps at most two lines', () => {
    expect(wrapTwo('Rollout', 17)).toEqual(['Rollout'])
    expect(wrapTwo('Rollout Phase Two', 12)).toEqual(['Rollout', 'Phase Two'])
    const many = wrapTwo('one two three four five six seven', 10)
    expect(many).toHaveLength(2)
    for (const line of many) expect(line.length).toBeLessThanOrEqual(10)
  })

  it('a single unbreakable word is truncated rather than dropped', () => {
    expect(wrapTwo('Donaudampfschifffahrtsgesellschaft', 12)).toEqual(['Donaudampfs…'])
  })
})
